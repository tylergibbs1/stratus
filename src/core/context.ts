import type { UsageInfo } from "./model";

export class RunContext<TContext> {
	readonly context: TContext;
	readonly usage: UsageInfo;

	constructor(context: TContext) {
		this.context = context;
		this.usage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		};
	}

	addUsage(usage: UsageInfo | undefined): void {
		if (!usage) return;
		this.usage.promptTokens += usage.promptTokens;
		this.usage.completionTokens += usage.completionTokens;
		this.usage.totalTokens += usage.totalTokens;
		if (usage.cacheReadTokens !== undefined) {
			this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + usage.cacheReadTokens;
		}
		if (usage.cacheCreationTokens !== undefined) {
			this.usage.cacheCreationTokens =
				(this.usage.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
		}
	}
}
