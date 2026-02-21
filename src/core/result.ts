import type { Agent } from "./agent";
import type { UsageInfo } from "./model";
import type { ChatMessage } from "./types";

export class RunResult<TOutput = undefined> {
	readonly output: string;
	readonly finalOutput: TOutput extends undefined ? undefined : TOutput;
	readonly messages: ChatMessage[];
	readonly usage: UsageInfo;
	readonly lastAgent: Agent<any, any>;
	readonly finishReason?: string;

	constructor(
		output: string,
		messages: ChatMessage[],
		usage: UsageInfo,
		lastAgent: Agent<any, any>,
		finalOutput?: TOutput,
		finishReason?: string,
	) {
		this.output = output;
		this.messages = messages;
		this.usage = usage;
		this.lastAgent = lastAgent;
		this.finalOutput = finalOutput as TOutput extends undefined ? undefined : TOutput;
		this.finishReason = finishReason;
	}
}
