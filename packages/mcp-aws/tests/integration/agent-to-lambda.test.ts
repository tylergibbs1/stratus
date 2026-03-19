/**
 * FULL END-TO-END TEST:
 * 1. Define an MCP server with @usestratus/mcp-aws
 * 2. Deploy it to AWS Lambda via server.deploy()
 * 3. Create a Stratus agent with Azure OpenAI
 * 4. Agent calls tools on the deployed MCP server
 * 5. Verify the agent gets correct results
 * 6. Tear down
 *
 * This test requires:
 * - AWS credentials
 * - Azure OpenAI credentials in .env
 *
 * Run: bun test tests/integration/agent-to-lambda.test.ts --timeout 180000
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { deploy, destroy } from "../../src/deploy.js";

// Stratus SDK imports
import { Agent, run, tool } from "@usestratus/sdk";
import { AzureChatCompletionsModel } from "@usestratus/sdk/azure";
import { z } from "zod";

const REGION = "us-east-1";
const FUNCTION_NAME = `stratus-agent-e2e-${Date.now()}`;

let deployedUrl: string | undefined;

// ── MCP Client Bridge ───────────────────────────────────────────────
// Creates Stratus FunctionTools that call the deployed MCP server

function mcpTool(
	url: string,
	name: string,
	description: string,
	schema: z.ZodType,
	apiKeyValue: string,
) {
	return tool({
		name: `mcp_${name}`,
		description,
		parameters: schema,
		async execute(_ctx: unknown, params: unknown) {
			// Initialize with retry (Lambda cold start can 502)
			let initOk = false;
			for (let i = 0; i < 5; i++) {
				const init = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"x-api-key": apiKeyValue,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 0,
						method: "initialize",
						params: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							clientInfo: { name: "stratus-agent", version: "1.0.0" },
						},
					}),
				});
				if (init.ok) { initOk = true; break; }
				await Bun.sleep(1000);
			}
			if (!initOk) return "Init failed after retries";

			// Call the tool
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"x-api-key": apiKeyValue,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: params },
				}),
			});

			const data = await response.json();
			const content = data.result?.content;
			if (content?.[0]?.text) return content[0].text;
			return JSON.stringify(data);
		},
	});
}

// ── Setup / Teardown ────────────────────────────────────────────────

afterAll(async () => {
	if (FUNCTION_NAME) {
		console.log(`Cleaning up: ${FUNCTION_NAME}`);
		await destroy(FUNCTION_NAME, REGION).catch(() => {});
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

// ── Tests ───────────────────────────────────────────────────────────

describe("Stratus Agent → MCP on Lambda (full E2E)", () => {
	test("Step 1: Deploy MCP server to Lambda", async () => {
		const entryPath = resolve(import.meta.dir, "../../examples/playwright-server.ts");

		const result = await deploy({
			entry: entryPath,
			region: REGION,
			functionName: FUNCTION_NAME,
			memory: 256,
			timeout: 30,
		});

		deployedUrl = result.url;
		expect(result.url).toContain("lambda-url");
		console.log(`Deployed to: ${deployedUrl}`);

	}, 120000);

	test("Step 2: Verify MCP server responds", async () => {
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
						clientInfo: { name: "test", version: "1.0.0" },
					},
				}),
			});
			if (response.status === 200) break;
			await Bun.sleep(2000);
		}

		expect(response!.status).toBe(200);
		const data = await response!.json();
		expect(data.result.serverInfo.name).toBe("playwright-mcp");
		console.log("MCP server verified");
	}, 30000);

	test("Step 3: Stratus agent calls MCP tools via Azure OpenAI", async () => {
		expect(deployedUrl).toBeDefined();

		const model = new AzureChatCompletionsModel({
			endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
			apiKey: process.env.AZURE_OPENAI_API_KEY!,
			deployment: process.env.AZURE_OPENAI_DEPLOYMENT!,
			apiVersion: process.env.AZURE_OPENAI_API_VERSION!,
		});

		// Create Stratus tools that bridge to our deployed MCP server
		const navigateTool = mcpTool(
			deployedUrl!,
			"browser_navigate",
			"Navigate to a URL in the browser",
			z.object({ url: z.string() }),
			"demo-key",
		);

		const snapshotTool = mcpTool(
			deployedUrl!,
			"browser_snapshot",
			"Take an accessibility snapshot of the current page",
			z.object({}),
			"demo-key",
		);

		const agent = new Agent({
			name: "browser-agent",
			instructions:
				"You are a browser automation agent. Use the available tools to navigate and inspect web pages. Always call browser_navigate first, then browser_snapshot.",
			model,
			tools: [navigateTool, snapshotTool],
		});

		const result = await run(agent, "Navigate to https://example.com and take a snapshot", {
			maxTurns: 5,
		});

		console.log(`Turns: ${result.numTurns}`);

		// Agent should have run at least 1 turn
		expect(result.numTurns).toBeGreaterThanOrEqual(1);

		// Check that the agent actually called our MCP tools
		if (!result.interrupted) {
			const messages = result.toInputList();
			const toolMessages = messages.filter((m: { role: string }) => m.role === "tool");
			console.log(`Tool calls made: ${toolMessages.length}`);
			expect(toolMessages.length).toBeGreaterThan(0);

			// Verify tool results contain MCP server responses
			for (const msg of toolMessages) {
				if (msg.role === "tool") {
					console.log(`Tool "${(msg as any).tool_call_id}": ${(msg as any).content.slice(0, 200)}`);
					// Should contain actual data from our Lambda, not errors
					expect((msg as any).content).not.toContain("ECONNREFUSED");
					expect((msg as any).content).not.toContain("fetch failed");
				}
			}

			// If agent produced final output, log it
			if (result.finalOutput) {
				console.log(`Agent final output: ${String(result.finalOutput).slice(0, 200)}`);
			}
		}
	}, 60000);

	test("Step 4: Destroy deployed Lambda", async () => {
		const result = await destroy(FUNCTION_NAME, REGION);
		expect(result.deleted).toBe(true);
		console.log("Lambda destroyed");
	}, 15000);
});
