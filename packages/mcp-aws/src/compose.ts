/**
 * Composition utilities for MCP servers.
 *
 * codeMcpServer() — wraps any MCP server with code mode
 * createMcpHandler() — stateless request handler from a McpServer
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Executor } from "./codemode/executor.js";
import { FunctionExecutor, normalizeCode, sanitizeToolName } from "./codemode/index.js";

export type CodeMcpServerOptions = {
	/** The MCP server to wrap */
	server: SdkMcpServer;
	/** Optional executor (default: FunctionExecutor with 30s timeout) */
	executor?: Executor;
	/** Name for the wrapper server */
	name?: string;
	/** Version for the wrapper server */
	version?: string;
};

/**
 * Wrap any MCP server with code mode. Returns a new MCP server with a single
 * `execute_code` tool. The LLM writes code that calls the wrapped server's tools.
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { codeMcpServer } from "@usestratus/mcp-aws";
 *
 * const original = new McpServer({ name: "tools", version: "1.0" });
 * original.registerTool("greet", { inputSchema: { name: z.string() } },
 *   async ({ name }) => ({ content: [{ type: "text", text: `Hello ${name}` }] })
 * );
 *
 * const codeServer = await codeMcpServer({ server: original });
 * // codeServer has one tool: execute_code
 * ```
 */
export async function codeMcpServer(options: CodeMcpServerOptions): Promise<SdkMcpServer> {
	const { server, name = "code-server", version = "1.0.0" } = options;
	const executor = options.executor ?? new FunctionExecutor({ timeout: 30_000 });

	// Connect a client to discover the wrapped server's tools
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "code-bridge", version: "1.0.0" });
	await server.connect(serverTransport);
	await client.connect(clientTransport);

	const toolsResponse = await client.listTools();
	const tools = toolsResponse.tools;

	// Generate type definitions for all discovered tools
	const typeLines: string[] = [];
	const toolMap = new Map<string, (args: unknown) => Promise<unknown>>();

	for (const tool of tools) {
		const safeName = sanitizeToolName(tool.name);
		if (toolMap.has(safeName)) {
			throw new Error(
				`Tool name collision: "${tool.name}" sanitizes to "${safeName}" which is already used. Rename one of the conflicting tools.`,
			);
		}
		typeLines.push(`\t/** ${tool.description ?? tool.name} */`);
		typeLines.push(`\t${safeName}: (input: unknown) => Promise<unknown>;`);

		toolMap.set(safeName, async (args: unknown) => {
			const result = await client.callTool({
				name: tool.name,
				arguments: (args ?? {}) as Record<string, unknown>,
			});
			const content = result.content as { type: string; text?: string }[];
			const textPart = content.find((c) => c.type === "text" && c.text);
			if (textPart?.text) {
				try {
					return JSON.parse(textPart.text);
				} catch {
					return textPart.text;
				}
			}
			return null;
		});
	}

	const types = `declare const codemode: {\n${typeLines.join("\n")}\n}`;
	const description = `Execute code to use available tools.\n\nAvailable:\n${types}\n\nWrite an async arrow function in JavaScript.\nExample: async () => { const r = await codemode.greet({ name: "World" }); return r; }`;

	// Create the wrapper server with a single code tool
	const wrapper = new SdkMcpServer({ name, version });

	wrapper.registerTool(
		"execute_code",
		{
			description,
			inputSchema: {
				code: z.string().describe("JavaScript async arrow function to execute"),
			},
		},
		async ({ code }: { code: string }) => {
			const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
			for (const [safeName, fn] of toolMap) {
				fns[safeName] = fn;
			}

			const normalized = normalizeCode(code);
			const result = await executor.execute(normalized, fns);

			if (result.error) {
				const logs = result.logs?.length ? `\n\nLogs:\n${result.logs.join("\n")}` : "";
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}${logs}` }],
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
			};
		},
	);

	return wrapper;
}

export type CreateMcpHandlerOptions = {
	/** Factory that creates a fresh MCP server per request (stateless isolation). */
	createServer: () => SdkMcpServer;
};

/**
 * Create a stateless HTTP request handler from any MCP server.
 * Each request gets a fresh transport. Works with Lambda Function URLs,
 * Bun.serve, Deno.serve, or any Web Standard compatible runtime.
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { createMcpHandler } from "@usestratus/mcp-aws";
 *
 * const server = new McpServer({ name: "api", version: "1.0" });
 * const handler = createMcpHandler({ server });
 *
 * // Bun
 * Bun.serve({ fetch: handler });
 *
 * // Lambda Function URL
 * export default handler;
 * ```
 */
export function createMcpHandler(
	options: CreateMcpHandlerOptions,
): (req: Request) => Promise<Response> {
	return async (req: Request): Promise<Response> => {
		if (req.method !== "POST") {
			return new Response(JSON.stringify({ error: "Method not allowed" }), {
				status: 405,
				headers: { "Content-Type": "application/json", Allow: "POST" },
			});
		}

		const { WebStandardStreamableHTTPServerTransport } = await import(
			"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
		);

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});

		const server = options.createServer();
		await server.connect(transport);
		const response = await transport.handleRequest(req);
		await transport.close();
		await server.close();

		return response;
	};
}
