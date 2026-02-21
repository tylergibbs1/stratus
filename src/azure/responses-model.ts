import { ContentFilterError, ModelError } from "../core/errors";
import type {
	FinishReason,
	Model,
	ModelRequest,
	ModelRequestOptions,
	ModelResponse,
	StreamEvent,
	UsageInfo,
} from "../core/model";
import type {
	ChatMessage,
	ContentPart,
	ResponseFormat,
	ToolCall,
	ToolDefinition,
} from "../core/types";
import { resolveResponsesUrl } from "./endpoint";
import { parseSSE } from "./sse-parser";

export interface AzureResponsesModelConfig {
	endpoint: string;
	apiKey: string;
	deployment: string;
	apiVersion?: string;
}

const DEFAULT_API_VERSION = "2025-04-01-preview";

export class AzureResponsesModel implements Model {
	private readonly url: string;
	private readonly apiKey: string;
	private readonly deployment: string;

	constructor(config: AzureResponsesModelConfig) {
		this.apiKey = config.apiKey;
		this.deployment = config.deployment;
		this.url = resolveResponsesUrl(
			config.endpoint,
			config.apiVersion ?? DEFAULT_API_VERSION,
		);
	}

	async getResponse(
		request: ModelRequest,
		options?: ModelRequestOptions,
	): Promise<ModelResponse> {
		const body = this.buildRequestBody(request, false);
		const response = await this.doFetch(body, options?.signal);
		const json = await response.json();
		return this.parseResponse(json);
	}

	async *getStreamedResponse(
		request: ModelRequest,
		options?: ModelRequestOptions,
	): AsyncGenerator<StreamEvent> {
		const body = this.buildRequestBody(request, true);
		const response = await this.doFetch(body, options?.signal);

		if (!response.body) {
			throw new ModelError("Response body is null");
		}

		let content = "";
		// Keyed by item.id (the Responses API item identifier), storing call_id for SDK events
		const toolCalls = new Map<string, { callId: string; name: string; arguments: string }>();
		let usage: UsageInfo | undefined;
		let finishReason: FinishReason | undefined;

		for await (const data of parseSSE(response.body)) {
			let event: ResponsesStreamEvent;
			try {
				event = JSON.parse(data);
			} catch {
				continue;
			}

			switch (event.type) {
				case "response.output_text.delta": {
					const textDelta = event.delta ?? "";
					content += textDelta;
					yield { type: "content_delta", content: textDelta };
					break;
				}
				case "response.output_item.added": {
					if (event.item?.type === "function_call") {
						const itemId = event.item.id ?? "";
						const callId = event.item.call_id ?? "";
						const name = event.item.name ?? "";
						toolCalls.set(itemId, { callId, name, arguments: "" });
						if (callId && name) {
							yield { type: "tool_call_start", toolCall: { id: callId, name } };
						}
					}
					break;
				}
				case "response.function_call_arguments.delta": {
					const itemId = event.item_id ?? "";
					const existing = toolCalls.get(itemId);
					if (existing) {
						const argDelta = event.delta ?? "";
						existing.arguments += argDelta;
						yield {
							type: "tool_call_delta",
							toolCallId: existing.callId,
							arguments: argDelta,
						};
					}
					break;
				}
				case "response.output_item.done": {
					if (event.item?.type === "function_call") {
						const itemId = event.item.id ?? "";
						const existing = toolCalls.get(itemId);
						if (existing) {
							if (event.item.arguments) {
								existing.arguments = event.item.arguments;
							}
							yield { type: "tool_call_done", toolCallId: existing.callId };
						}
					}
					break;
				}
				case "response.completed": {
					const resp = event.response;
					if (resp?.usage) {
						usage = {
							promptTokens: resp.usage.input_tokens,
							completionTokens: resp.usage.output_tokens,
							totalTokens: resp.usage.total_tokens,
							...(resp.usage.input_tokens_details?.cached_tokens !== undefined
								? { cacheReadTokens: resp.usage.input_tokens_details.cached_tokens }
								: {}),
							...(resp.usage.output_tokens_details?.reasoning_tokens !== undefined
								? { reasoningTokens: resp.usage.output_tokens_details.reasoning_tokens }
								: {}),
						};
					}
					finishReason = mapStatus(resp?.status);
					break;
				}
			}
		}

		const finalToolCalls: ToolCall[] = Array.from(toolCalls.values()).map((tc) => ({
			id: tc.callId,
			type: "function" as const,
			function: { name: tc.name, arguments: tc.arguments },
		}));

		yield {
			type: "done",
			response: {
				content: content || null,
				toolCalls: finalToolCalls,
				usage,
				finishReason,
			},
		};
	}

	private buildRequestBody(
		request: ModelRequest,
		stream: boolean,
	): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: this.deployment,
			store: false,
		};

		const { instructions, input } = convertMessages(request.messages);

		if (instructions) {
			body.instructions = instructions;
		}

		body.input = input;

		if (stream) {
			body.stream = true;
		}

		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map(flattenToolDefinition);
		}

		if (request.responseFormat) {
			body.text = convertResponseFormat(request.responseFormat);
		}

		const s = request.modelSettings;
		if (s) {
			if (s.temperature !== undefined) body.temperature = s.temperature;
			if (s.topP !== undefined) body.top_p = s.topP;
			if (s.maxTokens !== undefined) body.max_output_tokens = s.maxTokens;
			if (s.maxCompletionTokens !== undefined)
				body.max_output_tokens = s.maxCompletionTokens;
			if (s.toolChoice !== undefined) body.tool_choice = s.toolChoice;
			if (s.parallelToolCalls !== undefined) body.parallel_tool_calls = s.parallelToolCalls;
			if (s.reasoningEffort !== undefined)
				body.reasoning = { effort: s.reasoningEffort };
			if (s.promptCacheKey !== undefined)
				body.prompt_cache_key = s.promptCacheKey;
		}

		return body;
	}

	private async doFetch(
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Response> {
		const maxRetries = 3;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const response = await fetch(this.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"api-key": this.apiKey,
				},
				body: JSON.stringify(body),
				signal,
			});

			if (response.status === 429 && attempt < maxRetries) {
				const retryAfter = response.headers.get("retry-after");
				const waitMs = retryAfter
					? Number.parseInt(retryAfter, 10) * 1000
					: Math.min(1000 * 2 ** attempt, 30000);
				await new Promise((r) => setTimeout(r, waitMs));
				continue;
			}

			if (!response.ok) {
				await this.handleErrorResponse(response);
			}

			return response;
		}

		throw new ModelError("Max retries exceeded for Azure API request");
	}

	private async handleErrorResponse(response: Response): Promise<never> {
		let errorBody: string;
		try {
			errorBody = await response.text();
		} catch {
			errorBody = "";
		}

		if (response.status === 400) {
			let parsed: { error?: { code?: string; message?: string } } | undefined;
			try {
				parsed = JSON.parse(errorBody);
			} catch {
				// ignore parse errors
			}

			if (parsed?.error?.code === "content_filter") {
				throw new ContentFilterError(parsed.error.message, { status: 400 });
			}
		}

		throw new ModelError(
			`Azure API error (${response.status}): ${errorBody || response.statusText}`,
			{ status: response.status },
		);
	}

	private parseResponse(json: ResponsesApiResponse): ModelResponse {
		if (json.status === "incomplete") {
			const toolCalls = extractToolCalls(json.output ?? []);
			return {
				content: extractTextContent(json.output ?? []),
				toolCalls,
				usage: json.usage ? parseResponsesUsage(json.usage) : undefined,
				finishReason: "length",
			};
		}

		const output = json.output ?? [];
		const toolCalls = extractToolCalls(output);
		const content = extractTextContent(output);

		const usage: UsageInfo | undefined = json.usage
			? parseResponsesUsage(json.usage)
			: undefined;

		const finishReason: FinishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

		return {
			content,
			toolCalls,
			usage,
			finishReason,
		};
	}
}

function parseResponsesUsage(usage: NonNullable<ResponsesApiResponse["usage"]>): UsageInfo {
	return {
		promptTokens: usage.input_tokens,
		completionTokens: usage.output_tokens,
		totalTokens: usage.total_tokens,
		...(usage.input_tokens_details?.cached_tokens !== undefined
			? { cacheReadTokens: usage.input_tokens_details.cached_tokens }
			: {}),
		...(usage.output_tokens_details?.reasoning_tokens !== undefined
			? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
			: {}),
	};
}

function extractTextContent(output: ResponsesOutputItem[]): string | null {
	const texts: string[] = [];
	for (const item of output) {
		if (item.type === "message" && item.content) {
			for (const part of item.content) {
				if (part.type === "output_text" && part.text) {
					texts.push(part.text);
				}
			}
		}
	}
	return texts.length > 0 ? texts.join("") : null;
}

function extractToolCalls(output: ResponsesOutputItem[]): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const item of output) {
		if (item.type === "function_call") {
			calls.push({
				id: item.call_id,
				type: "function",
				function: {
					name: item.name,
					arguments: item.arguments ?? "",
				},
			});
		}
	}
	return calls;
}

function convertMessages(messages: ChatMessage[]): {
	instructions: string | undefined;
	input: ResponsesInputItem[];
} {
	let instructions: string | undefined;
	const input: ResponsesInputItem[] = [];

	for (const msg of messages) {
		switch (msg.role) {
			case "system":
				instructions = msg.content;
				break;
			case "developer":
				instructions = msg.content;
				break;
			case "user":
				input.push({
					type: "message",
					role: "user",
					content: convertUserContent(msg.content),
				});
				break;
			case "assistant": {
				if (msg.content) {
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: msg.content }],
					});
				}
				if (msg.tool_calls) {
					for (const tc of msg.tool_calls) {
						input.push({
							type: "function_call",
							call_id: tc.id,
							name: tc.function.name,
							arguments: tc.function.arguments,
						});
					}
				}
				break;
			}
			case "tool":
				input.push({
					type: "function_call_output",
					call_id: msg.tool_call_id,
					output: msg.content,
				});
				break;
		}
	}

	return { instructions, input };
}

function convertUserContent(
	content: string | ContentPart[],
): ResponsesContentPart[] {
	if (typeof content === "string") {
		return [{ type: "input_text", text: content }];
	}
	return content.map((part) => {
		if (part.type === "text") {
			return { type: "input_text" as const, text: part.text };
		}
		return {
			type: "input_image" as const,
			image_url: part.image_url.url,
			detail: part.image_url.detail,
		};
	});
}

function flattenToolDefinition(
	def: ToolDefinition,
): Record<string, unknown> {
	return {
		type: "function",
		name: def.function.name,
		description: def.function.description,
		parameters: def.function.parameters,
		...(def.function.strict !== undefined ? { strict: def.function.strict } : {}),
	};
}

function convertResponseFormat(
	format: ResponseFormat,
): Record<string, unknown> | undefined {
	if (format.type === "text") {
		return undefined;
	}
	if (format.type === "json_object") {
		return { format: { type: "json_object" } };
	}
	if (format.type === "json_schema") {
		return {
			format: {
				type: "json_schema",
				name: format.json_schema.name,
				schema: format.json_schema.schema,
				strict: format.json_schema.strict,
			},
		};
	}
	return undefined;
}

function mapStatus(status: string | undefined): FinishReason {
	if (status === "incomplete") return "length";
	return "stop";
}

// --- Responses API types ---

interface ResponsesApiResponse {
	status: string;
	output?: ResponsesOutputItem[];
	usage?: ResponsesUsage;
}

type ResponsesOutputItem =
	| { type: "message"; content?: { type: string; text?: string }[] }
	| { type: "function_call"; call_id: string; name: string; arguments?: string };

type ResponsesContentPart =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; detail?: string }
	| { type: "output_text"; text: string };

type ResponsesInputItem =
	| { type: "message"; role: "user"; content: ResponsesContentPart[] }
	| { type: "message"; role: "assistant"; content: ResponsesContentPart[] }
	| { type: "function_call"; call_id: string; name: string; arguments: string }
	| { type: "function_call_output"; call_id: string; output: string };

interface ResponsesStreamItem {
	id?: string;
	type: string;
	call_id?: string;
	name?: string;
	arguments?: string;
}

interface ResponsesUsage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details?: {
		cached_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
	};
}

type ResponsesStreamEvent =
	| { type: "response.output_text.delta"; delta?: string }
	| { type: "response.output_item.added"; item?: ResponsesStreamItem }
	| { type: "response.function_call_arguments.delta"; item_id?: string; delta?: string }
	| { type: "response.output_item.done"; item?: ResponsesStreamItem }
	| { type: "response.completed"; response?: { status?: string; usage?: ResponsesUsage } };
