import type { Agent } from "./agent";
import type { FinishReason, UsageInfo } from "./model";
import type { GuardrailRunResult } from "./guardrails";
import type { ChatMessage } from "./types";

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
