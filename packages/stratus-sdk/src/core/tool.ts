import type { z } from "zod";
import type { ToolDefinition } from "./types";
import { zodToJsonSchema } from "./utils/zod";

export interface ToolExecuteOptions {
	signal?: AbortSignal;
	onStreamEvent?: (event: import("./model").StreamEvent) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FunctionTool<TParams = any, TContext = any> {
	type: "function";
	name: string;
	description: string;
	parameters: z.ZodType<TParams>;
	execute: (
		context: TContext,
		params: TParams,
		options?: ToolExecuteOptions,
	) => Promise<string> | string;
	/** Timeout in milliseconds. If the tool doesn't complete in time, a ToolTimeoutError is thrown. */
	timeout?: number;
	/** If false or returns false, the tool is excluded from the tools list sent to the LLM. */
	isEnabled?: boolean | ((context: TContext) => boolean | Promise<boolean>);
	/** If true or returns true, the run loop pauses for approval before executing this tool. */
	needsApproval?: boolean | ((params: TParams, context: TContext) => boolean | Promise<boolean>);
	/** Retry configuration for transient tool failures. */
	retries?: {
		/** Maximum number of retry attempts (default: 0 = no retries). */
		limit: number;
		/** Base delay in ms between retries (default: 1000). */
		delay?: number;
		/** Backoff strategy (default: "exponential"). */
		backoff?: "fixed" | "exponential";
		/** Predicate to decide if the error is retryable. Defaults to retrying all errors. */
		shouldRetry?: (error: unknown) => boolean;
	};
	/** Raw JSON Schema override. When set, toolToDefinition uses this instead of zodToJsonSchema. Used by McpClient. */
	_rawJsonSchema?: Record<string, unknown>;
}

export function tool<TParams, TContext = unknown>(config: {
	name: string;
	description: string;
	parameters: z.ZodType<TParams>;
	execute: (
		context: TContext,
		params: TParams,
		options?: ToolExecuteOptions,
	) => Promise<string> | string;
	timeout?: number;
	isEnabled?: boolean | ((context: TContext) => boolean | Promise<boolean>);
	needsApproval?: boolean | ((params: TParams, context: TContext) => boolean | Promise<boolean>);
	retries?: FunctionTool<TParams, TContext>["retries"];
}): FunctionTool<TParams, TContext> {
	return {
		type: "function",
		name: config.name,
		description: config.description,
		parameters: config.parameters,
		execute: config.execute,
		timeout: config.timeout,
		isEnabled: config.isEnabled,
		needsApproval: config.needsApproval,
		retries: config.retries,
	};
}

export function toolToDefinition(t: FunctionTool): ToolDefinition {
	return {
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: t._rawJsonSchema ?? zodToJsonSchema(t.parameters),
		},
	};
}
