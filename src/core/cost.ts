import type { UsageInfo } from "./model";

export interface PricingConfig {
	inputTokenCostPer1k: number;
	outputTokenCostPer1k: number;
	cachedInputTokenCostPer1k?: number;
}

export type CostEstimator = (usage: UsageInfo) => number;

export function createCostEstimator(pricing: PricingConfig): CostEstimator {
	return (usage: UsageInfo): number => {
		let inputTokens = usage.promptTokens;
		let cachedCost = 0;

		if (pricing.cachedInputTokenCostPer1k !== undefined && usage.cacheReadTokens) {
			cachedCost = (usage.cacheReadTokens / 1000) * pricing.cachedInputTokenCostPer1k;
			inputTokens -= usage.cacheReadTokens;
		}

		const inputCost = (inputTokens / 1000) * pricing.inputTokenCostPer1k;
		const outputCost = (usage.completionTokens / 1000) * pricing.outputTokenCostPer1k;

		return inputCost + outputCost + cachedCost;
	};
}
