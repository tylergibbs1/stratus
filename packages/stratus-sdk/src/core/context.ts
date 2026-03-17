import type { UsageInfo } from "./model";

export class RunContext<TContext> {
	readonly context: TContext;
	readonly usage: UsageInfo;
	numTurns = 0;
	totalCostUsd = 0;

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
		const u = this.usage;
		u.promptTokens += usage.promptTokens;
		u.completionTokens += usage.completionTokens;
		u.totalTokens += usage.totalTokens;
		if (usage.cacheReadTokens !== undefined) {
			u.cacheReadTokens = (u.cacheReadTokens ?? 0) + usage.cacheReadTokens;
		}
		if (usage.cacheCreationTokens !== undefined) {
			u.cacheCreationTokens = (u.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
		}
		if (usage.reasoningTokens !== undefined) {
			u.reasoningTokens = (u.reasoningTokens ?? 0) + usage.reasoningTokens;
		}
	}
}
