/**
 * REAL AWS deployment test.
 *
 * This test:
 * 1. Calls server.deploy() to push to Lambda + create a Function URL
 * 2. Hits the live URL with MCP JSON-RPC requests (initialize, tools/list, tools/call)
 * 3. Calls server.destroy() to clean up
 *
 * Requires AWS credentials in the environment.
 * Run with: bun test tests/integration/real-aws-deploy.test.ts --timeout 120000
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { deploy, destroy } from "../../src/deploy.js";

const REGION = "us-east-1";
const FUNCTION_NAME = `stratus-mcp-test-${Date.now()}`;
let deployedUrl: string | undefined;

afterAll(async () => {
	if (FUNCTION_NAME) {
		console.log(`Cleaning up: ${FUNCTION_NAME}`);
		await destroy(FUNCTION_NAME, REGION).catch(() => {});
		// Also clean up the IAM role
		try {
			const { IAMClient, DetachRolePolicyCommand, DeleteRoleCommand } = await import(
				"@aws-sdk/client-iam"
			);
			const iam = new IAMClient({ region: REGION });
			const roleName = `${FUNCTION_NAME}-role`;
			await iam
				.send(
					new DetachRolePolicyCommand({
						RoleName: roleName,
						PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
					}),
				)
				.catch(() => {});
			await iam.send(new DeleteRoleCommand({ RoleName: roleName })).catch(() => {});
		} catch {
			// ignore
		}
	}
});

describe("Real AWS Deploy", () => {
	test("deploy() creates Lambda + Function URL", async () => {
		const entryPath = resolve(import.meta.dir, "../../examples/playwright-server.ts");

		const result = await deploy({
			entry: entryPath,
			region: REGION,
			functionName: FUNCTION_NAME,
			memory: 256,
			timeout: 30,
		});

		expect(result.functionName).toBe(FUNCTION_NAME);
		expect(result.functionArn).toContain(FUNCTION_NAME);
		expect(result.url).toContain("lambda-url");
		expect(result.url).toStartWith("https://");
		expect(result.region).toBe(REGION);

		deployedUrl = result.url;
		console.log(`Deployed to: ${deployedUrl}`);

	}, 120000);

	test("Function URL responds to MCP initialize", async () => {
		expect(deployedUrl).toBeDefined();

		// Retry until Lambda cold start completes
		let response: Response | undefined;
		for (let attempt = 0; attempt < 15; attempt++) {
			response = await fetch(deployedUrl!, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"x-api-key": "demo-key",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "deploy-test", version: "1.0.0" },
					},
				}),
			});
			if (response.status === 200) break;
			console.log(`  Attempt ${attempt + 1}: ${response.status}`);
			await Bun.sleep(2000);
		}

		console.log(`Status: ${response!.status}`);
		const body = await response!.text();
		console.log(`Body: ${body.slice(0, 500)}`);

		expect(response!.status).toBe(200);
		const data = JSON.parse(body);
		expect(data.result.serverInfo.name).toBe("playwright-mcp");
	}, 30000);

	test("Function URL returns tools/list", async () => {
		expect(deployedUrl).toBeDefined();

		const response = await fetch(deployedUrl!, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"x-api-key": "demo-key",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			}),
		});

		expect(response.status).toBe(200);
		const data = JSON.parse(await response.text());
		const names: string[] = data.result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain("browser_navigate");
		expect(names).toContain("search_tools");
		console.log(`Tools available: ${names.join(", ")}`);
	}, 30000);

	test("Function URL executes tools/call", async () => {
		expect(deployedUrl).toBeDefined();

		const response = await fetch(deployedUrl!, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"x-api-key": "demo-key",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "browser_navigate",
					arguments: { url: "https://example.com" },
				},
			}),
		});

		expect(response.status).toBe(200);
		const data = JSON.parse(await response.text());
		const text = data.result.content[0].text;
		const result = JSON.parse(text);
		expect(result.navigated).toBe(true);
		expect(result.url).toBe("https://example.com");
		console.log(`Tool result: ${text}`);
	}, 30000);

	test("Function URL rejects without API key (401)", async () => {
		expect(deployedUrl).toBeDefined();

		const response = await fetch(deployedUrl!, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			}),
		});

		expect(response.status).toBe(401);
	}, 30000);

	test("destroy() removes the Lambda", async () => {
		const result = await destroy(FUNCTION_NAME, REGION);
		expect(result.deleted).toBe(true);
		deployedUrl = undefined;
	}, 15000);
});
