import { type ChildProcess, spawn } from "node:child_process";
import type { FunctionTool } from "./tool";

export interface McpClientConfig {
	/** Command to spawn the MCP server process */
	command: string;
	/** Arguments for the command */
	args?: string[];
	/** Environment variables for the process */
	env?: Record<string, string>;
	/** Working directory */
	cwd?: string;
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * Local MCP client that connects to MCP servers via stdio transport.
 * Discovers tools and wraps them as FunctionTool instances for use with Stratus agents.
 *
 * Usage:
 * ```ts
 * const client = new McpClient({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] });
 * await client.connect();
 * const tools = await client.getTools();
 * const agent = new Agent({ tools });
 * // ...
 * await client.disconnect();
 * ```
 */
export class McpClient {
	private process: ChildProcess | null = null;
	private buffer = "";
	private pendingRequests = new Map<number, PendingRequest>();
	private nextId = 1;
	private readonly config: McpClientConfig;

	constructor(config: McpClientConfig) {
		this.config = config;
	}

	/** Connect to the MCP server and perform the initialize handshake. */
	async connect(): Promise<void> {
		if (this.process) {
			throw new Error("McpClient is already connected");
		}

		this.process = spawn(this.config.command, this.config.args ?? [], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...this.config.env },
			cwd: this.config.cwd,
		});

		this.process.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			this.processBuffer();
		});

		this.process.on("error", (err) => {
			for (const { reject } of this.pendingRequests.values()) {
				reject(err);
			}
			this.pendingRequests.clear();
		});

		this.process.on("close", (code) => {
			const err = new Error(`MCP server exited with code ${code}`);
			for (const { reject } of this.pendingRequests.values()) {
				reject(err);
			}
			this.pendingRequests.clear();
			this.process = null;
		});

		await this.sendRequest("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "stratus-sdk", version: "1.0.0" },
		});

		this.sendNotification("notifications/initialized", {});
	}

	/** Discover tools exposed by the MCP server. */
	async listTools(): Promise<McpToolDefinition[]> {
		this.assertConnected();
		const result = (await this.sendRequest("tools/list", {})) as {
			tools: McpToolDefinition[];
		};
		return result.tools ?? [];
	}

	/** Call a tool on the MCP server and return concatenated text content. */
	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		this.assertConnected();
		const result = (await this.sendRequest("tools/call", {
			name,
			arguments: args,
		})) as { content: Array<{ type: string; text?: string }> };

		return (result.content ?? [])
			.filter((c): c is { type: string; text: string } => c.type === "text" && !!c.text)
			.map((c) => c.text)
			.join("\n");
	}

	/**
	 * Discover MCP tools and return them as Stratus FunctionTool instances.
	 * Each returned tool proxies execution to the MCP server via `tools/call`.
	 */
	async getTools<TContext = unknown>(): Promise<FunctionTool<any, TContext>[]> {
		const mcpTools = await this.listTools();
		const { z } = await import("zod");

		return mcpTools.map((mcpTool) => ({
			type: "function" as const,
			name: mcpTool.name,
			description: mcpTool.description ?? "",
			parameters: z.record(z.string(), z.unknown()),
			_rawJsonSchema: mcpTool.inputSchema,
			execute: async (_context: TContext, params: Record<string, unknown>) => {
				return this.callTool(mcpTool.name, params);
			},
		}));
	}

	/** Disconnect from the MCP server and clean up. */
	async disconnect(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
		for (const { reject } of this.pendingRequests.values()) {
			reject(new Error("MCP client disconnected"));
		}
		this.pendingRequests.clear();
		this.buffer = "";
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.disconnect();
	}

	// --- Private helpers ---

	private assertConnected(): void {
		if (!this.process) {
			throw new Error("McpClient is not connected. Call connect() first.");
		}
	}

	private processBuffer(): void {
		// MCP stdio uses JSON-RPC with Content-Length framing (like LSP).
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.slice(0, headerEnd);
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				// Malformed header; skip past it
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const rawLength = match[1];
			if (rawLength === undefined) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const contentLength = Number.parseInt(rawLength, 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + contentLength) break;

			const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
			this.buffer = this.buffer.slice(bodyStart + contentLength);

			try {
				const message = JSON.parse(body) as {
					id?: number;
					error?: { message?: string; code?: number };
					result?: unknown;
				};
				const pending = message.id !== undefined ? this.pendingRequests.get(message.id) : undefined;
				if (pending !== undefined) {
					this.pendingRequests.delete(message.id as number);
					if (message.error) {
						pending.reject(new Error(message.error.message ?? "MCP error"));
					} else {
						pending.resolve(message.result);
					}
				}
				// Notifications and server-initiated messages are ignored for now.
			} catch {
				// Ignore JSON parse errors in the buffer
			}
		}
	}

	private sendRequest(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin) {
				reject(new Error("McpClient is not connected. Call connect() first."));
				return;
			}
			const id = this.nextId++;
			this.pendingRequests.set(id, { resolve, reject });
			const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
			const packet = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			this.process.stdin.write(packet);
		});
	}

	private sendNotification(method: string, params: unknown): void {
		if (!this.process?.stdin) return;
		const body = JSON.stringify({ jsonrpc: "2.0", method, params });
		const packet = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
		this.process.stdin.write(packet);
	}
}
