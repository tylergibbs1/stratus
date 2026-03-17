// ── Server ──────────────────────────────────────────────────────────
export { McpServer, type LambdaTransportConfig, type ExpressTransportConfig } from "./server.js";

// ── Types ───────────────────────────────────────────────────────────
export type {
	ToolTier,
	ToolConfig,
	ToolHandler,
	ToolHandlerReturn,
	ToolContext,
	ToolResult,
	ToolOptions,
	ContentPart,
	TextContent,
	ImageContent,
	AuthContext,
	Gate,
	GateContext,
	GateResult,
	McpSession,
	SessionStore,
	ToolCallRecord,
	McpServerConfig,
	DisclosureMode,
	DisclosureConfig,
	CodeModeConfig,
} from "./types.js";

// ── Errors ──────────────────────────────────────────────────────────
export {
	McpAwsError,
	GateDeniedError,
	AuthenticationError,
	SessionNotFoundError,
	ToolExecutionError,
	ToolTimeoutError,
} from "./errors.js";

// ── Auth ────────────────────────────────────────────────────────────
export { apiKey, ApiKeyAuth, type ApiKeyAuthConfig, type ApiKeyEntry } from "./auth/api-key.js";
export { cognito, CognitoAuth, type CognitoAuthConfig } from "./auth/cognito.js";
export { chainAuth, type AuthProvider, type AuthRequest } from "./auth/index.js";
export {
	buildResourceMetadata,
	buildWwwAuthenticateHeader,
	type ProtectedResourceMetadata,
	type ResourceMetadataConfig,
} from "./auth/metadata.js";

// ── Gating ──────────────────────────────────────────────────────────
export { role, check, requires, rateLimit } from "./gating/gates.js";
export { all, any } from "./gating/combinators.js";

// ── Sessions ────────────────────────────────────────────────────────
export { MemorySessionStore, type MemorySessionStoreConfig } from "./session/memory.js";
export { DynamoSessionStore, type DynamoSessionStoreConfig } from "./session/dynamo.js";
// SqliteSessionStore uses bun:sqlite — import from "@stratus/mcp-aws/sqlite" to avoid
// pulling bun: imports into Lambda bundles that run on Node.js.
export type { SqliteSessionStoreConfig } from "./session/sqlite.js";

// ── Disclosure ──────────────────────────────────────────────────────
export { SearchIndex, type SearchResult } from "./disclosure/search.js";

// ── Code Mode ───────────────────────────────────────────────────────
export { FunctionExecutor, WorkerExecutor } from "./codemode/executor.js";
export type { Executor, ExecuteResult } from "./codemode/executor.js";

// ── Context (AsyncLocalStorage) ─────────────────────────────────────
export { getAuthContext, getSession } from "./context.js";

// ── SSRF Protection ─────────────────────────────────────────────────
export { isBlockedUrl, assertSafeUrl } from "./ssrf.js";

// ── Events / Observability ──────────────────────────────────────────
export type { McpEventMap, McpEventName } from "./events.js";

// ── Composition ─────────────────────────────────────────────────────
export { codeMcpServer, createMcpHandler, type CodeMcpServerOptions, type CreateMcpHandlerOptions } from "./compose.js";

// ── Deploy ──────────────────────────────────────────────────────────
export {
	deploy,
	destroy,
	type DeployConfig,
	type DeployResult,
	type DestroyResult,
	type VpcConfig,
} from "./deploy.js";
