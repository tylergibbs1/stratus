/**
 * MCP → AWS speed test.
 *
 * The question: how fast can you go from "I have an MCP server" to
 * "it's live on AWS and an agent is calling it"?
 *
 * Steps timed:
 * 1. Define server with tools
 * 2. Deploy to Lambda
 * 3. Agent calls tools on the live URL
 * 4. Tear down
 *
 * This is the DX proof — not a simulation, real AWS.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Agent, run, tool } from "stratus-sdk";
import { AzureChatCompletionsModel } from "stratus-sdk/azure";
import { z } from "zod";
import { deploy, destroy } from "../../src/deploy.js";

// Load .env from repo root (Bun loads from cwd, but tests run from package dir)
const envFile = Bun.file(resolve(import.meta.dir, "../../../../.env"));
if (await envFile.exists()) {
	for (const line of (await envFile.text()).split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) process.env[line.slice(0, eq)] = line.slice(eq + 1);
	}
}


const REGION = "us-east-1";
const FUNCTION_NAME = `mcp-speed-${Date.now()}`;
let url: string;

afterAll(async () => {
	try {
		await destroy(FUNCTION_NAME, REGION);
		const { IAMClient, DetachRolePolicyCommand, DeleteRoleCommand } = await import(
			"@aws-sdk/client-iam"
		);
		const iam = new IAMClient({ region: REGION });
		await iam
			.send(
				new DetachRolePolicyCommand({
					RoleName: `${FUNCTION_NAME}-role`,
					PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
				}),
			)
			.catch(() => {});
		await iam.send(new DeleteRoleCommand({ RoleName: `${FUNCTION_NAME}-role` })).catch(() => {});
	} catch {}
});

// ── Helper: bridge an MCP tool to a Stratus FunctionTool ────────

function mcpBridge(
	mcpUrl: string,
	name: string,
	description: string,
	schema: z.ZodType,
	key: string,
) {
	return tool({
		name,
		description,
		parameters: schema,
		async execute(_ctx: unknown, params: unknown) {
			// Initialize with retry (Lambda cold start can 502)
			let init: Response | undefined;
			for (let i = 0; i < 5; i++) {
				init = await fetch(mcpUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"x-api-key": key,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 0,
						method: "initialize",
						params: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							clientInfo: { name: "agent", version: "1.0" },
						},
					}),
				});
				if (init.ok) break;
				await Bun.sleep(1000);
			}
			if (!init?.ok) return `Init failed: ${init?.status}`;

			const res = await fetch(mcpUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"x-api-key": key,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: params },
				}),
			});
			const data = await res.json();
			return data.result?.content?.[0]?.text ?? JSON.stringify(data);
		},
	});
}

// ── The test ────────────────────────────────────────────────────

describe("MCP → AWS speed test", () => {
	let deployMs: number;

	test("deploy: MCP server → Lambda in one call", async () => {
		const start = Date.now();

		const result = await deploy({
			entry: resolve(import.meta.dir, "../../examples/playwright-server.ts"),
			region: REGION,
			functionName: FUNCTION_NAME,
		});

		deployMs = Date.now() - start;
		url = result.url;

		console.log(`\n  DEPLOY TIME: ${(deployMs / 1000).toFixed(1)}s`);
		console.log(`  URL: ${url}\n`);

		expect(url).toContain("lambda-url");

		// No fixed sleep — the verify step retries until Lambda is warm
	}, 120000);

	test("verify: MCP protocol works on the live URL", async () => {
		// Retry until Lambda cold start completes (502 = not ready yet)
		let initRes: Response | undefined;
		for (let attempt = 0; attempt < 10; attempt++) {
			initRes = await fetch(url, {
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
						clientInfo: { name: "test", version: "1.0" },
					},
				}),
			});
			if (initRes.status === 200) break;
			console.log(`  Attempt ${attempt + 1}: ${initRes.status} (warming up...)`);
			await Bun.sleep(2000);
		}
		expect(initRes!.status).toBe(200);
		const init = await initRes!.json();
		expect(init.result.serverInfo.name).toBe("playwright-mcp");

		// List tools
		const listRes = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"x-api-key": "demo-key",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		});
		const list = await listRes.json();
		const tools = list.result.tools.map((t: { name: string }) => t.name);
		console.log(`  Tools available: ${tools.join(", ")}`);
		expect(tools).toContain("browser_navigate");
		expect(tools).toContain("search_tools");

		// Call a tool
		const callRes = await fetch(url, {
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
				params: { name: "browser_navigate", arguments: { url: "https://example.com" } },
			}),
		});
		const call = await callRes.json();
		const text = call.result.content[0].text;
		console.log(`  Tool result: ${text}`);
		expect(text).toContain("example.com");
	}, 30000);

	test("agent: Stratus agent calls tools on the deployed MCP server", async () => {
		const model = new AzureChatCompletionsModel({
			endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
			apiKey: process.env.AZURE_OPENAI_API_KEY!,
			deployment: process.env.AZURE_OPENAI_DEPLOYMENT!,
			apiVersion: process.env.AZURE_OPENAI_API_VERSION!,
		});

		const navigate = mcpBridge(
			url,
			"browser_navigate",
			"Navigate to a URL",
			z.object({ url: z.string() }),
			"demo-key",
		);
		const snapshot = mcpBridge(
			url,
			"browser_snapshot",
			"Get page accessibility snapshot",
			z.object({}),
			"demo-key",
		);

		const agent = new Agent({
			name: "site-documenter",
			instructions:
				"Navigate to the given URL, take a snapshot, then write a brief summary of what's on the page. Use browser_navigate first, then browser_snapshot.",
			model,
			tools: [navigate, snapshot],
		});

		const start = Date.now();
		const result = await run(agent, "Document https://example.com", { maxTurns: 5 });
		const agentMs = Date.now() - start;

		const toolCalls = result.toInputList().filter((m) => m.role === "tool");
		console.log(`\n  AGENT TIME: ${(agentMs / 1000).toFixed(1)}s`);
		console.log(`  Turns: ${result.numTurns}`);
		console.log(`  Tool calls: ${toolCalls.length}`);
		for (const tc of toolCalls) {
			if (tc.role === "tool") console.log(`    → ${tc.content.slice(0, 120)}`);
		}

		expect(result.numTurns).toBeGreaterThanOrEqual(1);
		expect(toolCalls.length).toBeGreaterThan(0);
	}, 60000);

	test("destroy: clean up in one call", async () => {
		const result = await destroy(FUNCTION_NAME, REGION);
		expect(result.deleted).toBe(true);
		console.log(`\n  TOTAL DEPLOY TIME: ${(deployMs / 1000).toFixed(1)}s from code to live URL`);
	}, 15000);
});
