import { Agent } from "./agent";
import type { ToolDefinition } from "./types";

export interface HandoffConfig<TContext = unknown> {
	agent: Agent<TContext>;
	toolName?: string;
	toolDescription?: string;
	onHandoff?: (context: TContext) => void | Promise<void>;
}

export interface Handoff<TContext = unknown> {
	type: "handoff";
	agent: Agent<TContext>;
	toolName: string;
	toolDescription: string;
	onHandoff?: (context: TContext) => void | Promise<void>;
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
	};
}

export function handoffToDefinition(h: Handoff): ToolDefinition {
	return {
		type: "function",
		function: {
			name: h.toolName,
			description: h.toolDescription,
			parameters: { type: "object", properties: {} },
		},
	};
}
