/**
 * AWS resource verification test.
 *
 * Deploys via our package, then uses AWS CLI to independently verify
 * every resource was created correctly. No trust in our own code —
 * verify with AWS directly.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { deploy, destroy } from "../../src/deploy.js";

const REGION = "us-east-1";
const FUNCTION_NAME = `stratus-verify-${Date.now()}`;
let deployResult: Awaited<ReturnType<typeof deploy>> | undefined;

async function awsCli(cmd: string): Promise<string> {
	const proc = Bun.spawn(["bash", "-c", cmd], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, AWS_DEFAULT_REGION: REGION },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	if (proc.exitCode !== 0) throw new Error(`AWS CLI failed: ${stderr}`);
	return stdout.trim();
}

afterAll(async () => {
	// Clean up everything
	try {
		await destroy(FUNCTION_NAME, REGION);
	} catch {}
	try {
		await awsCli(
			`aws iam detach-role-policy --role-name ${FUNCTION_NAME}-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
		);
	} catch {}
	try {
		await awsCli(`aws iam delete-role --role-name ${FUNCTION_NAME}-role`);
	} catch {}
});

describe("AWS resource verification", () => {
	// ── Step 1: Deploy ──────────────────────────────────────────────

	test("deploy() completes and returns expected shape", async () => {
		deployResult = await deploy({
			entry: resolve(import.meta.dir, "../../examples/playwright-server.ts"),
			region: REGION,
			functionName: FUNCTION_NAME,
			memory: 512,
			timeout: 15,
			environment: { CUSTOM_VAR: "hello_from_stratus" },
		});

		expect(deployResult.functionName).toBe(FUNCTION_NAME);
		expect(deployResult.functionArn).toContain(FUNCTION_NAME);
		expect(deployResult.url).toContain("lambda-url");
		expect(deployResult.region).toBe(REGION);
		console.log(`Deployed: ${deployResult.url}`);
	}, 120000);

	// ── Step 2: Verify Lambda function via AWS CLI ──────────────────

	test("Lambda function exists with correct config", async () => {
		const raw = await awsCli(
			`aws lambda get-function-configuration --function-name ${FUNCTION_NAME} --output json`,
		);
		const config = JSON.parse(raw);

		expect(config.FunctionName).toBe(FUNCTION_NAME);
		expect(config.Runtime).toBe("nodejs22.x");
		expect(config.Handler).toBe("index.handler");
		expect(config.MemorySize).toBe(512);
		expect(config.Timeout).toBe(15);
		expect(config.Architectures).toContain("arm64");
		expect(config.PackageType).toBe("Zip");
		expect(config.State).toBe("Active");

		console.log(`  Runtime: ${config.Runtime}`);
		console.log(`  Memory: ${config.MemorySize}MB`);
		console.log(`  Timeout: ${config.Timeout}s`);
		console.log(`  Arch: ${config.Architectures.join(", ")}`);
	});

	test("Lambda environment variables set correctly", async () => {
		const raw = await awsCli(
			`aws lambda get-function-configuration --function-name ${FUNCTION_NAME} --output json`,
		);
		const config = JSON.parse(raw);
		const envVars = config.Environment?.Variables ?? {};

		expect(envVars.NODE_OPTIONS).toBe("--experimental-vm-modules");
		expect(envVars.CUSTOM_VAR).toBe("hello_from_stratus");

		console.log(`  NODE_OPTIONS: ${envVars.NODE_OPTIONS}`);
		console.log(`  CUSTOM_VAR: ${envVars.CUSTOM_VAR}`);
	});

	// ── Step 3: Verify IAM role via AWS CLI ─────────────────────────

	test("IAM role exists with correct trust policy", async () => {
		const raw = await awsCli(`aws iam get-role --role-name ${FUNCTION_NAME}-role --output json`);
		const role = JSON.parse(raw).Role;

		expect(role.RoleName).toBe(`${FUNCTION_NAME}-role`);

		// AWS CLI --output json returns the policy as an object, not URL-encoded string
		const trustPolicy = typeof role.AssumeRolePolicyDocument === "string"
			? JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument))
			: role.AssumeRolePolicyDocument;
		const statement = trustPolicy.Statement[0];
		expect(statement.Effect).toBe("Allow");
		expect(statement.Principal.Service).toBe("lambda.amazonaws.com");
		expect(statement.Action).toBe("sts:AssumeRole");

		console.log(`  Role: ${role.RoleName}`);
		console.log(`  ARN: ${role.Arn}`);
	});

	test("IAM role has BasicExecution policy attached", async () => {
		const raw = await awsCli(
			`aws iam list-attached-role-policies --role-name ${FUNCTION_NAME}-role --output json`,
		);
		const policies = JSON.parse(raw).AttachedPolicies;
		const policyArns = policies.map((p: { PolicyArn: string }) => p.PolicyArn);

		expect(policyArns).toContain(
			"arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
		);

		console.log(`  Policies: ${policyArns.join(", ")}`);
	});

	// ── Step 4: Verify Function URL via AWS CLI ─────────────────────

	test("Function URL exists with NONE auth", async () => {
		const raw = await awsCli(
			`aws lambda get-function-url-config --function-name ${FUNCTION_NAME} --output json`,
		);
		const urlConfig = JSON.parse(raw);

		expect(urlConfig.AuthType).toBe("NONE");
		expect(urlConfig.InvokeMode).toBe("BUFFERED");
		expect(urlConfig.FunctionUrl).toContain("lambda-url");
		expect(urlConfig.FunctionUrl).toBe(deployResult?.url);

		console.log(`  URL: ${urlConfig.FunctionUrl}`);
		console.log(`  AuthType: ${urlConfig.AuthType}`);
		console.log(`  InvokeMode: ${urlConfig.InvokeMode}`);
	});

	test("Function URL resource policy allows public access", async () => {
		const raw = await awsCli(
			`aws lambda get-policy --function-name ${FUNCTION_NAME} --output json`,
		);
		const policyDoc = JSON.parse(JSON.parse(raw).Policy);
		const statements = policyDoc.Statement;

		// Should have both required statements for NONE auth
		const sids = statements.map((s: { Sid: string }) => s.Sid);
		expect(sids).toContain("FunctionURLAllowPublicAccess");
		expect(sids).toContain("FunctionURLInvokeAllowPublicAccess");

		// Verify the InvokeFunctionUrl permission
		const urlStatement = statements.find(
			(s: { Sid: string }) => s.Sid === "FunctionURLAllowPublicAccess",
		);
		expect(urlStatement.Effect).toBe("Allow");
		expect(urlStatement.Principal).toBe("*");
		expect(urlStatement.Action).toBe("lambda:InvokeFunctionUrl");

		// Verify the InvokeFunction permission
		const invokeStatement = statements.find(
			(s: { Sid: string }) => s.Sid === "FunctionURLInvokeAllowPublicAccess",
		);
		expect(invokeStatement.Effect).toBe("Allow");
		expect(invokeStatement.Action).toBe("lambda:InvokeFunction");

		console.log(`  Policy statements: ${sids.join(", ")}`);
	});

	// ── Step 5: Verify the Lambda code is correct ───────────────────

	test("Lambda code is ESM with handler export", async () => {
		// Invoke the function directly to verify the code works
		const payload = JSON.stringify({
			headers: { "content-type": "application/json", "x-api-key": "demo-key" },
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "aws-verify", version: "1.0" },
				},
			}),
		});

		// Write payload to temp file for AWS CLI
		const payloadPath = `/tmp/stratus-verify-payload-${Date.now()}.json`;
		const outputPath = `/tmp/stratus-verify-output-${Date.now()}.json`;
		await Bun.write(payloadPath, payload);

		const raw = await awsCli(
			`aws lambda invoke --function-name ${FUNCTION_NAME} --cli-binary-format raw-in-base64-out --payload file://${payloadPath} ${outputPath}`,
		);
		const invokeResult = JSON.parse(raw);
		expect(invokeResult.StatusCode).toBe(200);
		expect(invokeResult.FunctionError).toBeUndefined();

		const output = JSON.parse(await Bun.file(outputPath).text());
		expect(output.statusCode).toBe(200);

		const body = JSON.parse(output.body);
		expect(body.result.serverInfo.name).toBe("playwright-mcp");
		expect(body.result.serverInfo.version).toBe("1.0.0");

		console.log(`  Lambda invoke: ${invokeResult.StatusCode}`);
		console.log(`  Server: ${body.result.serverInfo.name}@${body.result.serverInfo.version}`);

		// Cleanup temp files
		const { unlinkSync } = await import("node:fs");
		try {
			unlinkSync(payloadPath);
		} catch {}
		try {
			unlinkSync(outputPath);
		} catch {}
	});

	// ── Step 6: Verify Function URL actually works over HTTP ────────

	test("Function URL serves MCP protocol over HTTPS", async () => {
		expect(deployResult?.url).toBeDefined();

		// Retry for cold start
		let response: Response | undefined;
		for (let i = 0; i < 15; i++) {
			response = await fetch(deployResult!.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"x-api-key": "demo-key",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			});
			if (response.status === 200) break;
			await Bun.sleep(2000);
		}

		expect(response!.status).toBe(200);
		const data = await response!.json();
		const tools = data.result.tools.map((t: { name: string }) => t.name);

		expect(tools).toContain("browser_navigate");
		expect(tools).toContain("browser_snapshot");
		expect(tools).toContain("search_tools");

		console.log(`  HTTPS tools/list: ${tools.join(", ")}`);
	}, 60000);

	// ── Step 7: Destroy and verify cleanup ──────────────────────────

	test("destroy() removes the Lambda function", async () => {
		const result = await destroy(FUNCTION_NAME, REGION);
		expect(result.deleted).toBe(true);

		// Verify via AWS CLI that function is gone
		try {
			await awsCli(`aws lambda get-function --function-name ${FUNCTION_NAME}`);
			// Should have thrown
			expect(true).toBe(false);
		} catch (err) {
			expect(String(err)).toContain("ResourceNotFoundException");
		}

		console.log("  Lambda deleted, verified via AWS CLI");
	});
});
