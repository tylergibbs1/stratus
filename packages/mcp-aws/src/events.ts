/**
 * Typed observability events for MCP server lifecycle.
 *
 * @example
 * ```ts
 * const server = new McpServer("my-server@1.0.0");
 *
 * server.on("tool:call", (e) => {
 *   console.log(`Tool ${e.toolName} called by ${e.auth.subject}`);
 * });
 *
 * server.on("tool:result", (e) => {
 *   console.log(`Tool ${e.toolName} completed in ${e.durationMs}ms`);
 * });
 *
 * server.on("auth:success", (e) => {
 *   console.log(`User ${e.auth.subject} authenticated`);
 * });
 * ```
 */
import type { AuthContext } from "./types.js";

export type McpEventMap = {
	/** Emitted when a tool is called */
	"tool:call": {
		toolName: string;
		params: unknown;
		auth: AuthContext;
		sessionId: string;
		timestamp: number;
	};
	/** Emitted after a tool returns (success or error) */
	"tool:result": {
		toolName: string;
		durationMs: number;
		isError: boolean;
		auth: AuthContext;
		sessionId: string;
		timestamp: number;
	};
	/** Emitted when a gate denies a tool call */
	"gate:denied": {
		toolName: string;
		reason: string;
		auth: AuthContext;
		sessionId: string;
		timestamp: number;
	};
	/** Emitted on successful authentication */
	"auth:success": {
		auth: AuthContext;
		timestamp: number;
	};
	/** Emitted on authentication failure */
	"auth:failure": {
		timestamp: number;
	};
	/** Emitted when search_tools promotes tools */
	"tools:promoted": {
		toolNames: string[];
		query: string;
		sessionId: string;
		timestamp: number;
	};
	/** Emitted when a gate unlock promotes hidden tools */
	"tools:unlocked": {
		toolNames: string[];
		prerequisite: string;
		sessionId: string;
		timestamp: number;
	};
	/** Emitted when deploy() is called */
	"deploy:start": {
		functionName: string;
		region: string;
		timestamp: number;
	};
	/** Emitted after deploy() completes */
	"deploy:complete": {
		functionName: string;
		url: string;
		region: string;
		durationMs: number;
		timestamp: number;
	};
};

export type McpEventName = keyof McpEventMap;

export class McpEventEmitter {
	#listeners = new Map<string, Set<(event: unknown) => void>>();

	on<K extends McpEventName>(event: K, listener: (data: McpEventMap[K]) => void): void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener as (event: unknown) => void);
	}

	off<K extends McpEventName>(event: K, listener: (data: McpEventMap[K]) => void): void {
		this.#listeners.get(event)?.delete(listener as (event: unknown) => void);
	}

	emit<K extends McpEventName>(event: K, data: McpEventMap[K]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const listener of set) {
			try {
				listener(data);
			} catch {
				// Don't let listener errors break the server
			}
		}
	}
}
