import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chainAuth } from "./auth/index.js";
import { buildResourceMetadata, buildWwwAuthenticateHeader } from "./auth/metadata.js";
import type { ResourceMetadataConfig } from "./auth/metadata.js";
import type { AuthProvider } from "./auth/types.js";
import type { Executor } from "./codemode/executor.js";
import {
	FunctionExecutor,
	WorkerExecutor,
	generateTypes,
	normalizeCode,
	sanitizeToolName,
} from "./codemode/index.js";
import { withContext } from "./context.js";
import {
	SearchIndex,
	type SearchResult,
	getVisibleTools,
	handleGateUnlock,
	promoteToVisible,
} from "./disclosure/index.js";
import { ToolTimeoutError } from "./errors.js";
import { McpEventEmitter, type McpEventMap, type McpEventName } from "./events.js";
import { MemorySessionStore } from "./session/memory.js";
import {
	type AuthContext,
	type CodeModeConfig,
	type DisclosureConfig,
	type GateContext,
	type McpServerConfig,
	type McpSession,
	type SessionStore,
	type ToolConfig,
	type ToolContext,
	type ToolHandler,
	type ToolHandlerReturn,
	type ToolOptions,
	type ToolResult,
	type ToolTier,
	normalizeToolResult,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function createSession(id: string, auth: AuthContext): McpSession {
	const now = Date.now();
	return {
		id,
		visibleTools: new Set(),
		unlockedGates: new Set(),
		toolCallHistory: [],
		auth,
		metadata: {},
		createdAt: now,
		lastAccessedAt: now,
	};
}

const UNAUTHED: AuthContext = { authenticated: false, roles: [], claims: {} };

function gateDenialResult(reason: string, hint?: string): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error: "Permission denied",
					reason,
					...(hint ? { hint } : {}),
				}),
			},
		],
		isError: true,
	};
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function parseNameVersion(input: string): { name: string; version: string } {
	const atIdx = input.lastIndexOf("@");
	if (atIdx > 0) {
		return { name: input.slice(0, atIdx), version: input.slice(atIdx + 1) };
	}
	return { name: input, version: "0.0.0" };
}

// ── Transport Config Types ──────────────────────────────────────────

export type LambdaTransportConfig = {
	sessionStore?: SessionStore;
	baseUrl?: string;
	resourceMetadata?: ResourceMetadataConfig;
};

export type ExpressTransportConfig = {
	sessionStore?: SessionStore;
	baseUrl?: string;
	resourceMetadata?: ResourceMetadataConfig;
	mcpPath?: string;
};

/** Structural type for Express-like app. Matches express.Application. */
export type ExpressLikeApp = {
	get(path: string, ...handlers: ((...args: unknown[]) => void)[]): void;
	post(path: string, ...handlers: ((...args: unknown[]) => void)[]): void;
	delete(path: string, ...handlers: ((...args: unknown[]) => void)[]): void;
};

// ── McpServer ───────────────────────────────────────────────────────

export class McpServer {
	readonly #config: McpServerConfig;
	readonly #tools = new Map<string, ToolConfig>();
	readonly #searchIndex = new SearchIndex();
	readonly #codeMode: CodeModeConfig;
	readonly #events = new McpEventEmitter();
	#authProvider: AuthProvider | undefined;
	#sdkServer: SdkMcpServer | undefined;
	/** Active session for the current request (set by transports). */
	#activeSession: McpSession | undefined;
	#activeAuth: AuthContext = UNAUTHED;

	/**
	 * Create an MCP server.
	 *
	 * @example
	 * ```ts
	 * const server = new McpServer("my-server@1.0.0");
	 * const server = new McpServer({ name: "my-server", version: "1.0.0" });
	 * ```
	 */
	constructor(config: string | McpServerConfig) {
		if (typeof config === "string") {
			this.#config = parseNameVersion(config);
		} else {
			this.#config = config;
		}
		this.#codeMode = this.#config.codeMode ?? { enabled: false };
	}

	// ── Auth ────────────────────────────────────────────────────────

	/**
	 * Set the auth provider. Multiple calls or args chain automatically.
	 *
	 * @example
	 * ```ts
	 * server.auth(apiKey({ "sk-123": { roles: ["admin"] } }));
	 * server.auth(cognito({ userPoolId: "...", region: "us-east-1" }));
	 * ```
	 */
	auth(...providers: AuthProvider[]): this {
		if (providers.length === 0) return this;
		const newProvider = chainAuth(...providers);
		if (this.#authProvider) {
			this.#authProvider = chainAuth(this.#authProvider, newProvider);
		} else {
			this.#authProvider = newProvider;
		}
		return this;
	}

	// ── Events ──────────────────────────────────────────────────────

	/**
	 * Subscribe to server lifecycle events.
	 *
	 * @example
	 * ```ts
	 * server.on("tool:call", (e) => console.log(`${e.toolName} called`));
	 * server.on("auth:failure", () => metrics.increment("auth.failures"));
	 * ```
	 */
	on<K extends McpEventName>(event: K, listener: (data: McpEventMap[K]) => void): this {
		this.#events.on(event, listener);
		return this;
	}

	off<K extends McpEventName>(event: K, listener: (data: McpEventMap[K]) => void): this {
		this.#events.off(event, listener);
		return this;
	}

	// ── Tool Registration ───────────────────────────────────────────

	/**
	 * Register a tool. Returns `this` for chaining.
	 *
	 * @example
	 * ```ts
	 * // Simple: name + handler (no params)
	 * server.tool("ping", async () => "pong");
	 *
	 * // With params: name + Zod schema + handler
	 * server.tool("greet", z.object({ name: z.string() }), async ({ name }) => {
	 *   return `Hello, ${name}!`;
	 * });
	 *
	 * // Full config: name + options + handler
	 * server.tool("admin_reset", {
	 *   description: "Reset user account",
	 *   params: z.object({ userId: z.string() }),
	 *   tier: "hidden",
	 *   gate: role("admin"),
	 * }, async ({ userId }) => {
	 *   return { reset: true, userId };
	 * });
	 * ```
	 */
	tool(name: string, handler: ToolHandler<undefined>): this;
	tool<T extends z.ZodType>(name: string, params: T, handler: ToolHandler<z.infer<T>>): this;
	tool<T extends z.ZodType>(
		name: string,
		options: ToolOptions<T>,
		handler: ToolHandler<z.infer<T>>,
	): this;
	tool(
		name: string,
		paramsOrOptionsOrHandler: z.ZodType | ToolOptions | ToolHandler<undefined>,
		maybeHandler?: ToolHandler,
	): this {
		let description = name;
		let inputSchema: z.ZodType | undefined;
		let tier: ToolTier = "always";
		let tags: string[] | undefined;
		let gate: ToolConfig["gate"];
		let timeout: number | undefined;
		let handler: ToolHandler;

		if (typeof paramsOrOptionsOrHandler === "function") {
			// Overload 1: tool(name, handler)
			handler = paramsOrOptionsOrHandler as ToolHandler;
		} else if (paramsOrOptionsOrHandler instanceof z.ZodType) {
			// Overload 2: tool(name, zodSchema, handler)
			inputSchema = paramsOrOptionsOrHandler;
			handler = maybeHandler!;
		} else {
			// Overload 3: tool(name, options, handler)
			const opts = paramsOrOptionsOrHandler as ToolOptions;
			description = opts.description ?? name;
			inputSchema = opts.params;
			tier = opts.tier ?? "always";
			tags = opts.tags;
			gate = opts.gate;
			timeout = opts.timeout;
			handler = maybeHandler!;
		}

		const toolConfig: ToolConfig = {
			name,
			description,
			inputSchema,
			tier,
			tags,
			gate,
			timeout,
			handler,
		};
		this.#tools.set(name, toolConfig);
		return this;
	}

	// ── Search ──────────────────────────────────────────────────────

	searchTools(query: string, maxResults?: number): SearchResult[] {
		return this.#searchIndex.search(query, maxResults ?? 10);
	}

	getVisibleTools(session: McpSession): ToolConfig[] {
		return getVisibleTools(this.#tools, session);
	}

	// ── Internal: Disclosure Mode Inference ─────────────────────────

	#inferDisclosureMode(): DisclosureConfig {
		// If explicitly configured, use that
		if (this.#config.disclosure) return this.#config.disclosure;

		// Auto-infer: if any tool uses non-default tiers, go progressive
		for (const tool of this.#tools.values()) {
			if (tool.tier === "discoverable" || tool.tier === "hidden") {
				return { mode: "progressive" };
			}
		}
		return { mode: "all" };
	}

	// ── Internal: Build MCP Server ──────────────────────────────────

	#buildSdkServer(): SdkMcpServer {
		const mcp = new SdkMcpServer({
			name: this.#config.name,
			version: this.#config.version,
		});

		this.#searchIndex.build([...this.#tools.values()]);

		const disclosure = this.#inferDisclosureMode();

		if (disclosure.mode === "all") {
			for (const tool of this.#tools.values()) {
				this.#registerToolWithSdk(mcp, tool);
			}
		} else if (disclosure.mode === "code-first") {
			// Code-first: only meta-tools visible, all tools available via code
			this.#registerSearchTool(mcp);
			this.#registerCodeModeTool(mcp);
		} else {
			// Progressive: always-tier + session-promoted tools + search_tools + optional code mode
			const sessionVisible = this.#activeSession?.visibleTools;
			for (const tool of this.#tools.values()) {
				if (tool.tier === "always" || sessionVisible?.has(tool.name)) {
					this.#registerToolWithSdk(mcp, tool);
				}
			}
			this.#registerSearchTool(mcp);
			if (this.#codeMode.enabled) {
				this.#registerCodeModeTool(mcp);
			}
		}

		this.#sdkServer = mcp;
		return mcp;
	}

	#registerToolWithSdk(mcp: SdkMcpServer, tool: ToolConfig): void {
		const inputSchema = tool.inputSchema ? this.#zodToMcpShape(tool.inputSchema) : undefined;

		const config: Record<string, unknown> = { description: tool.description };
		if (inputSchema) {
			config.inputSchema = inputSchema;
		}

		mcp.registerTool(
			tool.name,
			config as { description: string; inputSchema?: Record<string, z.ZodType> },
			async (params: Record<string, unknown>) => {
				return this.#executeToolHandler(tool, params, this.#activeAuth, this.#activeSession);
			},
		);
	}

	#zodToMcpShape(schema: z.ZodType): Record<string, z.ZodType> | z.ZodType {
		if ("shape" in schema && typeof schema.shape === "object" && schema.shape !== null) {
			return schema.shape as Record<string, z.ZodType>;
		}
		return schema;
	}

	async #executeToolHandler(
		tool: ToolConfig,
		params: unknown,
		auth?: AuthContext,
		session?: McpSession,
	): Promise<ToolResult> {
		const effectiveAuth = auth ?? session?.auth ?? UNAUTHED;
		const effectiveSession = session ?? createSession("default", effectiveAuth);

		// Gate check — uses real auth context
		if (tool.gate) {
			const gateCtx: GateContext = {
				auth: effectiveAuth,
				toolName: tool.name,
				sessionId: effectiveSession.id,
				metadata: { unlockedGates: effectiveSession.unlockedGates },
			};
			const gateResult = await tool.gate(gateCtx);
			if (!gateResult.allowed) {
				this.#events.emit("gate:denied", {
					toolName: tool.name,
					reason: gateResult.reason,
					auth: effectiveAuth,
					sessionId: effectiveSession.id,
					timestamp: Date.now(),
				});
				return gateDenialResult(gateResult.reason, gateResult.hint);
			}
		}

		const ctx: ToolContext = {
			session: effectiveSession,
			auth: effectiveAuth,
		};
		const timeoutMs = tool.timeout;
		const startTime = Date.now();

		this.#events.emit("tool:call", {
			toolName: tool.name,
			params,
			auth: effectiveAuth,
			sessionId: effectiveSession.id,
			timestamp: startTime,
		});

		try {
			// Run handler with AsyncLocalStorage context so getAuthContext()/getSession() work
			let raw: ToolHandlerReturn;
			const runHandler = () => {
				if (timeoutMs) {
					return Promise.race([
						tool.handler(params, ctx),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new ToolTimeoutError(tool.name, timeoutMs)), timeoutMs),
						),
					]);
				}
				return tool.handler(params, ctx);
			};
			raw = await withContext({ auth: effectiveAuth, session: effectiveSession }, runHandler);

			const durationMs = Date.now() - startTime;

			// Record tool call in session history
			effectiveSession.toolCallHistory.push({
				toolName: tool.name,
				params,
				timestamp: startTime,
				durationMs,
			});

			this.#events.emit("tool:result", {
				toolName: tool.name,
				durationMs,
				isError: false,
				auth: effectiveAuth,
				sessionId: effectiveSession.id,
				timestamp: Date.now(),
			});

			// Trigger gate unlocks: if this tool is a prerequisite for hidden tools
			const promoted = handleGateUnlock(this.#tools, effectiveSession, tool.name);
			if (promoted.length > 0 && this.#sdkServer) {
				for (const name of promoted) {
					const promotedTool = this.#tools.get(name);
					if (promotedTool) {
						this.#registerToolWithSdk(this.#sdkServer, promotedTool);
					}
				}
				this.#sdkServer.sendToolListChanged();
				this.#events.emit("tools:unlocked", {
					toolNames: promoted,
					prerequisite: tool.name,
					sessionId: effectiveSession.id,
					timestamp: Date.now(),
				});
			}

			return normalizeToolResult(raw);
		} catch (err) {
			const durationMs = Date.now() - startTime;
			effectiveSession.toolCallHistory.push({
				toolName: tool.name,
				params,
				timestamp: startTime,
				durationMs,
			});

			this.#events.emit("tool:result", {
				toolName: tool.name,
				durationMs,
				isError: true,
				auth: effectiveAuth,
				sessionId: effectiveSession.id,
				timestamp: Date.now(),
			});

			if (err instanceof ToolTimeoutError) {
				return errorResult(`Tool "${tool.name}" timed out after ${timeoutMs}ms`);
			}
			const message = err instanceof Error ? err.message : String(err);
			return errorResult(`Tool "${tool.name}" failed: ${message}`);
		}
	}

	#registerSearchTool(mcp: SdkMcpServer): void {
		mcp.registerTool(
			"search_tools",
			{
				description:
					"Search for available tools by query. Returns matching tools and makes them available for use.",
				inputSchema: { query: z.string().describe("Search query to find relevant tools") },
			},
			async ({ query }: { query: string }) => {
				const results = this.searchTools(query);
				if (results.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No tools found matching your query." }],
					};
				}

				let promoted = false;
				for (const result of results) {
					const tool = this.#tools.get(result.name);
					if (tool && tool.tier !== "always") {
						// Update session visibility
						if (this.#activeSession) {
							promoteToVisible(this.#activeSession, result.name);
						}
						// Register with MCP SDK so client can call it
						if (this.#sdkServer) {
							this.#registerToolWithSdk(this.#sdkServer, tool);
							promoted = true;
						}
					}
				}
				if (promoted) this.#sdkServer?.sendToolListChanged();

				const lines = results.map(
					(r) =>
						`- **${r.name}** (score: ${r.score.toFixed(2)}): ${r.description}${r.tags?.length ? ` [${r.tags.join(", ")}]` : ""}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${results.length} tool(s):\n${lines.join("\n")}`,
						},
					],
				};
			},
		);
	}

	#registerCodeModeTool(mcp: SdkMcpServer): void {
		const allTools = [...this.#tools.values()];
		const types = generateTypes(allTools);
		const executorType = this.#codeMode.executor ?? "function";
		const executor: Executor =
			executorType === "worker" ? new WorkerExecutor() : new FunctionExecutor();

		const description = `Execute code to achieve a goal.\n\nAvailable:\n${types}\n\nWrite an async arrow function in JavaScript that returns the result.\nDo NOT use TypeScript syntax.\n\nExample: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

		mcp.registerTool(
			"execute_workflow",
			{
				description,
				inputSchema: { code: z.string().describe("JavaScript async arrow function to execute") },
			},
			async ({ code }: { code: string }) => {
				const effectiveAuth = this.#activeAuth;
				const effectiveSession = this.#activeSession ?? createSession("default", effectiveAuth);

				// Pre-validation: extract tool references from code and validate gates upfront
				const referencedTools: ToolConfig[] = [];
				for (const tool of allTools) {
					const safeName = sanitizeToolName(tool.name);
					if (code.includes(`codemode.${safeName}`)) {
						referencedTools.push(tool);
					}
				}
				for (const tool of referencedTools) {
					if (tool.gate) {
						const gateCtx: GateContext = {
							auth: effectiveAuth,
							toolName: tool.name,
							sessionId: effectiveSession.id,
							metadata: { unlockedGates: effectiveSession.unlockedGates },
						};
						const gateResult = await tool.gate(gateCtx);
						if (!gateResult.allowed) {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											error: `Permission denied for tool '${tool.name}'`,
											reason: gateResult.reason,
											...(gateResult.hint ? { hint: gateResult.hint } : {}),
										}),
									},
								],
								isError: true,
							};
						}
					}
				}

				const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
				for (const tool of allTools) {
					const safeName = sanitizeToolName(tool.name);
					fns[safeName] = async (args: unknown) => {
						const validated = tool.inputSchema ? tool.inputSchema.parse(args) : args;
						const ctx: ToolContext = { session: effectiveSession, auth: effectiveAuth };
						const result = normalizeToolResult(await tool.handler(validated, ctx));
						const textPart = result.content.find((c) => c.type === "text");
						if (textPart && textPart.type === "text") {
							try {
								return JSON.parse(textPart.text);
							} catch {
								return textPart.text;
							}
						}
						return result.structuredContent ?? null;
					};
				}
				const normalizedCode = normalizeCode(code);
				const execResult = await executor.execute(normalizedCode, fns);
				if (execResult.error) {
					const logCtx = execResult.logs?.length
						? `\n\nConsole output:\n${execResult.logs.join("\n")}`
						: "";
					return {
						content: [
							{
								type: "text" as const,
								text: `Code execution failed: ${execResult.error}${logCtx}`,
							},
						],
						isError: true,
					};
				}
				const output = {
					code,
					result: execResult.result,
					...(execResult.logs?.length ? { logs: execResult.logs } : {}),
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
			},
		);
	}

	// ── Transport: stdio ────────────────────────────────────────────

	/**
	 * Connect to stdio transport. For local dev with Claude Desktop.
	 */
	async stdio(): Promise<void> {
		const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
		const mcp = this.#buildSdkServer();
		const transport = new StdioServerTransport();
		await mcp.connect(transport);
	}

	// ── Transport: Lambda ───────────────────────────────────────────

	/**
	 * Create a Lambda handler for Function URLs or API Gateway v2.
	 * Uses WebStandard transport: Request in → Response out.
	 * Stateless per-request MCP server isolation.
	 *
	 * @example
	 * ```ts
	 * // Lambda Function URL handler
	 * export default server.lambda();
	 *
	 * // Or with config
	 * export const handler = server.lambda({
	 *   baseUrl: "https://abc.lambda-url.us-east-1.on.aws",
	 * });
	 * ```
	 */
	lambda(config?: LambdaTransportConfig): (event: unknown) => Promise<unknown> {
		this.#buildSdkServer(); // validate registration
		const sessionStore = config?.sessionStore ?? new MemorySessionStore();
		const authProvider = this.#authProvider;
		const baseUrl = config?.baseUrl;
		const resourceMetadata = config?.resourceMetadata;

		return async (event: unknown) => {
			const apiEvent = event as {
				headers?: Record<string, string | undefined>;
				body?: string;
				isBase64Encoded?: boolean;
				httpMethod?: string;
				path?: string;
				rawPath?: string;
				requestContext?: {
					requestId?: string;
					http?: { method?: string; path?: string; sourceIp?: string };
				};
			};

			const headers = apiEvent.headers ?? {};
			const method = apiEvent.httpMethod ?? apiEvent.requestContext?.http?.method ?? "POST";
			const path = apiEvent.rawPath ?? apiEvent.path ?? "/";

			// RFC 9728 metadata endpoint
			if (path.endsWith("/.well-known/oauth-protected-resource") && resourceMetadata) {
				return {
					statusCode: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(buildResourceMetadata(resourceMetadata)),
				};
			}

			// Auth
			let auth: AuthContext = UNAUTHED;
			if (authProvider) {
				auth = await authProvider.authenticate({
					headers: headers as Record<string, string | string[] | undefined>,
				});
				if (!auth.authenticated) {
					const wwwAuth = baseUrl
						? buildWwwAuthenticateHeader(baseUrl)
						: 'Bearer realm="mcp-server"';
					return {
						statusCode: 401,
						headers: { "Content-Type": "application/json", "WWW-Authenticate": wwwAuth },
						body: JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32000, message: "Authentication required" },
							id: null,
						}),
					};
				}
			}

			if (method !== "POST") {
				return {
					statusCode: 405,
					headers: { Allow: "POST" },
					body: JSON.stringify({ error: "Method not allowed" }),
				};
			}

			// Session
			const requestId = apiEvent.requestContext?.requestId ?? crypto.randomUUID();
			const sessionId = (headers["x-session-id"] as string) ?? requestId;
			let session = await sessionStore.get(sessionId);
			if (!session) session = createSession(sessionId, auth);
			session.auth = auth;
			session.lastAccessedAt = Date.now();
			await sessionStore.set(session);

			// Set active context so tool handlers can access session/auth
			this.#activeSession = session;
			this.#activeAuth = auth;

			// Build a fresh MCP server + WebStandard transport per request
			const mcp = this.#buildSdkServer();
			const { WebStandardStreamableHTTPServerTransport } = await import(
				"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
			);
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // stateless
				enableJsonResponse: true, // JSON responses, no SSE (Lambda can't stream)
			});
			await mcp.connect(transport);

			// Convert Lambda event → Web Standard Request
			const bodyStr =
				apiEvent.isBase64Encoded && apiEvent.body
					? Buffer.from(apiEvent.body, "base64").toString("utf-8")
					: (apiEvent.body ?? "");

			const url = `https://localhost${path}`;
			const reqHeaders = new Headers();
			for (const [k, v] of Object.entries(headers)) {
				if (v) reqHeaders.set(k, String(v));
			}
			reqHeaders.set("content-type", "application/json");
			// MCP protocol requires Accept header with both content types
			if (!reqHeaders.has("accept")) {
				reqHeaders.set("accept", "application/json, text/event-stream");
			}

			const webRequest = new Request(url, {
				method: "POST",
				headers: reqHeaders,
				body: bodyStr,
			});

			// Process through MCP transport → get Web Standard Response
			const webResponse = await transport.handleRequest(webRequest);

			// Convert Web Standard Response → Lambda response
			const responseBody = await webResponse.text();
			const responseHeaders: Record<string, string> = {
				"x-session-id": sessionId,
			};
			webResponse.headers.forEach((v, k) => {
				responseHeaders[k] = v;
			});

			await transport.close();
			await mcp.close();

			return {
				statusCode: webResponse.status,
				headers: responseHeaders,
				body: responseBody,
			};
		};
	}

	// ── Transport: Express ──────────────────────────────────────────

	/**
	 * Create Express route handlers. Call `setup(app)` to mount.
	 *
	 * @example
	 * ```ts
	 * import express from "express";
	 * const app = express();
	 * app.use(express.json());
	 * server.express().setup(app);
	 * app.listen(3000);
	 * ```
	 */
	express(config?: ExpressTransportConfig): {
		setup: (app: ExpressLikeApp) => void;
	} {
		const authProvider = this.#authProvider;
		const baseUrl = config?.baseUrl;
		const resourceMetadata = config?.resourceMetadata;
		const mcpPath = config?.mcpPath ?? "/mcp";

		const authMiddleware = async (
			req: { headers: Record<string, string | string[] | undefined> },
			res: {
				status: (code: number) => {
					set: (headers: Record<string, string>) => { json: (body: unknown) => void };
					json: (body: unknown) => void;
				};
			},
			next: () => void,
		) => {
			if (!authProvider) {
				next();
				return;
			}
			const auth = await authProvider.authenticate({ headers: req.headers });
			if (!auth.authenticated) {
				const wwwAuth = baseUrl ? buildWwwAuthenticateHeader(baseUrl) : 'Bearer realm="mcp-server"';
				res
					.status(401)
					.set({ "WWW-Authenticate": wwwAuth })
					.json({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Authentication required" },
						id: null,
					});
				return;
			}
			next();
		};

		const setup = (app: ExpressLikeApp) => {
			const e = app;

			if (resourceMetadata) {
				e.get("/.well-known/oauth-protected-resource", ((_req: unknown, res: unknown) => {
					(res as { json: (body: unknown) => void }).json(buildResourceMetadata(resourceMetadata));
				}) as (...args: unknown[]) => void);
			}

			e.post(
				mcpPath,
				authMiddleware as unknown as (...args: unknown[]) => void,
				(async (req: unknown, res: unknown) => {
					const mcp = this.#buildSdkServer();
					const { StreamableHTTPServerTransport } = await import(
						"@modelcontextprotocol/sdk/server/streamableHttp.js"
					);
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
					(res as { on: (event: string, fn: () => void) => void }).on("close", () => {
						transport.close();
						mcp.close();
					});
					await mcp.connect(transport);
					await transport.handleRequest(
						req as Parameters<typeof transport.handleRequest>[0],
						res as Parameters<typeof transport.handleRequest>[1],
						(req as { body?: unknown }).body,
					);
				}) as (...args: unknown[]) => void,
			);

			const methodNotAllowed = ((_req: unknown, res: unknown) => {
				(res as { status: (code: number) => { json: (body: unknown) => void } })
					.status(405)
					.json({ error: "Method not allowed" });
			}) as (...args: unknown[]) => void;

			e.get(mcpPath, methodNotAllowed);
			e.delete(mcpPath, methodNotAllowed);
		};

		return { setup };
	}

	// ── Transport: Bun.serve ────────────────────────────────────────

	/**
	 * Start a Bun HTTP server. Zero dependencies — uses Bun.serve() natively.
	 *
	 * @example
	 * ```ts
	 * server.bun({ port: 3000 });
	 * // MCP server running at http://localhost:3000/mcp
	 * ```
	 */
	bun(config?: { port?: number; hostname?: string; mcpPath?: string }): {
		stop: () => void;
		url: string;
	} {
		const port = config?.port ?? 3000;
		const hostname = config?.hostname ?? "localhost";
		const mcpPath = config?.mcpPath ?? "/mcp";
		const authProvider = this.#authProvider;

		const bunServer = Bun.serve({
			port,
			hostname,
			fetch: async (req: Request) => {
				const url = new URL(req.url);

				if (req.method !== "POST" || url.pathname !== mcpPath) {
					return new Response(JSON.stringify({ error: "Use POST " + mcpPath }), {
						status: req.method !== "POST" ? 405 : 404,
						headers: { "Content-Type": "application/json" },
					});
				}

				// Auth
				if (authProvider) {
					const headers: Record<string, string | undefined> = {};
					req.headers.forEach((v, k) => {
						headers[k] = v;
					});
					const auth = await authProvider.authenticate({ headers });
					if (!auth.authenticated) {
						return new Response(
							JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Authentication required" }, id: null }),
							{ status: 401, headers: { "Content-Type": "application/json" } },
						);
					}
				}

				// Stateless MCP handler
				const mcp = this.#buildSdkServer();
				const { WebStandardStreamableHTTPServerTransport } = await import(
					"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
				);
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await mcp.connect(transport);
				const response = await transport.handleRequest(req);
				await transport.close();
				await mcp.close();
				return response;
			},
		});

		return {
			stop: () => bunServer.stop(),
			url: `http://${hostname}:${port}${mcpPath}`,
		};
	}

	// ── Accessors ───────────────────────────────────────────────────

	get config(): McpServerConfig {
		return this.#config;
	}

	get toolCount(): number {
		return this.#tools.size;
	}

	getToolConfig(name: string): ToolConfig | undefined {
		return this.#tools.get(name);
	}

	// ── Deploy ──────────────────────────────────────────────────────

	/**
	 * Deploy this server to AWS Lambda with a Function URL.
	 * Returns the live HTTPS endpoint URL.
	 *
	 * @example
	 * ```ts
	 * const server = new McpServer("my-tools@1.0.0")
	 *   .tool("ping", async () => "pong");
	 *
	 * const { url } = await server.deploy({ entry: "./src/server.ts" });
	 * console.log(`Live at: ${url}`);
	 * ```
	 */
	async deploy(
		config: import("./deploy.js").DeployConfig,
	): Promise<import("./deploy.js").DeployResult> {
		const { deploy } = await import("./deploy.js");
		return deploy({
			...config,
			functionName: config.functionName ?? this.#config.name,
		});
	}

	/**
	 * Destroy a previously deployed Lambda function.
	 */
	async destroy(
		functionName?: string,
		region?: string,
	): Promise<import("./deploy.js").DestroyResult> {
		const { destroy } = await import("./deploy.js");
		return destroy(functionName ?? this.#config.name, region);
	}
}
