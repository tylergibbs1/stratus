import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { codeMcpServer, createMcpHandler } from "../src/compose.js";

describe("codeMcpServer", () => {
	test("wraps an MCP server with a single execute_code tool", async () => {
		const original = new SdkMcpServer({ name: "tools", version: "1.0.0" });
		original.registerTool(
			"greet",
			{ description: "Say hello", inputSchema: { name: z.string() } },
			async ({ name }: { name: string }) => ({
				content: [{ type: "text" as const, text: `Hello, ${name}!` }],
			}),
		);

		const codeServer = await codeMcpServer({ server: original, name: "code-wrapper" });

		// Connect a client to the code server
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "1.0.0" });
		await codeServer.connect(st);
		await client.connect(ct);

		try {
			// Should have exactly one tool: execute_code
			const tools = await client.listTools();
			expect(tools.tools.length).toBe(1);
			expect(tools.tools[0]!.name).toBe("execute_code");

			// Execute code that calls the wrapped greet tool
			const result = await client.callTool({
				name: "execute_code",
				arguments: {
					code: 'async () => { const r = await codemode.greet({ name: "World" }); return r; }',
				},
			});

			const content = result.content as { type: string; text: string }[];
			expect(content[0]!.type).toBe("text");
			expect(content[0]!.text).toContain("Hello, World!");
		} finally {
			await client.close();
			await codeServer.close();
		}
	});

	test("wraps multiple tools", async () => {
		const original = new SdkMcpServer({ name: "math", version: "1.0.0" });
		original.registerTool(
			"add",
			{ inputSchema: { a: z.number(), b: z.number() } },
			async ({ a, b }: { a: number; b: number }) => ({
				content: [{ type: "text" as const, text: String(a + b) }],
			}),
		);
		original.registerTool(
			"multiply",
			{ inputSchema: { a: z.number(), b: z.number() } },
			async ({ a, b }: { a: number; b: number }) => ({
				content: [{ type: "text" as const, text: String(a * b) }],
			}),
		);

		const codeServer = await codeMcpServer({ server: original });

		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "1.0.0" });
		await codeServer.connect(st);
		await client.connect(ct);

		try {
			const result = await client.callTool({
				name: "execute_code",
				arguments: {
					code: `async () => {
						const sum = await codemode.add({ a: 3, b: 4 });
						const product = await codemode.multiply({ a: sum, b: 10 });
						return product;
					}`,
				},
			});

			const content = result.content as { type: string; text: string }[];
			expect(JSON.parse(content[0]!.text)).toBe(70);
		} finally {
			await client.close();
			await codeServer.close();
		}
	});
});

describe("createMcpHandler", () => {
	test("returns a request handler function", () => {
		const server = new SdkMcpServer({ name: "test", version: "1.0.0" });
		const handler = createMcpHandler({ createServer: () => server });
		expect(typeof handler).toBe("function");
	});

	test("handles POST requests with MCP JSON-RPC", async () => {
		const createServer = () => {
			const s = new SdkMcpServer({ name: "test-handler", version: "1.0.0" });
			s.registerTool("ping", { description: "Ping" }, async () => ({
				content: [{ type: "text" as const, text: "pong" }],
			}));
			return s;
		};

		const handler = createMcpHandler({ createServer });

		const request = new Request("https://localhost/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
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

		const response = await handler(request);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.result.serverInfo.name).toBe("test-handler");
	});

	test("rejects GET with 405", async () => {
		const server = new SdkMcpServer({ name: "test", version: "1.0.0" });
		const handler = createMcpHandler({ createServer: () => server });

		const request = new Request("https://localhost/mcp", { method: "GET" });
		const response = await handler(request);
		expect(response.status).toBe(405);
	});
});
