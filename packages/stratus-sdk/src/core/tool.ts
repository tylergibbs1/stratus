import type { z } from "zod";
import type { ToolDefinition } from "./types";
import { zodToJsonSchema } from "./utils/zod";

export interface ToolExecuteOptions {
	signal?: AbortSignal;
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
}): FunctionTool<TParams, TContext> {
	return {
		type: "function",
		name: config.name,
		description: config.description,
		parameters: config.parameters,
		execute: config.execute,
		timeout: config.timeout,
		isEnabled: config.isEnabled,
	};
}

export function toolToDefinition(t: FunctionTool): ToolDefinition {
	return {
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: zodToJsonSchema(t.parameters),
		},
	};
}
