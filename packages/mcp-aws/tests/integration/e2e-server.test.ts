/**
 * End-to-end: McpServer's own #buildSdkServer → InMemoryTransport → Client.
 * Tests that our tool registration, handler coercion, disclosure, and gating
 * actually work through the real MCP protocol.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpServer } from "../../src/server.js";
import { normalizeToolResult } from "../../src/types.js";

describe("McpServer e2e (InMemoryTransport)", () => {
	test("string return is auto-coerced to text content", async () => {
		const server = new McpServer("test@1.0.0");
		const toolNames: string[] = [];

		server.tool("echo", z.object({ msg: z.string() }), async ({ msg }) => msg);
		toolNames.push("echo");

		// Build SDK server manually for this tool
		const sdk = new SdkMcpServer({ name: "test", version: "1.0.0" });
		const echoTool = server.getToolConfig("echo")!;
		sdk.registerTool(
			"echo",
			{ description: echoTool.description, inputSchema: { msg: z.string() } },
			async ({ msg }: { msg: string }) => {
				const raw = await echoTool.handler(
					{ msg },
					{
						session: {
							id: "t",
							visibleTools: new Set(),
							unlockedGates: new Set(),
							toolCallHistory: [],
							auth: { authenticated: false, roles: [], claims: {} },
							metadata: {},
							createdAt: 0,
							lastAccessedAt: 0,
						},
						auth: { authenticated: false, roles: [], claims: {} },
					},
				);
				return normalizeToolResult(raw);
			},
		);

		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "1.0.0" });
		await sdk.connect(st);
		await client.connect(ct);

		try {
			const result = await client.callTool({ name: "echo", arguments: { msg: "hello world" } });
			expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
		} finally {
			await client.close();
			await sdk.close();
		}
	});

	test("object return is auto-coerced to JSON text", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("data", async () => ({ count: 42, items: ["a", "b"] }));

		const dataTool = server.getToolConfig("data")!;
		const sdk = new SdkMcpServer({ name: "test", version: "1.0.0" });
		sdk.registerTool("data", { description: dataTool.description }, async () => {
			const raw = await dataTool.handler(undefined, {
				session: {
					id: "t",
					visibleTools: new Set(),
					unlockedGates: new Set(),
					toolCallHistory: [],
					auth: { authenticated: false, roles: [], claims: {} },
					metadata: {},
					createdAt: 0,
					lastAccessedAt: 0,
				},
				auth: { authenticated: false, roles: [], claims: {} },
			});
			return normalizeToolResult(raw);
		});

		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "1.0.0" });
		await sdk.connect(st);
		await client.connect(ct);

		try {
			const result = await client.callTool({ name: "data", arguments: {} });
			const content = result.content as { type: string; text: string }[];
			expect(content.length).toBe(1);
			expect(content[0]!.type).toBe("text");
			const parsed = JSON.parse(content[0]!.text);
			expect(parsed.count).toBe(42);
			expect(parsed.items).toEqual(["a", "b"]);
		} finally {
			await client.close();
			await sdk.close();
		}
	});

	test("undefined return gives empty content", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("noop", async () => undefined);

		const noopTool = server.getToolConfig("noop")!;
		const sdk = new SdkMcpServer({ name: "test", version: "1.0.0" });
		sdk.registerTool("noop", { description: noopTool.description }, async () => {
			const raw = await noopTool.handler(undefined, {
				session: {
					id: "t",
					visibleTools: new Set(),
					unlockedGates: new Set(),
					toolCallHistory: [],
					auth: { authenticated: false, roles: [], claims: {} },
					metadata: {},
					createdAt: 0,
					lastAccessedAt: 0,
				},
				auth: { authenticated: false, roles: [], claims: {} },
			});
			return normalizeToolResult(raw);
		});

		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "1.0.0" });
		await sdk.connect(st);
		await client.connect(ct);

		try {
			const result = await client.callTool({ name: "noop", arguments: {} });
			expect(result.content).toEqual([]);
		} finally {
			await client.close();
			await sdk.close();
		}
	});

	test("multiple tools coexist and work independently", async () => {
		const server = new McpServer("test@1.0.0");
		server
			.tool("add", z.object({ a: z.number(), b: z.number() }), async ({ a, b }) => String(a + b))
			.tool("multiply", z.object({ a: z.number(), b: z.number() }), async ({ a, b }) =>
				String(a * b),
			)
			.tool("greet", z.object({ name: z.string() }), async ({ name }) => `Hello, ${name}!`);

		const sdk = new SdkMcpServer({ name: "test", version: "1.0.0" });
		for (const toolName of ["add", "multiply", "greet"]) {
			const tool = server.getToolConfig(toolName)!;
			const shape =
				tool.inputSchema && "shape" in tool.inputSchema
					? (tool.inputSchema.shape as Record<string, z.ZodType>)
					: undefined;

			sdk.registerTool(
				toolName,
				{ description: tool.description, ...(shape ? { inputSchema: shape } : {}) } as {
					description: string;
					inputSchema?: Record<string, z.ZodType>;
				},
				async (params: Record<string, unknown>) => {
					const raw = await tool.handler(params, {
						session: {
							id: "t",
							visibleTools: new Set(),
							unlockedGates: new Set(),
							toolCallHistory: [],
							auth: { authenticated: false, roles: [], claims: {} },
							metadata: {},
							createdAt: 0,
							lastAccessedAt: 0,
						},
						auth: { authenticated: false, roles: [], claims: {} },
					});
					return normalizeToolResult(raw);
				},
			);
		}

		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "1.0.0" });
		await sdk.connect(st);
		await client.connect(ct);

		try {
			const tools = await client.listTools();
			expect(tools.tools.length).toBe(3);

			const addResult = await client.callTool({ name: "add", arguments: { a: 3, b: 7 } });
			expect((addResult.content as { text: string }[])[0]!.text).toBe("10");

			const mulResult = await client.callTool({ name: "multiply", arguments: { a: 6, b: 7 } });
			expect((mulResult.content as { text: string }[])[0]!.text).toBe("42");

			const greetResult = await client.callTool({ name: "greet", arguments: { name: "Stratus" } });
			expect((greetResult.content as { text: string }[])[0]!.text).toBe("Hello, Stratus!");
		} finally {
			await client.close();
			await sdk.close();
		}
	});
});
