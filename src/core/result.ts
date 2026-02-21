import type { Agent } from "./agent";
import type { UsageInfo } from "./model";
import type { ChatMessage } from "./types";

export interface RunResultOptions<TOutput = undefined> {
	output: string;
	messages: ChatMessage[];
	usage: UsageInfo;
	lastAgent: Agent<any, any>;
	finalOutput?: TOutput;
	finishReason?: string;
	numTurns?: number;
	totalCostUsd?: number;
}

export class RunResult<TOutput = undefined> {
	readonly output: string;
	readonly finalOutput: TOutput extends undefined ? undefined : TOutput;
	readonly messages: ChatMessage[];
	readonly usage: UsageInfo;
	readonly lastAgent: Agent<any, any>;
	readonly finishReason?: string;
	readonly numTurns: number;
	readonly totalCostUsd: number;

	constructor(opts: RunResultOptions<TOutput>) {
		this.output = opts.output;
		this.messages = opts.messages;
		this.usage = opts.usage;
		this.lastAgent = opts.lastAgent;
		this.finalOutput = opts.finalOutput as TOutput extends undefined ? undefined : TOutput;
		this.finishReason = opts.finishReason;
		this.numTurns = opts.numTurns ?? 0;
		this.totalCostUsd = opts.totalCostUsd ?? 0;
	}
}
