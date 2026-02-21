import type { Agent } from "./agent";
import type { FinishReason, UsageInfo } from "./model";
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
	}
}
