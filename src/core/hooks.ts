import type { Agent } from "./agent";
import type { RunResult } from "./result";
import type { ToolCall } from "./types";

export type ToolCallDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string }
	| { decision: "modify"; modifiedParams: Record<string, unknown> };

export type HandoffDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string };

export interface AgentHooks<TContext = unknown> {
	beforeRun?: (params: {
		agent: Agent<TContext, any>;
		input: string;
		context: TContext;
	}) => void | Promise<void>;

	afterRun?: (params: {
		agent: Agent<TContext, any>;
		result: RunResult<any>;
		context: TContext;
	}) => void | Promise<void>;

	beforeToolCall?: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		context: TContext;
	}) => void | ToolCallDecision | Promise<void | ToolCallDecision>;

	afterToolCall?: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		result: string;
		context: TContext;
	}) => void | Promise<void>;

	beforeHandoff?: (params: {
		fromAgent: Agent<TContext, any>;
		toAgent: Agent<TContext, any>;
		context: TContext;
	}) => void | HandoffDecision | Promise<void | HandoffDecision>;
}
