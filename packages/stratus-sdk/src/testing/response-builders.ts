import type { FinishReason, ModelResponse, UsageInfo } from "../core/model";

export function textResponse(
	content: string,
	options?: {
		usage?: UsageInfo;
		finishReason?: FinishReason;
		responseId?: string;
	},
): ModelResponse {
	return {
		content,
		toolCalls: [],
		finishReason: options?.finishReason ?? "stop",
		usage: options?.usage,
		responseId: options?.responseId,
	};
}

export function toolCallResponse(
	calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
	options?: { usage?: UsageInfo; content?: string | null },
): ModelResponse {
	return {
		content: options?.content ?? null,
		toolCalls: calls.map((c, i) => ({
			id: c.id ?? `tc_${i}`,
			type: "function" as const,
			function: { name: c.name, arguments: JSON.stringify(c.args) },
		})),
		finishReason: "tool_calls",
		usage: options?.usage,
	};
}
