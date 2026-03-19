import type {
	ChatMessage,
	HostedToolDefinition,
	ModelSettings,
	ResponseFormat,
	ToolCall,
	ToolDefinition,
} from "./types";

export interface ModelRequest {
	messages: ChatMessage[];
	tools?: (ToolDefinition | HostedToolDefinition)[];
	modelSettings?: ModelSettings;
	responseFormat?: ResponseFormat;
	previousResponseId?: string;
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
	responseId?: string;
	incompleteDetails?: { reason?: string };
	outputItems?: Record<string, unknown>[];
}

export type StreamEvent =
	| { type: "content_delta"; content: string }
	| { type: "tool_call_start"; toolCall: { id: string; name: string } }
	| { type: "tool_call_delta"; toolCallId: string; arguments: string }
	| { type: "tool_call_done"; toolCallId: string }
	| {
			type: "hosted_tool_call";
			toolType: string;
			status: "in_progress" | "completed" | "searching" | "generating" | "interpreting";
	  }
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
