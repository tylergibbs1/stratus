import { type ChildProcess, spawn } from "node:child_process";
import type { FunctionTool } from "./tool";

export type McpToolFilter = string[] | ((tool: McpToolDefinition) => boolean | Promise<boolean>);

export type McpHeaders =
	| Record<string, string>
	| (() => Record<string, string> | Promise<Record<string, string>>);

export interface McpClientConfig {
	/** Transport. Defaults to stdio when command is provided, otherwise streamable-http. */
	transport?: "stdio" | "streamable-http";
	/** Command to spawn for stdio MCP servers. */
	command?: string;
	/** Arguments for the stdio command. */
	args?: string[];
	/** Environment variables for the stdio process. */
	env?: Record<string, string>;
	/** Working directory for the stdio process. */
	cwd?: string;
	/** Streamable HTTP MCP endpoint. */
	url?: string;
	/** Static or async headers for HTTP MCP servers. Use this for Entra tokens or API keys. */
	headers?: McpHeaders;
	/** Cache tools/list results after the first call. */
	cacheToolsList?: boolean;
	/** Filter discovered tools before exposing them to an agent. */
	toolFilter?: McpToolFilter;
	/** Prefix exposed tool names, useful when multiple MCP servers have overlapping names. */
	namePrefix?: string;
	/** JSON-RPC request timeout in milliseconds. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export function azureMcpHeaders(
	tokenProvider: () => Promise<string>,
	extraHeaders?: Record<string, string>,
): () => Promise<Record<string, string>> {
	return async () => ({
		...extraHeaders,
		Authorization: `Bearer ${await tokenProvider()}`,
	});
}

/**
 * MCP client for local stdio servers and Streamable HTTP servers.
 * Discovers MCP tools and wraps them as Stratus FunctionTool instances.
 */
export class McpClient {
	private process: ChildProcess | null = null;
	private buffer = "";
	private pendingRequests = new Map<number, PendingRequest>();
	private nextId = 1;
	private cachedTools: McpToolDefinition[] | undefined;
	private readonly config: McpClientConfig;
	private readonly transport: "stdio" | "streamable-http";
	private connected = false;

	constructor(config: McpClientConfig) {
		this.config = config;
		this.transport = config.transport ?? (config.command ? "stdio" : "streamable-http");
	}

	async connect(): Promise<void> {
		if (this.connected) {
			throw new Error("McpClient is already connected");
		}
		if (this.transport === "stdio") {
			await this.connectStdio();
		} else {
			if (!this.config.url) {
				throw new Error("McpClient streamable-http transport requires url");
			}
			await this.sendRequest("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "stratus-sdk", version: "1.0.0" },
			});
			await this.sendNotification("notifications/initialized", {});
		}
		this.connected = true;
	}

	async listTools(options?: { refresh?: boolean }): Promise<McpToolDefinition[]> {
		this.assertConnected();
		if (this.config.cacheToolsList && this.cachedTools && !options?.refresh) {
			return this.cachedTools;
		}
		const result = (await this.sendRequest("tools/list", {})) as {
			tools?: McpToolDefinition[];
		};
		const tools = await this.applyToolFilter(result.tools ?? []);
		if (this.config.cacheToolsList) {
			this.cachedTools = tools;
		}
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		this.assertConnected();
		const rawName = this.stripPrefix(name);
		const result = (await this.sendRequest("tools/call", {
			name: rawName,
			arguments: args,
		})) as {
			content?: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};

		const text = (result.content ?? [])
			.filter((c): c is { type: string; text: string } => c.type === "text" && !!c.text)
			.map((c) => c.text)
			.join("\n");
		if (result.isError) {
			throw new Error(text || `MCP tool "${rawName}" failed`);
		}
		return text;
	}

	async getTools<TContext = unknown>(): Promise<FunctionTool<Record<string, unknown>, TContext>[]> {
		const mcpTools = await this.listTools();
		const { z } = await import("zod");

		return mcpTools.map((mcpTool) => {
			const exposedName = this.withPrefix(mcpTool.name);
			return {
				type: "function" as const,
				name: exposedName,
				description: mcpTool.description ?? "",
				parameters: z.record(z.string(), z.unknown()),
				_rawJsonSchema: mcpTool.inputSchema,
				execute: async (_context: TContext, params: Record<string, unknown>) => {
					return this.callTool(exposedName, params);
				},
			};
		});
	}

	async disconnect(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
		for (const { reject, timer } of this.pendingRequests.values()) {
			clearTimeout(timer);
			reject(new Error("MCP client disconnected"));
		}
		this.pendingRequests.clear();
		this.buffer = "";
		this.connected = false;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.disconnect();
	}

	private async connectStdio(): Promise<void> {
		if (!this.config.command) {
			throw new Error("McpClient stdio transport requires command");
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
			for (const { reject, timer } of this.pendingRequests.values()) {
				clearTimeout(timer);
				reject(err);
			}
			this.pendingRequests.clear();
		});

		this.process.on("close", (code) => {
			const err = new Error(`MCP server exited with code ${code}`);
			for (const { reject, timer } of this.pendingRequests.values()) {
				clearTimeout(timer);
				reject(err);
			}
			this.pendingRequests.clear();
			this.process = null;
			this.connected = false;
		});

		await this.sendRequest("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "stratus-sdk", version: "1.0.0" },
		});

		await this.sendNotification("notifications/initialized", {});
	}

	private assertConnected(): void {
		if (!this.connected) {
			throw new Error("McpClient is not connected. Call connect() first.");
		}
	}

	private async applyToolFilter(tools: McpToolDefinition[]): Promise<McpToolDefinition[]> {
		const filter = this.config.toolFilter;
		if (!filter) return tools;
		if (Array.isArray(filter)) {
			const allowed = new Set(filter);
			return tools.filter(
				(tool) => allowed.has(tool.name) || allowed.has(this.withPrefix(tool.name)),
			);
		}
		const filtered: McpToolDefinition[] = [];
		for (const tool of tools) {
			if (await filter(tool)) filtered.push(tool);
		}
		return filtered;
	}

	private withPrefix(name: string): string {
		return this.config.namePrefix ? `${this.config.namePrefix}${name}` : name;
	}

	private stripPrefix(name: string): string {
		const prefix = this.config.namePrefix;
		if (prefix && name.startsWith(prefix)) return name.slice(prefix.length);
		return name;
	}

	private processBuffer(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.slice(0, headerEnd);
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match?.[1]) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const contentLength = Number.parseInt(match[1], 10);
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
					clearTimeout(pending.timer);
					this.pendingRequests.delete(message.id as number);
					if (message.error) {
						pending.reject(new Error(message.error.message ?? "MCP error"));
					} else {
						pending.resolve(message.result);
					}
				}
			} catch {
				// Ignore malformed server messages.
			}
		}
	}

	private sendRequest(method: string, params: unknown): Promise<unknown> {
		if (this.transport === "streamable-http") {
			return this.sendHttpRequest(method, params, true);
		}
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin) {
				reject(new Error("McpClient is not connected. Call connect() first."));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`MCP request timed out: ${method}`));
			}, this.config.requestTimeoutMs ?? 30_000);
			this.pendingRequests.set(id, { resolve, reject, timer });
			const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
			const packet = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			this.process.stdin.write(packet);
		});
	}

	private async sendNotification(method: string, params: unknown): Promise<void> {
		if (this.transport === "streamable-http") {
			await this.sendHttpRequest(method, params, false);
			return;
		}
		if (!this.process?.stdin) return;
		const body = JSON.stringify({ jsonrpc: "2.0", method, params });
		const packet = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
		this.process.stdin.write(packet);
	}

	private async sendHttpRequest(
		method: string,
		params: unknown,
		expectResponse: boolean,
	): Promise<unknown> {
		if (!this.config.url) {
			throw new Error("McpClient streamable-http transport requires url");
		}
		const id = expectResponse ? this.nextId++ : undefined;
		const headers =
			typeof this.config.headers === "function"
				? await this.config.headers()
				: (this.config.headers ?? {});
		const response = await fetch(this.config.url, {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				...(id !== undefined ? { id } : {}),
				method,
				params,
			}),
			signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000),
		});
		if (!response.ok) {
			throw new Error(`MCP HTTP request failed (${response.status})`);
		}
		if (!expectResponse) return undefined;
		const json = (await this.parseHttpResponse(response)) as {
			error?: { message?: string };
			result?: unknown;
		};
		if (json.error) {
			throw new Error(json.error.message ?? "MCP error");
		}
		return json.result;
	}

	private async parseHttpResponse(response: Response): Promise<unknown> {
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("event-stream")) {
			return response.json();
		}
		const text = await response.text();
		for (const block of text.split("\n\n")) {
			const data = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trim())
				.join("\n");
			if (!data || data === "[DONE]") continue;
			return JSON.parse(data);
		}
		throw new Error("MCP HTTP event stream ended without a JSON-RPC response");
	}
}
