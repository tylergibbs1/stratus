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
type HookResult<T = void> = T | Promise<T>;
type NotificationHookResult = unknown | Promise<unknown>;

export type ToolMatcher = string | RegExp;

export interface MatchedToolCallHook<TContext = unknown> {
	match: ToolMatcher | ToolMatcher[];
	hook: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		context: TContext;
	}) => HookResult<void | ToolCallDecision | undefined>;
}

export interface MatchedAfterToolCallHook<TContext = unknown> {
	match: ToolMatcher | ToolMatcher[];
	hook: (params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		result: string;
		context: TContext;
	}) => NotificationHookResult;
}

export type BeforeToolCallHook<TContext = unknown> =
	| ((params: {
			agent: Agent<TContext, any>;
			toolCall: ToolCall;
			context: TContext;
	  }) => HookResult<void | ToolCallDecision | undefined>)
	| MatchedToolCallHook<TContext>[];

export type AfterToolCallHook<TContext = unknown> =
	| ((params: {
			agent: Agent<TContext, any>;
			toolCall: ToolCall;
			result: string;
			context: TContext;
	  }) => NotificationHookResult)
	| MatchedAfterToolCallHook<TContext>[];

export interface AgentHooks<TContext = unknown> {
	beforeRun?: (params: {
		agent: Agent<TContext, any>;
		input: string;
		context: TContext;
	}) => NotificationHookResult;

	afterRun?: (params: {
		agent: Agent<TContext, any>;
		result: RunResult<any>;
		context: TContext;
	}) => NotificationHookResult;

	beforeToolCall?: BeforeToolCallHook<TContext>;

	afterToolCall?: AfterToolCallHook<TContext>;

	beforeHandoff?: (params: {
		fromAgent: Agent<TContext, any>;
		toAgent: Agent<TContext, any>;
		context: TContext;
	}) => HookResult<void | HandoffDecision | undefined>;

	onStop?: (params: {
		agent: Agent<TContext, any>;
		context: TContext;
		reason: "max_turns" | "max_budget";
	}) => NotificationHookResult;

	onSubagentStart?: (params: {
		agent: Agent<TContext, any>;
		subagent: SubAgent;
		context: TContext;
	}) => NotificationHookResult;

	onSubagentStop?: (params: {
		agent: Agent<TContext, any>;
		subagent: SubAgent;
		result: string;
		context: TContext;
	}) => NotificationHookResult;

	onSessionStart?: (params: { context: TContext }) => NotificationHookResult;

	onSessionEnd?: (params: { context: TContext }) => NotificationHookResult;

	/** Called before each LLM API call */
	onLlmStart?: (params: {
		agent: Agent<TContext, any>;
		messages: ChatMessage[];
		context: TContext;
	}) => NotificationHookResult;

	/** Called after each LLM API call */
	onLlmEnd?: (params: {
		agent: Agent<TContext, any>;
		response: { content: string | null; toolCallCount: number };
		context: TContext;
	}) => NotificationHookResult;
}

/** Run-level hooks that fire across all agents in a run */
export interface RunHooks<TContext = unknown> {
	/** Called when an agent starts processing (including after handoffs) */
	onAgentStart?: (params: {
		agent: Agent<TContext, any>;
		context: TContext;
	}) => NotificationHookResult;

	/** Called when an agent finishes (before handoff or at end) */
	onAgentEnd?: (params: {
		agent: Agent<TContext, any>;
		output: string;
		context: TContext;
	}) => NotificationHookResult;

	/** Called on every handoff */
	onHandoff?: (params: {
		fromAgent: Agent<TContext, any>;
		toAgent: Agent<TContext, any>;
		context: TContext;
	}) => NotificationHookResult;

	/** Called before every tool execution */
	onToolStart?: (params: {
		agent: Agent<TContext, any>;
		toolName: string;
		context: TContext;
	}) => NotificationHookResult;

	/** Called after every tool execution */
	onToolEnd?: (params: {
		agent: Agent<TContext, any>;
		toolName: string;
		result: string;
		context: TContext;
	}) => NotificationHookResult;

	/** Called before every LLM API call */
	onLlmStart?: (params: {
		agent: Agent<TContext, any>;
		request: ModelRequest;
		context: TContext;
	}) => NotificationHookResult;

	/** Called after every LLM API call */
	onLlmEnd?: (params: {
		agent: Agent<TContext, any>;
		response: { content: string | null; toolCallCount: number };
		context: TContext;
	}) => NotificationHookResult;
}
