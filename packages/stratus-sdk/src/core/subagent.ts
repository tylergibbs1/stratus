import type { z } from "zod";
import type { Agent } from "./agent";
import type { Model } from "./model";
import { run } from "./run";
import type { FunctionTool, ToolExecuteOptions } from "./tool";
import type { ToolDefinition } from "./types";
import { zodToJsonSchema } from "./utils/zod";

export interface SubAgentConfig<TParent = any, TChild = any, TChildOutput = undefined> {
	agent: Agent<TChild, TChildOutput>;
	toolName?: string;
	toolDescription?: string;
	inputSchema: z.ZodType<any>;
	mapInput: (params: any) => string;
	mapContext?: (parentContext: TParent) => TChild;
	maxTurns?: number;
	model?: Model;
}

export interface SubAgent<TParent = any, TChild = any, TChildOutput = undefined> {
	type: "subagent";
	agent: Agent<TChild, TChildOutput>;
	toolName: string;
	toolDescription: string;
	inputSchema: z.ZodType<any>;
	mapInput: (params: any) => string;
	mapContext?: (parentContext: TParent) => TChild;
	maxTurns?: number;
	model?: Model;
}

export function subagent<TParent = any, TChild = any, TChildOutput = undefined>(
	config: SubAgentConfig<TParent, TChild, TChildOutput>,
): SubAgent<TParent, TChild, TChildOutput> {
	return {
		type: "subagent",
		agent: config.agent,
		toolName: config.toolName ?? `run_${config.agent.name}`,
		toolDescription: config.toolDescription ?? `Run the ${config.agent.name} sub-agent`,
		inputSchema: config.inputSchema,
		mapInput: config.mapInput,
		mapContext: config.mapContext,
		maxTurns: config.maxTurns,
		model: config.model,
	};
}

export function subagentToDefinition(sa: SubAgent): ToolDefinition {
	return {
		type: "function",
		function: {
			name: sa.toolName,
			description: sa.toolDescription,
			parameters: zodToJsonSchema(sa.inputSchema),
		},
	};
}

export function subagentToTool<TParent>(sa: SubAgent<TParent>): FunctionTool<any, TParent> {
	return {
		type: "function",
		name: sa.toolName,
		description: sa.toolDescription,
		parameters: sa.inputSchema,
		execute: async (
			parentContext: TParent,
			params: any,
			options?: ToolExecuteOptions,
		): Promise<string> => {
			const childInput = sa.mapInput(params);
			const childContext = sa.mapContext ? sa.mapContext(parentContext) : undefined;
			const model = sa.model ?? sa.agent.model;

			try {
				const result = await run(sa.agent, childInput, {
					context: childContext,
					model,
					maxTurns: sa.maxTurns,
					signal: options?.signal,
				});
				if (result.interrupted) {
					return `Sub-agent "${sa.agent.name}" was interrupted waiting for tool approval`;
				}
				return result.output;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error in sub-agent "${sa.agent.name}": ${message}`;
			}
		},
	};
}
