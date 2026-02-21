import type { z } from "zod";
import { Agent, type HandoffInput, type Instructions } from "./agent";
import type { CostEstimator } from "./cost";
import { StratusError } from "./errors";
import type { InputGuardrail, OutputGuardrail } from "./guardrails";
import type { AgentHooks } from "./hooks";
import type { Model, StreamEvent } from "./model";
import type { RunResult } from "./result";
import { stream as coreStream } from "./run";
import type { SubAgent } from "./subagent";
import type { FunctionTool } from "./tool";
import type { ChatMessage, ContentPart, ModelSettings, ToolUseBehavior } from "./types";

export interface SessionConfig<TContext = unknown, TOutput = undefined> {
	model: Model;
	instructions?: Instructions<TContext>;
	tools?: FunctionTool[];
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
	private _messages: ChatMessage[] = [];
	private _resultPromise: Promise<RunResult<TOutput>> | null = null;
	private _streaming = false;
	private _closed = false;
	private _started = false;

	constructor(
		config: SessionConfig<TContext, TOutput>,
		restore?: { id?: string; messages?: ChatMessage[] },
	) {
		this.id = restore?.id ?? crypto.randomUUID();
		this._context = config.context;
		this._maxTurns = config.maxTurns;
		this._costEstimator = config.costEstimator;
		this._maxBudgetUsd = config.maxBudgetUsd;
		this._hooks = config.hooks;
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
		this._messages.push({ role: "user", content: message });
		this._resultPromise = null;
	}

	stream(options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
		if (this._closed) throw new StratusError("Session is closed");
		if (this._streaming)
			throw new StratusError("Already streaming. Consume the current stream first.");
		return this._streamInternal(options?.signal);
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

		// Fire onSessionStart on first stream
		if (!this._started && this._hooks?.onSessionStart) {
			this._started = true;
			await this._hooks.onSessionStart({ context: this._context as TContext });
		} else {
			this._started = true;
		}

		try {
			const { stream: s, result: resultPromise } = coreStream(
				this._agent,
				[...this._messages],
				{
					context: this._context,
					maxTurns: this._maxTurns,
					signal,
					costEstimator: this._costEstimator,
					maxBudgetUsd: this._maxBudgetUsd,
				},
			);

			this._resultPromise = resultPromise.then((result) => {
				this._messages = result.messages.filter((m) => m.role !== "system");
				return result;
			});
			// Prevent unhandled rejection if user doesn't await .result
			this._resultPromise.catch(() => {});

			for await (const event of s) {
				yield event;
			}

			await this._resultPromise;
		} finally {
			this._streaming = false;

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
