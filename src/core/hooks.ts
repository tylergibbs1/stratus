import type { Agent } from "./agent";
import type { RunResult } from "./result";
import type { SubAgent } from "./subagent";
import type { ToolCall } from "./types";

export type ToolCallDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string }
	| { decision: "modify"; modifiedParams: Record<string, unknown> };

export type HandoffDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string };

export type ToolMatcher = string | RegExp;

export interface MatchedToolCallHook<TContext = unknown> {
	match: ToolMatcher | ToolMatcher[];
	hook: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		context: TContext;
	}) => void | ToolCallDecision | Promise<void | ToolCallDecision>;
}

export interface MatchedAfterToolCallHook<TContext = unknown> {
	match: ToolMatcher | ToolMatcher[];
	hook: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		result: string;
		context: TContext;
	}) => void | Promise<void>;
}

export type BeforeToolCallHook<TContext = unknown> =
	| ((params: {
			agent: Agent<TContext, any>;
			toolCall: ToolCall;
			context: TContext;
		}) => void | ToolCallDecision | Promise<void | ToolCallDecision>)
	| MatchedToolCallHook<TContext>[];

export type AfterToolCallHook<TContext = unknown> =
	| ((params: {
			agent: Agent<TContext, any>;
			toolCall: ToolCall;
			result: string;
			context: TContext;
		}) => void | Promise<void>)
	| MatchedAfterToolCallHook<TContext>[];

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

	beforeToolCall?: BeforeToolCallHook<TContext>;

	afterToolCall?: AfterToolCallHook<TContext>;

	beforeHandoff?: (params: {
		fromAgent: Agent<TContext, any>;
		toAgent: Agent<TContext, any>;
		context: TContext;
	}) => void | HandoffDecision | Promise<void | HandoffDecision>;

	onStop?: (params: {
		agent: Agent<TContext, any>;
		context: TContext;
		reason: "max_turns" | "max_budget";
	}) => void | Promise<void>;

	onSubagentStart?: (params: {
		agent: Agent<TContext, any>;
		subagent: SubAgent;
		context: TContext;
	}) => void | Promise<void>;

	onSubagentStop?: (params: {
		agent: Agent<TContext, any>;
		subagent: SubAgent;
		result: string;
		context: TContext;
	}) => void | Promise<void>;

	onSessionStart?: (params: {
		context: TContext;
	}) => void | Promise<void>;

	onSessionEnd?: (params: {
		context: TContext;
	}) => void | Promise<void>;
}
