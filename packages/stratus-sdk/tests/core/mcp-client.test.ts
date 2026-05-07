import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpClient, azureMcpHeaders } from "../../src/core/mcp-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("McpClient", () => {
	test("can be instantiated with minimal config", () => {
		const client = new McpClient({ command: "echo" });
		expect(client).toBeDefined();
	});

	test("can be instantiated with full config", () => {
		const client = new McpClient({
			command: "node",
			args: ["mcp-server.js"],
			env: { DEBUG: "true" },
			cwd: "/tmp",
		});
		expect(client).toBeDefined();
	});

	test("disconnect is safe to call without connect", async () => {
		const client = new McpClient({ command: "echo" });
		await client.disconnect();
	});

	test("disconnect can be called multiple times", async () => {
		const client = new McpClient({ command: "echo" });
		await client.disconnect();
		await client.disconnect();
	});

	test("listTools throws when not connected", async () => {
		const client = new McpClient({ command: "echo" });
		await expect(client.listTools()).rejects.toThrow("not connected");
	});

	test("callTool throws when not connected", async () => {
		const client = new McpClient({ command: "echo" });
		await expect(client.callTool("test", {})).rejects.toThrow("not connected");
	});

	test("getTools throws when not connected", async () => {
		const client = new McpClient({ command: "echo" });
		await expect(client.getTools()).rejects.toThrow("not connected");
	});

	test("Symbol.asyncDispose calls disconnect", async () => {
		const client = new McpClient({ command: "echo" });
		// Should not throw
		await client[Symbol.asyncDispose]();
	});

	test("streamable HTTP transport lists and calls tools", async () => {
		const calls: any[] = [];
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			calls.push({ body, headers: init?.headers });
			if (body.method === "tools/list") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: [
								{
									name: "search",
									description: "Search",
									inputSchema: { type: "object", properties: { query: { type: "string" } } },
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (body.method === "tools/call") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "found it" }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const client = new McpClient({
			transport: "streamable-http",
			url: "https://mcp.example.com",
			cacheToolsList: true,
			namePrefix: "mcp__docs__",
		});
		await client.connect();

		const tools = await client.getTools();
		const result = await tools[0]!.execute({} as never, { query: "azure" });

		expect(tools[0]!.name).toBe("mcp__docs__search");
		expect(result).toBe("found it");
		expect(calls.some((call) => call.body.method === "tools/list")).toBe(true);
		expect(calls.some((call) => call.body.method === "tools/call")).toBe(true);
	});

	test("streamable HTTP transport supports async Azure auth headers and tool filtering", async () => {
		const headersSeen: HeadersInit[] = [];
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			headersSeen.push(init?.headers ?? {});
			if (body.method === "tools/list") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: [
								{ name: "allowed", inputSchema: { type: "object" } },
								{ name: "blocked", inputSchema: { type: "object" } },
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const client = new McpClient({
			transport: "streamable-http",
			url: "https://mcp.example.com",
			headers: azureMcpHeaders(async () => "token", { "x-tenant": "contoso" }),
			toolFilter: ["allowed"],
		});
		await client.connect();

		const tools = await client.listTools();

		expect(tools.map((tool) => tool.name)).toEqual(["allowed"]);
		expect((headersSeen[0] as Record<string, string>).Authorization).toBe("Bearer token");
		expect((headersSeen[0] as Record<string, string>)["x-tenant"]).toBe("contoso");
	});

	test("streamable HTTP transport accepts event-stream JSON-RPC responses", async () => {
		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (body.method === "tools/list") {
				return new Response(
					`data: ${JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [{ name: "search", inputSchema: { type: "object" } }] },
					})}\n\n`,
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const client = new McpClient({
			transport: "streamable-http",
			url: "https://mcp.example.com",
		});
		await client.connect();

		const tools = await client.listTools();

		expect(tools.map((tool) => tool.name)).toEqual(["search"]);
	});
});
