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
}): FunctionTool<TParams, TContext> {
	return {
		type: "function",
		name: config.name,
		description: config.description,
		parameters: config.parameters,
		execute: config.execute,
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
