import type { Agent } from "./agent";
import type { ModelRequest } from "./model";
import type { RunResult } from "./result";
import type { SubAgent } from "./subagent";
import type { ChatMessage, ToolCall } from "./types";

export type ToolCallDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason?: string }
	| { decision: "modify"; modifiedParams: Record<string, unknown> };

export type HandoffDecision = { decision: "allow" } | { decision: "deny"; reason?: string };

export type ToolMatcher = string | RegExp;

export interface MatchedToolCallHook<TContext = unknown> {
	match: ToolMatcher | ToolMatcher[];
	hook: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		context: TContext;
	}) => undefined | ToolCallDecision | Promise<undefined | ToolCallDecision>;
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
	  }) => undefined | ToolCallDecision | Promise<undefined | ToolCallDecision>)
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
	}) => undefined | HandoffDecision | Promise<undefined | HandoffDecision>;

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

	/** Called before each LLM API call */
	onLlmStart?: (params: {
		agent: Agent<TContext, any>;
		messages: ChatMessage[];
		context: TContext;
	}) => void | Promise<void>;

	/** Called after each LLM API call */
	onLlmEnd?: (params: {
		agent: Agent<TContext, any>;
		response: { content: string | null; toolCallCount: number };
		context: TContext;
	}) => void | Promise<void>;
}

/** Run-level hooks that fire across all agents in a run */
export interface RunHooks<TContext = unknown> {
	/** Called when an agent starts processing (including after handoffs) */
	onAgentStart?: (params: {
		agent: Agent<TContext, any>;
		context: TContext;
	}) => void | Promise<void>;

	/** Called when an agent finishes (before handoff or at end) */
	onAgentEnd?: (params: {
		agent: Agent<TContext, any>;
		output: string;
		context: TContext;
	}) => void | Promise<void>;

	/** Called on every handoff */
	onHandoff?: (params: {
		fromAgent: Agent<TContext, any>;
		toAgent: Agent<TContext, any>;
		context: TContext;
	}) => void | Promise<void>;

	/** Called before every tool execution */
	onToolStart?: (params: {
		agent: Agent<TContext, any>;
		toolName: string;
		context: TContext;
	}) => void | Promise<void>;

	/** Called after every tool execution */
	onToolEnd?: (params: {
		agent: Agent<TContext, any>;
		toolName: string;
		result: string;
		context: TContext;
	}) => void | Promise<void>;

	/** Called before every LLM API call */
	onLlmStart?: (params: {
		agent: Agent<TContext, any>;
		request: ModelRequest;
		context: TContext;
	}) => void | Promise<void>;

	/** Called after every LLM API call */
	onLlmEnd?: (params: {
		agent: Agent<TContext, any>;
		response: { content: string | null; toolCallCount: number };
		context: TContext;
	}) => void | Promise<void>;
}
