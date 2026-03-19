import type { Agent } from "./agent";
import type { GuardrailRunResult } from "./guardrails";
import type { FinishReason, UsageInfo } from "./model";
import type { ChatMessage } from "./types";

export interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	arguments: string;
	parsedArguments: unknown;
}

export class InterruptedRunResult<TOutput = undefined> {
	readonly interrupted = true as const;
	readonly pendingToolCalls: PendingToolCall[];
	readonly messages: ChatMessage[];
	readonly currentAgent: Agent<any, TOutput>;
	readonly context: any;
	readonly numTurns: number;
	readonly usage: UsageInfo | undefined;

	constructor(options: {
		pendingToolCalls: PendingToolCall[];
		messages: ChatMessage[];
		currentAgent: Agent<any, TOutput>;
		context: any;
		numTurns: number;
		usage?: UsageInfo;
	}) {
		this.pendingToolCalls = options.pendingToolCalls;
		this.messages = options.messages;
		this.currentAgent = options.currentAgent;
		this.context = options.context;
		this.numTurns = options.numTurns;
		this.usage = options.usage;
	}
}

export interface RunResultOptions<TOutput = undefined> {
	output: string;
	messages: ChatMessage[];
	usage: UsageInfo;
	lastAgent: Agent<any, any>;
	finalOutput?: TOutput;
	finishReason?: FinishReason;
	numTurns?: number;
	totalCostUsd?: number;
	responseId?: string;
	inputGuardrailResults?: GuardrailRunResult[];
	outputGuardrailResults?: GuardrailRunResult[];
}

export class RunResult<TOutput = undefined> {
	readonly interrupted = false as const;
	readonly output: string;
	readonly finalOutput: TOutput extends undefined ? undefined : TOutput;
	readonly messages: ChatMessage[];
	readonly usage: UsageInfo;
	readonly lastAgent: Agent<any, any>;
	readonly finishReason?: FinishReason;
	readonly numTurns: number;
	readonly totalCostUsd: number;
	readonly responseId?: string;
	readonly inputGuardrailResults: readonly GuardrailRunResult[];
	readonly outputGuardrailResults: readonly GuardrailRunResult[];

	constructor(opts: RunResultOptions<TOutput>) {
		this.output = opts.output;
		this.messages = opts.messages;
		this.usage = opts.usage;
		this.lastAgent = opts.lastAgent;
		this.finalOutput = opts.finalOutput as TOutput extends undefined ? undefined : TOutput;
		this.finishReason = opts.finishReason;
		this.numTurns = opts.numTurns ?? 0;
		this.totalCostUsd = opts.totalCostUsd ?? 0;
		this.responseId = opts.responseId;
		this.inputGuardrailResults = opts.inputGuardrailResults ?? [];
		this.outputGuardrailResults = opts.outputGuardrailResults ?? [];
	}

	/** Convert the result's messages into a format suitable for chaining as input to another run */
	toInputList(): ChatMessage[] {
		return this.messages.filter((m) => m.role !== "system");
	}
}
