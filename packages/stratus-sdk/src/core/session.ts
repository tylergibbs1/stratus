import type { z } from "zod";
import { Agent, type HandoffInput, type Instructions } from "./agent";
import type { CostEstimator } from "./cost";
import { StratusError } from "./errors";
import type {
	InputGuardrail,
	OutputGuardrail,
	ToolInputGuardrail,
	ToolOutputGuardrail,
} from "./guardrails";
import type { AgentHooks, RunHooks } from "./hooks";
import type { AgentTool } from "./hosted-tool";
import type { Model, StreamEvent } from "./model";
import type { RunResult } from "./result";
import { stream as coreStream } from "./run";
import type { CallModelInputFilter, CanUseTool, ToolErrorFormatter } from "./run";
import type { SubAgent } from "./subagent";
import type { ChatMessage, ContentPart, ModelSettings, ToolUseBehavior } from "./types";

export type SessionStateChangeEvent =
	| { type: "message_added"; message: ChatMessage }
	| { type: "stream_start" }
	| { type: "stream_end" }
	| { type: "saved"; sessionId: string };

export type SessionStateChangeListener = (event: SessionStateChangeEvent) => void;

/** Pluggable persistence backend for session state. */
export interface SessionStore {
	/** Save a session snapshot. */
	save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;
	/** Load a session snapshot. Returns undefined if not found. */
	load(sessionId: string): Promise<SessionSnapshot | undefined>;
	/** Delete a session. */
	delete(sessionId: string): Promise<void>;
	/** List all session IDs. */
	list?(): Promise<string[]>;
}

export interface SessionConfig<TContext = unknown, TOutput = undefined> {
	model: Model;
	instructions?: Instructions<TContext>;
	tools?: AgentTool[];
	subagents?: SubAgent[];
	modelSettings?: ModelSettings;
	outputType?: z.ZodType<TOutput>;
	handoffs?: HandoffInput<TContext>[];
	inputGuardrails?: InputGuardrail<TContext>[];
	outputGuardrails?: OutputGuardrail<TContext>[];
	hooks?: AgentHooks<TContext>;
	toolUseBehavior?: ToolUseBehavior;
	context?: TContext;
	maxTurns?: number;
	costEstimator?: CostEstimator;
	maxBudgetUsd?: number;
	runHooks?: RunHooks<TContext>;
	toolErrorFormatter?: ToolErrorFormatter;
	callModelInputFilter?: CallModelInputFilter<TContext>;
	toolInputGuardrails?: ToolInputGuardrail<TContext>[];
	toolOutputGuardrails?: ToolOutputGuardrail<TContext>[];
	resetToolChoice?: boolean;
	/** Restrict which tools are available. Supports glob wildcards (e.g. "mcp__github__*"). */
	allowedTools?: string[];
	/** Centralized permission callback invoked before any tool executes. */
	canUseTool?: CanUseTool<TContext>;
	/** Enable debug logging to stderr. */
	debug?: boolean;
	/** Optional persistence backend. When set, sessions auto-save after each interaction. */
	store?: SessionStore;
	/** Session ID for persistence. Auto-generated if not provided. */
	sessionId?: string;
	/** Callback fired when session state changes. Useful for UI frameworks. */
	onStateChange?: SessionStateChangeListener;
}

export interface SessionSnapshot {
	id: string;
	messages: ChatMessage[];
}

export class Session<TContext = unknown, TOutput = undefined> {
	readonly id: string;

	private readonly _agent: Agent<TContext, TOutput>;
	private readonly _context: TContext | undefined;
	private readonly _maxTurns: number | undefined;
	private readonly _costEstimator: CostEstimator | undefined;
	private readonly _maxBudgetUsd: number | undefined;
	private readonly _hooks: AgentHooks<TContext> | undefined;
	private readonly _runHooks: RunHooks<TContext> | undefined;
	private readonly _toolErrorFormatter: ToolErrorFormatter | undefined;
	private readonly _callModelInputFilter: CallModelInputFilter<TContext> | undefined;
	private readonly _toolInputGuardrails: ToolInputGuardrail<TContext>[];
	private readonly _toolOutputGuardrails: ToolOutputGuardrail<TContext>[];
	private readonly _resetToolChoice: boolean | undefined;
	private readonly _allowedTools: string[] | undefined;
	private readonly _canUseTool: CanUseTool<TContext> | undefined;
	private readonly _debug: boolean;
	private readonly _store: SessionStore | undefined;
	private readonly _onStateChange: SessionStateChangeListener | undefined;
	private _messages: ChatMessage[] = [];
	private _resultPromise: Promise<RunResult<TOutput>> | null = null;
	private _streaming = false;
	private _closed = false;
	private _started = false;

	constructor(
		config: SessionConfig<TContext, TOutput>,
		restore?: { id?: string; messages?: ChatMessage[] },
	) {
		this.id = restore?.id ?? config.sessionId ?? crypto.randomUUID();
		this._context = config.context;
		this._maxTurns = config.maxTurns;
		this._costEstimator = config.costEstimator;
		this._maxBudgetUsd = config.maxBudgetUsd;
		this._hooks = config.hooks;
		this._runHooks = config.runHooks;
		this._toolErrorFormatter = config.toolErrorFormatter;
		this._callModelInputFilter = config.callModelInputFilter;
		this._toolInputGuardrails = config.toolInputGuardrails ?? [];
		this._toolOutputGuardrails = config.toolOutputGuardrails ?? [];
		this._resetToolChoice = config.resetToolChoice;
		this._allowedTools = config.allowedTools;
		this._canUseTool = config.canUseTool;
		this._debug = config.debug ?? false;
		this._store = config.store;
		this._onStateChange = config.onStateChange;
		this._agent = new Agent<TContext, TOutput>({
			name: "session_agent",
			model: config.model,
			instructions: config.instructions,
			tools: config.tools,
			subagents: config.subagents,
			modelSettings: config.modelSettings,
			outputType: config.outputType,
			handoffs: config.handoffs,
			inputGuardrails: config.inputGuardrails,
			outputGuardrails: config.outputGuardrails,
			hooks: config.hooks,
			toolUseBehavior: config.toolUseBehavior,
		});

		if (restore?.messages) {
			this._messages = structuredClone(restore.messages);
		}
	}

	send(message: string | ContentPart[]): void {
		if (this._closed) throw new StratusError("Session is closed");
		const msg: ChatMessage = { role: "user", content: message };
		this._messages.push(msg);
		this._onStateChange?.({ type: "message_added", message: msg });
		this._resultPromise = null;
	}

	stream(options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
		if (this._closed) throw new StratusError("Session is closed");
		if (this._streaming)
			throw new StratusError("Already streaming. Consume the current stream first.");
		return this._streamInternal(options?.signal);
	}

	async wait(options?: { signal?: AbortSignal }): Promise<RunResult<TOutput>> {
		if (this._resultPromise && !this._streaming) {
			throw new StratusError("No new message to process. Call send() before wait().");
		}
		for await (const _event of this.stream(options)) {
			// drain
		}
		return this.result;
	}

	get result(): Promise<RunResult<TOutput>> {
		if (!this._resultPromise) {
			throw new StratusError("No pending result. Call stream() first.");
		}
		return this._resultPromise;
	}

	get messages(): ChatMessage[] {
		return [...this._messages];
	}

	save(): SessionSnapshot {
		if (this._closed) throw new StratusError("Session is closed");
		if (this._streaming) throw new StratusError("Cannot save while streaming");
		return {
			id: this.id,
			messages: structuredClone(this._messages),
		};
	}

	/** Add tools to the session's agent at runtime (e.g. from a newly connected MCP client). */
	addTools(tools: AgentTool[]): void {
		if (this._closed) throw new StratusError("Session is closed");
		if (this._streaming) throw new StratusError("Cannot modify tools while streaming");
		(this._agent.tools as AgentTool[]).push(...tools);
	}

	/** Remove tools by name from the session's agent at runtime. */
	removeTools(toolNames: string[]): void {
		if (this._closed) throw new StratusError("Session is closed");
		if (this._streaming) throw new StratusError("Cannot modify tools while streaming");
		const nameSet = new Set(toolNames);
		const tools = this._agent.tools as AgentTool[];
		for (let i = tools.length - 1; i >= 0; i--) {
			const t = tools[i]!;
			const name = t.type === "function" ? t.name : (t as any).definition?.type;
			if (name && nameSet.has(name)) {
				tools.splice(i, 1);
			}
		}
	}

	/** Replace all tools on the session's agent. */
	setTools(tools: AgentTool[]): void {
		if (this._closed) throw new StratusError("Session is closed");
		if (this._streaming) throw new StratusError("Cannot modify tools while streaming");
		(this._agent.tools as AgentTool[]).length = 0;
		(this._agent.tools as AgentTool[]).push(...tools);
	}

	close(): void {
		this._closed = true;
		this._messages = [];
		this._resultPromise = null;
		this._streaming = false;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.close();
	}

	private async *_streamInternal(signal?: AbortSignal): AsyncGenerator<StreamEvent> {
		this._streaming = true;
		this._onStateChange?.({ type: "stream_start" });

		// Fire onSessionStart on first stream
		if (!this._started) {
			this._started = true;
			if (this._hooks?.onSessionStart) {
				await this._hooks.onSessionStart({ context: this._context as TContext });
			}
		}

		let streamError = false;
		try {
			const { stream: s, result: resultPromise } = coreStream(this._agent, [...this._messages], {
				context: this._context,
				maxTurns: this._maxTurns,
				signal,
				costEstimator: this._costEstimator,
				maxBudgetUsd: this._maxBudgetUsd,
				runHooks: this._runHooks,
				toolErrorFormatter: this._toolErrorFormatter,
				callModelInputFilter: this._callModelInputFilter,
				toolInputGuardrails:
					this._toolInputGuardrails.length > 0 ? this._toolInputGuardrails : undefined,
				toolOutputGuardrails:
					this._toolOutputGuardrails.length > 0 ? this._toolOutputGuardrails : undefined,
				resetToolChoice: this._resetToolChoice,
				allowedTools: this._allowedTools,
				canUseTool: this._canUseTool,
				debug: this._debug,
			});

			this._resultPromise = resultPromise.then((result) => {
				const oldLength = this._messages.length;
				this._messages = result.messages.filter((m) => m.role !== "system");
				// Emit message_added for new messages beyond what we already had
				if (this._onStateChange) {
					for (let i = oldLength; i < this._messages.length; i++) {
						this._onStateChange({ type: "message_added", message: this._messages[i]! });
					}
				}
				return result;
			});
			// Prevent unhandled rejection if user doesn't await .result
			this._resultPromise.catch(() => {});

			for await (const event of s) {
				yield event;
			}

			await this._resultPromise;
		} catch (err) {
			streamError = true;
			throw err;
		} finally {
			this._streaming = false;

			try {
				if (!streamError && this._store && !this._closed) {
					await this._store.save(this.id, this.save());
					this._onStateChange?.({ type: "saved", sessionId: this.id });
				}
			} catch {
				// Don't let save failures prevent stream_end
			}

			this._onStateChange?.({ type: "stream_end" });

			// Fire onSessionEnd in finally
			if (this._hooks?.onSessionEnd) {
				await this._hooks.onSessionEnd({ context: this._context as TContext });
			}
		}
	}
}

export function createSession<TContext = unknown, TOutput = undefined>(
	config: SessionConfig<TContext, TOutput>,
): Session<TContext, TOutput> {
	return new Session(config);
}

export function resumeSession<TContext = unknown, TOutput = undefined>(
	snapshot: SessionSnapshot,
	config: SessionConfig<TContext, TOutput>,
): Session<TContext, TOutput> {
	return new Session(config, {
		id: snapshot.id,
		messages: structuredClone(snapshot.messages),
	});
}

export function forkSession<TContext = unknown, TOutput = undefined>(
	snapshot: SessionSnapshot,
	config: SessionConfig<TContext, TOutput>,
): Session<TContext, TOutput> {
	return new Session(config, {
		messages: structuredClone(snapshot.messages),
	});
}

export async function loadSession<TContext = unknown, TOutput = undefined>(
	store: SessionStore,
	sessionId: string,
	config: SessionConfig<TContext, TOutput>,
): Promise<Session<TContext, TOutput> | undefined> {
	const snapshot = await store.load(sessionId);
	if (!snapshot) return undefined;
	return resumeSession(snapshot, { ...config, store });
}

export async function prompt<TContext = unknown, TOutput = undefined>(
	input: string | ContentPart[],
	config: SessionConfig<TContext, TOutput>,
): Promise<RunResult<TOutput>> {
	const session = createSession(config);
	session.send(input);

	for await (const _event of session.stream()) {
		// Drain the stream
	}

	return session.result;
}
