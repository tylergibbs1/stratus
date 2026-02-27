import type { z } from "zod";
import { Agent } from "./agent";
import type { ChatMessage, ToolDefinition } from "./types";
import { zodToJsonSchema } from "./utils/zod";

export interface HandoffInputData {
	/** The full conversation history before the handoff */
	history: ChatMessage[];
	/** The input from the LLM's tool call (parsed if inputType is set) */
	input?: unknown;
}

export type HandoffInputFilter = (data: HandoffInputData) => ChatMessage[];

export interface HandoffConfig<TContext = unknown> {
	agent: Agent<TContext>;
	toolName?: string;
	toolDescription?: string;
	onHandoff?: (context: TContext) => void | Promise<void>;
	/** Zod schema for structured input the LLM can send with the handoff */
	inputType?: z.ZodType;
	/** Transform conversation history passed to the next agent */
	inputFilter?: HandoffInputFilter;
	/** If false or returns false, the handoff is excluded from tools sent to the LLM */
	isEnabled?: boolean | ((context: TContext) => boolean | Promise<boolean>);
}

export interface Handoff<TContext = unknown> {
	type: "handoff";
	agent: Agent<TContext>;
	toolName: string;
	toolDescription: string;
	onHandoff?: (context: TContext) => void | Promise<void>;
	inputType?: z.ZodType;
	inputFilter?: HandoffInputFilter;
	isEnabled?: boolean | ((context: TContext) => boolean | Promise<boolean>);
}

export function handoff<TContext = unknown>(
	agentOrConfig: Agent<TContext> | HandoffConfig<TContext>,
): Handoff<TContext> {
	if (agentOrConfig instanceof Agent) {
		return {
			type: "handoff",
			agent: agentOrConfig,
			toolName: `transfer_to_${agentOrConfig.name}`,
			toolDescription: agentOrConfig.handoffDescription ?? `Transfer to ${agentOrConfig.name}`,
		};
	}

	const config = agentOrConfig;
	return {
		type: "handoff",
		agent: config.agent,
		toolName: config.toolName ?? `transfer_to_${config.agent.name}`,
		toolDescription:
			config.toolDescription ??
			config.agent.handoffDescription ??
			`Transfer to ${config.agent.name}`,
		onHandoff: config.onHandoff,
		inputType: config.inputType,
		inputFilter: config.inputFilter,
		isEnabled: config.isEnabled,
	};
}

export function handoffToDefinition(h: Handoff): ToolDefinition {
	const parameters = h.inputType
		? zodToJsonSchema(h.inputType)
		: { type: "object", properties: {} };

	return {
		type: "function",
		function: {
			name: h.toolName,
			description: h.toolDescription,
			parameters,
		},
	};
}
