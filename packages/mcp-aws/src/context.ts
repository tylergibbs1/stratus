/**
 * AsyncLocalStorage-based auth and session context.
 * Tool handlers can call getAuthContext() / getSession() without explicit parameters.
 *
 * @example
 * ```ts
 * import { getAuthContext, getSession } from "@stratus/mcp-aws";
 *
 * server.tool("my_tool", async () => {
 *   const auth = getAuthContext(); // no params needed
 *   if (!auth.authenticated) return "Not logged in";
 *   return `Hello, ${auth.subject}!`;
 * });
 * ```
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthContext, McpSession } from "./types.js";

type RequestContext = {
	auth: AuthContext;
	session: McpSession;
};

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function with auth/session context available via getAuthContext()/getSession().
 * Called internally by the server's tool handler wrapper.
 */
export function withContext<T>(ctx: RequestContext, fn: () => T | Promise<T>): T | Promise<T> {
	return storage.run(ctx, fn);
}

/**
 * Get the current request's auth context from anywhere in the call stack.
 * Returns unauthenticated context if called outside a request.
 */
export function getAuthContext(): AuthContext {
	return storage.getStore()?.auth ?? { authenticated: false, roles: [], claims: {} };
}

/**
 * Get the current request's session from anywhere in the call stack.
 * Returns undefined if called outside a request.
 */
export function getSession(): McpSession | undefined {
	return storage.getStore()?.session;
}
