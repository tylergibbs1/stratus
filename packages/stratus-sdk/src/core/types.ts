export interface SystemMessage {
	role: "system";
	content: string;
}

export interface TextContentPart {
	type: "text";
	text: string;
}

export interface ImageContentPart {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export interface FileContentPart {
	type: "file";
	file: { url: string } | { file_id: string };
	filename?: string;
}

export interface AudioContentPart {
	type: "audio";
	audio: { url: string } | { data: string; format: "wav" | "mp3" };
}

export type ContentPart = TextContentPart | ImageContentPart | FileContentPart | AudioContentPart;

export interface UserMessage {
	role: "user";
	content: string | ContentPart[];
}

export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCall[];
}

export interface ToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
}

export interface DeveloperMessage {
	role: "developer";
	content: string;
}

export type ChatMessage =
	| SystemMessage
	| DeveloperMessage
	| UserMessage
	| AssistantMessage
	| ToolMessage;

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export type ToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } };

export type ToolUseBehavior =
	| "run_llm_again"
	| "stop_on_first_tool"
	| { stopAtToolNames: string[] }
	| ((toolResults: { toolName: string; result: string }[]) => boolean | Promise<boolean>);

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ReasoningSummary = "auto" | "concise" | "detailed";

export type Truncation = "auto" | "disabled";

export type AudioFormat = "wav" | "mp3" | "flac" | "opus" | "pcm16";
export type AudioVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
export type Modality = "text" | "audio";

export interface AudioConfig {
	voice: AudioVoice;
	format: AudioFormat;
}

export interface PredictedOutput {
	type: "content";
	content: string;
}

export interface DataSource {
	type: string;
	[key: string]: unknown;
}

export interface ContextManagementRule {
	type: string;
	[key: string]: unknown;
}

/**
 * Server-side context management rules for the Responses API.
 * Passed as an array of rule objects.
 */
export type ContextManagement = ContextManagementRule[];

export interface ModelSettings {
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	maxCompletionTokens?: number;
	stop?: string[];
	presencePenalty?: number;
	frequencyPenalty?: number;
	toolChoice?: ToolChoice;
	parallelToolCalls?: boolean;
	seed?: number;
	reasoningEffort?: ReasoningEffort;
	reasoningSummary?: ReasoningSummary;
	promptCacheKey?: string;
	truncation?: Truncation;
	store?: boolean;
	metadata?: Record<string, string>;
	user?: string;
	logprobs?: boolean;
	topLogprobs?: number;
	/** Predicted output for faster completions (Chat Completions only). */
	prediction?: PredictedOutput;
	/** Audio output configuration (Chat Completions only, requires gpt-4o-audio models). */
	audio?: AudioConfig;
	/** Output modalities (Chat Completions only). Defaults to ["text"]. */
	modalities?: Modality[];
	/** Azure On Your Data sources (Chat Completions only). */
	dataSources?: DataSource[];
	/** Server-side context management (Responses API only). */
	contextManagement?: ContextManagement;
	/** Fields to include in the response (Responses API only). e.g. ["reasoning.encrypted_content"] */
	include?: string[];
	/** Run as a background task for long-running requests (Responses API only). */
	background?: boolean;
}

export type ResponseFormat =
	| { type: "text" }
	| { type: "json_object" }
	| {
			type: "json_schema";
			json_schema: {
				name: string;
				description?: string;
				schema: Record<string, unknown>;
				strict?: boolean;
			};
	  };

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		strict?: boolean;
	};
}

export interface HostedToolDefinition {
	type: string;
	[key: string]: unknown;
}
