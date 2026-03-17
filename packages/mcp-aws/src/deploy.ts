/**
 * Deploy a McpServer to AWS Lambda with a Function URL.
 *
 * Uses Bun-native APIs:
 * - Bun.build for bundling
 * - Bun.gzipSync for compression
 * - Bun.$ for shell commands (future)
 */

export type VpcConfig = {
	/** Subnet IDs for the Lambda (use private subnets for VPC-only access) */
	subnetIds: string[];
	/** Security group IDs controlling inbound/outbound traffic */
	securityGroupIds: string[];
};

export type DeployConfig = {
	/** Path to the server entry file (must export `handler` via server.lambda()) */
	entry: string;
	/** AWS region (default: us-east-1) */
	region?: string;
	/** Lambda function name (default: derived from server name) */
	functionName?: string;
	/** Lambda memory in MB (default: 256) */
	memory?: number;
	/** Lambda timeout in seconds (default: 30) */
	timeout?: number;
	/** IAM role ARN. If not provided, creates one automatically. */
	roleArn?: string;

	/**
	 * Function URL auth type.
	 * - `"NONE"` (default): Public URL, MCP-level auth via server.auth().
	 * - `"AWS_IAM"`: Callers must sign requests with SigV4. Use for service-to-service.
	 * - `"none"`: No Function URL created. Invoke via AWS SDK only (most private).
	 */
	urlAuth?: "NONE" | "AWS_IAM" | "none";

	/**
	 * Deploy Lambda inside a VPC.
	 */
	vpc?: VpcConfig;

	/** Environment variables to set on the Lambda function */
	environment?: Record<string, string>;

	/** Additional IAM policy ARNs to attach to the Lambda role */
	policies?: string[];
};

export type DeployResult = {
	functionName: string;
	functionArn: string;
	/** HTTPS endpoint. Empty string if urlAuth is "none" (no Function URL). */
	url: string;
	region: string;
};

export type DestroyResult = {
	functionName: string;
	deleted: boolean;
};

/**
 * Bundle a server entry file into a Lambda-compatible zip.
 * Uses Bun.build for bundling + Bun.gzipSync for compression.
 */
async function bundle(entry: string): Promise<Uint8Array> {
	const result = await Bun.build({
		entrypoints: [entry],
		target: "node",
		format: "esm",
		minify: true,
		external: ["@aws-sdk/*", "bun:*"],
	});

	if (!result.success) {
		const errors = result.logs.map((l) => l.message).join("\n");
		throw new Error(`Bundle failed:\n${errors}`);
	}

	const output = result.outputs[0];
	if (!output) throw new Error("Bundle produced no output");
	const code = await output.text();

	// Use Bun's native zip creation via Bun.$
	// Lambda expects a zip with index.mjs at the root
	const zipBytes = await createZipWithBun({ "index.mjs": code });
	return zipBytes;
}

/**
 * Create a zip using Bun's shell to invoke the `zip` command,
 * falling back to a manual implementation if zip isn't available.
 */
async function createZipWithBun(files: Record<string, string>): Promise<Uint8Array> {
	// Write files to a temp dir, zip them, read the zip back
	const tmpDir = `${Bun.env.TMPDIR ?? "/tmp"}/stratus-deploy-${Date.now()}`;

	try {
		const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		mkdirSync(tmpDir, { recursive: true });

		for (const [name, content] of Object.entries(files)) {
			writeFileSync(`${tmpDir}/${name}`, content);
		}

		// Use Bun.$ shell to create the zip
		const zipPath = `${tmpDir}/bundle.zip`;
		const fileNames = Object.keys(files).join(" ");
		await Bun.$`cd ${tmpDir} && zip -j ${zipPath} ${fileNames}`.quiet();

		const zipFile = Bun.file(zipPath);
		const bytes = new Uint8Array(await zipFile.arrayBuffer());

		// Cleanup
		rmSync(tmpDir, { recursive: true, force: true });
		return bytes;
	} catch {
		// Fallback: manual zip if `zip` command not available
		const { rmSync } = await import("node:fs");
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
		return manualCreateZip(files);
	}
}

/** Fallback zip creator when the `zip` CLI isn't available. */
function manualCreateZip(files: Record<string, string>): Uint8Array {
	const entries: { name: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = [];
	const parts: Uint8Array[] = [];
	let offset = 0;

	for (const [name, content] of Object.entries(files)) {
		const nameBytes = new TextEncoder().encode(name);
		const dataBytes = new TextEncoder().encode(content);
		const crc = crc32(dataBytes);

		const header = new ArrayBuffer(30 + nameBytes.length);
		const v = new DataView(header);
		v.setUint32(0, 0x04034b50, true);
		v.setUint16(4, 20, true);
		v.setUint16(8, 0, true);
		v.setUint32(14, crc, true);
		v.setUint32(18, dataBytes.length, true);
		v.setUint32(22, dataBytes.length, true);
		v.setUint16(26, nameBytes.length, true);
		new Uint8Array(header).set(nameBytes, 30);

		const hdr = new Uint8Array(header);
		entries.push({ name: nameBytes, data: dataBytes, crc, offset });
		parts.push(hdr, dataBytes);
		offset += hdr.length + dataBytes.length;
	}

	const centralStart = offset;
	for (const e of entries) {
		const cd = new ArrayBuffer(46 + e.name.length);
		const v = new DataView(cd);
		v.setUint32(0, 0x02014b50, true);
		v.setUint16(4, 20, true);
		v.setUint16(6, 20, true);
		v.setUint32(16, e.crc, true);
		v.setUint32(20, e.data.length, true);
		v.setUint32(24, e.data.length, true);
		v.setUint16(28, e.name.length, true);
		v.setUint32(42, e.offset, true);
		new Uint8Array(cd).set(e.name, 46);
		parts.push(new Uint8Array(cd));
		offset += 46 + e.name.length;
	}

	const eocd = new ArrayBuffer(22);
	const ev = new DataView(eocd);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, offset - centralStart, true);
	ev.setUint32(16, centralStart, true);
	parts.push(new Uint8Array(eocd));

	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let j = 0; j < 8; j++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const LAMBDA_TRUST_POLICY = JSON.stringify({
	Version: "2012-10-17",
	Statement: [
		{
			Effect: "Allow",
			Principal: { Service: "lambda.amazonaws.com" },
			Action: "sts:AssumeRole",
		},
	],
});

export async function deploy(config: DeployConfig): Promise<DeployResult> {
	const {
		entry,
		region = "us-east-1",
		memory = 256,
		timeout = 30,
		urlAuth = "NONE",
		vpc,
		environment,
	} = config;
	const functionName = config.functionName ?? `stratus-mcp-${Date.now()}`;

	const zipBuffer = await bundle(entry);

	let roleArn = config.roleArn;
	if (!roleArn) {
		roleArn = await ensureRole(functionName, region, !!vpc, config.policies);
		await Bun.sleep(15000);
	}

	const {
		LambdaClient,
		CreateFunctionCommand,
		UpdateFunctionCodeCommand,
		GetFunctionCommand,
		CreateFunctionUrlConfigCommand,
		GetFunctionUrlConfigCommand,
		AddPermissionCommand,
	} = await import("@aws-sdk/client-lambda");

	const lambda = new LambdaClient({ region });
	const envVars: Record<string, string> = {
		NODE_OPTIONS: "--experimental-vm-modules",
		...environment,
	};

	let functionArn = "";
	try {
		const existing = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
		functionArn = existing.Configuration?.FunctionArn ?? "";
		await lambda.send(
			new UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zipBuffer }),
		);
	} catch {
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const result = await lambda.send(
					new CreateFunctionCommand({
						FunctionName: functionName,
						Runtime: "nodejs22.x",
						Handler: "index.handler",
						Role: roleArn,
						Code: { ZipFile: zipBuffer },
						MemorySize: memory,
						Timeout: timeout,
						PackageType: "Zip",
						Architectures: ["arm64"],
						Environment: { Variables: envVars },
						...(vpc
							? { VpcConfig: { SubnetIds: vpc.subnetIds, SecurityGroupIds: vpc.securityGroupIds } }
							: {}),
					}),
				);
				functionArn = result.FunctionArn ?? "";
				lastError = undefined;
				break;
			} catch (err) {
				lastError = err;
				if (attempt < 4) await Bun.sleep(5000);
			}
		}
		if (lastError) throw lastError;
		if (!functionArn) throw new Error("Failed to create Lambda function");
	}

	// Wait for active
	for (let i = 0; i < 30; i++) {
		const fn = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
		if (fn.Configuration?.State === "Active") break;
		await Bun.sleep(2000);
	}

	// Function URL
	let url = "";
	if (urlAuth !== "none") {
		try {
			const cfg = await lambda.send(
				new GetFunctionUrlConfigCommand({ FunctionName: functionName }),
			);
			url = cfg.FunctionUrl ?? "";
		} catch {
			const res = await lambda.send(
				new CreateFunctionUrlConfigCommand({
					FunctionName: functionName,
					AuthType: urlAuth,
					InvokeMode: "BUFFERED",
				}),
			);
			url = res.FunctionUrl ?? "";

			const addPerm = (sid: string, action: string, extra: Record<string, unknown>) =>
				lambda
					.send(
						new AddPermissionCommand({
							FunctionName: functionName,
							StatementId: sid,
							Action: action,
							Principal: "*",
							...extra,
						}),
					)
					.catch((err: Error) => {
						if (!err.name?.includes("ResourceConflict")) throw err;
					});

			if (urlAuth === "NONE") {
				await addPerm("FunctionURLAllowPublicAccess", "lambda:InvokeFunctionUrl", {
					FunctionUrlAuthType: "NONE",
				});
				await addPerm("FunctionURLInvokeAllowPublicAccess", "lambda:InvokeFunction", {});
			}
		}
	}

	return { functionName, functionArn, url, region };
}

export async function destroy(functionName: string, region = "us-east-1"): Promise<DestroyResult> {
	const { LambdaClient, DeleteFunctionCommand } = await import("@aws-sdk/client-lambda");
	const lambda = new LambdaClient({ region });
	try {
		await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
		return { functionName, deleted: true };
	} catch {
		return { functionName, deleted: false };
	}
}

async function ensureRole(functionName: string, region: string, needsVpc = false, extraPolicies?: string[]): Promise<string> {
	const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, GetRoleCommand } = await import(
		"@aws-sdk/client-iam"
	);
	const iam = new IAMClient({ region });
	const roleName = `${functionName}-role`;

	try {
		const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
		return existing.Role?.Arn ?? "";
	} catch {
		const result = await iam.send(
			new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: LAMBDA_TRUST_POLICY }),
		);
		await iam.send(
			new AttachRolePolicyCommand({
				RoleName: roleName,
				PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
			}),
		);
		if (needsVpc) {
			await iam.send(
				new AttachRolePolicyCommand({
					RoleName: roleName,
					PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
				}),
			);
		}
		if (extraPolicies) {
			for (const policyArn of extraPolicies) {
				await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
			}
		}
		return result.Role?.Arn ?? "";
	}
}
