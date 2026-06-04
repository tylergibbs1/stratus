import {
	createModel,
	type Model,
	type ModelRequest,
	type ModelResponse,
	type StreamEvent,
} from "../../src";
import type {
	AssistantMessage,
	ChatMessage,
	ContentPart,
	ModelSettings,
	ToolChoice,
	ToolDefinition,
	ToolMessage,
} from "../../src/core/types";

type ResponseInputItem =
	| {
			type: "message";
			role: "system" | "developer" | "user" | "assistant";
			content: Array<{ type: "input_text" | "output_text"; text: string }>;
	  }
	| {
			type: "function_call";
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: "function_call_output";
			call_id: string;
			output: string;
	  };

interface OpenAIResponsesSmokeModelOptions {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
}

interface OpenAIResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

interface OpenAIResponsesOutputItem {
	type: string;
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	call_id?: string;
	name?: string;
	arguments?: string;
}

interface OpenAIResponsesPayload {
	id?: string;
	output?: OpenAIResponsesOutputItem[];
	usage?: OpenAIResponsesUsage;
	status?: string;
	incomplete_details?: { reason?: string };
}

function hasAzureEnv(): boolean {
	return Boolean(
		process.env.AZURE_OPENAI_ENDPOINT &&
			process.env.AZURE_OPENAI_API_KEY &&
			process.env.AZURE_OPENAI_DEPLOYMENT,
	);
}

function textParts(content: string, type: "input_text" | "output_text") {
	return [{ type, text: content }];
}

function userContentToText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "image_url") return "[image]";
			if (part.type === "file") return `[file${part.filename ? `: ${part.filename}` : ""}]`;
			if (part.type === "audio") return "[audio]";
			return "";
		})
		.join("\n");
}

function messageToInputItems(message: ChatMessage): ResponseInputItem[] {
	switch (message.role) {
		case "system":
		case "developer":
			return [
				{ type: "message", role: message.role, content: textParts(message.content, "input_text") },
			];
		case "user":
			return [
				{
					type: "message",
					role: "user",
					content: textParts(userContentToText(message.content), "input_text"),
				},
			];
		case "assistant":
			return assistantMessageToInputItems(message);
		case "tool":
			return [toolMessageToInputItem(message)];
	}
}

function assistantMessageToInputItems(message: AssistantMessage): ResponseInputItem[] {
	const items: ResponseInputItem[] = [];
	if (message.content) {
		items.push({
			type: "message",
			role: "assistant",
			content: textParts(message.content, "output_text"),
		});
	}
	for (const toolCall of message.tool_calls ?? []) {
		items.push({
			type: "function_call",
			call_id: toolCall.id,
			name: toolCall.function.name,
			arguments: toolCall.function.arguments,
		});
	}
	return items;
}

function toolMessageToInputItem(message: ToolMessage): ResponseInputItem {
	return {
		type: "function_call_output",
		call_id: message.tool_call_id,
		output: message.content,
	};
}

function convertToolChoice(toolChoice: ToolChoice | undefined): unknown {
	if (!toolChoice) return undefined;
	if (typeof toolChoice === "string") return toolChoice;
	return { type: "function", name: toolChoice.function.name };
}

function convertTools(tools: ModelRequest["tools"]): unknown[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => {
		if (tool.type !== "function") return tool;
		const fn = (tool as ToolDefinition).function;
		return {
			type: "function",
			name: fn.name,
			description: fn.description,
			parameters: fn.parameters,
			...(fn.strict !== undefined ? { strict: fn.strict } : {}),
		};
	});
}

function convertSettings(settings: ModelSettings | undefined): Record<string, unknown> {
	return {
		...(settings?.maxTokens !== undefined ? { max_output_tokens: settings.maxTokens } : {}),
		...(settings?.maxCompletionTokens !== undefined
			? { max_output_tokens: settings.maxCompletionTokens }
			: {}),
		...(settings?.temperature !== undefined ? { temperature: settings.temperature } : {}),
		...(settings?.topP !== undefined ? { top_p: settings.topP } : {}),
		...(settings?.parallelToolCalls !== undefined
			? { parallel_tool_calls: settings.parallelToolCalls }
			: {}),
		...(settings?.toolChoice !== undefined
			? { tool_choice: convertToolChoice(settings.toolChoice) }
			: {}),
		...(settings?.reasoningEffort !== undefined || settings?.reasoningSummary !== undefined
			? {
					reasoning: {
						...(settings.reasoningEffort !== undefined ? { effort: settings.reasoningEffort } : {}),
						...(settings.reasoningSummary !== undefined
							? { summary: settings.reasoningSummary }
							: {}),
					},
				}
			: {}),
	};
}

function extractText(payload: OpenAIResponsesPayload): string | null {
	const chunks: string[] = [];
	for (const item of payload.output ?? []) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type === "output_text" && part.text) chunks.push(part.text);
		}
	}
	return chunks.length > 0 ? chunks.join("") : null;
}

function extractToolCalls(payload: OpenAIResponsesPayload): ModelResponse["toolCalls"] {
	const toolCalls: ModelResponse["toolCalls"] = [];
	for (const item of payload.output ?? []) {
		if (item.type !== "function_call" || !item.call_id || !item.name) continue;
		toolCalls.push({
			id: item.call_id,
			type: "function" as const,
			function: {
				name: item.name,
				arguments: item.arguments ?? "{}",
			},
		});
	}
	return toolCalls;
}

export class OpenAIResponsesSmokeModel implements Model {
	private readonly apiKey: string;
	private readonly model: string;
	private readonly baseUrl: string;

	constructor(options: OpenAIResponsesSmokeModelOptions = {}) {
		const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
		this.apiKey = apiKey;
		this.model =
			options.model ?? process.env.STRATUS_REAL_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5-nano";
		this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
	}

	async getResponse(request: ModelRequest): Promise<ModelResponse> {
		const body = {
			model: this.model,
			input: request.messages.flatMap(messageToInputItems),
			tools: convertTools(request.tools),
			max_output_tokens: 80,
			store: false,
			...convertSettings(request.modelSettings),
		};

		const response = await fetch(`${this.baseUrl}/responses`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const json = (await response.json()) as OpenAIResponsesPayload & {
			error?: { message?: string };
		};
		if (!response.ok) {
			throw new Error(
				`OpenAI Responses API ${response.status}: ${json.error?.message ?? "unknown error"}`,
			);
		}

		const toolCalls = extractToolCalls(json);
		return {
			content: extractText(json),
			toolCalls,
			responseId: json.id,
			finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
			incompleteDetails: json.incomplete_details,
			usage: json.usage
				? {
						promptTokens: json.usage.input_tokens ?? 0,
						completionTokens: json.usage.output_tokens ?? 0,
						totalTokens: json.usage.total_tokens ?? 0,
					}
				: undefined,
		};
	}

	async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
		const response = await this.getResponse(request);
		if (response.content) yield { type: "content_delta", content: response.content };
		for (const toolCall of response.toolCalls) {
			yield {
				type: "tool_call_start",
				toolCall: { id: toolCall.id, name: toolCall.function.name },
			};
			yield {
				type: "tool_call_delta",
				toolCallId: toolCall.id,
				arguments: toolCall.function.arguments,
			};
			yield { type: "tool_call_done", toolCallId: toolCall.id };
		}
		yield { type: "done", response };
	}
}

export function createRealSmokeModel(): Model {
	if (hasAzureEnv()) return createModel({ store: false });
	return new OpenAIResponsesSmokeModel();
}

export function describeRealSmokeProvider(): string {
	if (hasAzureEnv()) return `azure:${process.env.AZURE_OPENAI_DEPLOYMENT}`;
	return `openai:${process.env.STRATUS_REAL_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5-nano"}`;
}
