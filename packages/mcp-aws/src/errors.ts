import type { Gate } from "./types.js";

export class McpAwsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpAwsError";
	}
}

export class GateDeniedError extends McpAwsError {
	readonly toolName: string;
	readonly reason: string;
	readonly hint?: string;
	readonly gate?: Gate;

	constructor(opts: { toolName: string; reason: string; hint?: string; gate?: Gate }) {
		super(`Gate denied for tool "${opts.toolName}": ${opts.reason}`);
		this.name = "GateDeniedError";
		this.toolName = opts.toolName;
		this.reason = opts.reason;
		this.hint = opts.hint;
		this.gate = opts.gate;
	}
}

export class AuthenticationError extends McpAwsError {
	constructor(message: string) {
		super(message);
		this.name = "AuthenticationError";
	}
}

export class SessionNotFoundError extends McpAwsError {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session not found: ${sessionId}`);
		this.name = "SessionNotFoundError";
		this.sessionId = sessionId;
	}
}

export class ToolExecutionError extends McpAwsError {
	readonly toolName: string;
	override readonly cause: unknown;

	constructor(toolName: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Tool "${toolName}" execution failed: ${message}`);
		this.name = "ToolExecutionError";
		this.toolName = toolName;
		this.cause = cause;
	}
}

export class ToolTimeoutError extends McpAwsError {
	readonly toolName: string;
	readonly timeoutMs: number;

	constructor(toolName: string, timeoutMs: number) {
		super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
		this.name = "ToolTimeoutError";
		this.toolName = toolName;
		this.timeoutMs = timeoutMs;
	}
}
