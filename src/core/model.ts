import type { ChatMessage, ModelSettings, ResponseFormat, ToolCall, ToolDefinition } from "./types";

export interface ModelRequest {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	modelSettings?: ModelSettings;
	responseFormat?: ResponseFormat;
}

export interface UsageInfo {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	reasoningTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ModelResponse {
	content: string | null;
	toolCalls: ToolCall[];
	usage?: UsageInfo;
	finishReason?: FinishReason;
}

export type StreamEvent =
	| { type: "content_delta"; content: string }
	| { type: "tool_call_start"; toolCall: { id: string; name: string } }
	| { type: "tool_call_delta"; toolCallId: string; arguments: string }
	| { type: "tool_call_done"; toolCallId: string }
	| { type: "done"; response: ModelResponse };

export interface ModelRequestOptions {
	signal?: AbortSignal;
}

export interface Model {
	getResponse(request: ModelRequest, options?: ModelRequestOptions): Promise<ModelResponse>;
	getStreamedResponse(
		request: ModelRequest,
		options?: ModelRequestOptions,
	): AsyncIterable<StreamEvent>;
}
