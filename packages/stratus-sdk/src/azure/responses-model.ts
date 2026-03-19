import { ContentFilterError, ModelError, StratusError } from "../core/errors";
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
	HostedToolDefinition,
	ResponseFormat,
	ToolCall,
	ToolChoice,
	ToolDefinition,
} from "../core/types";
import { resolveResponsesUrl } from "./endpoint";
import { abortableSleep, computeRetryDelay, isRetryableStatus } from "./retry";
import { parseSSE } from "./sse-parser";

export interface AzureResponsesModelConfig {
	endpoint: string;
	apiKey?: string;
	azureAdTokenProvider?: () => Promise<string>;
	deployment: string;
	apiVersion?: string;
	store?: boolean;
	/** Maximum number of retries on 429 / network errors (default 3). */
	maxRetries?: number;
}

const DEFAULT_API_VERSION = "2025-04-01-preview";

type HostedToolStatus = "in_progress" | "completed" | "searching" | "generating" | "interpreting";
const HOSTED_TOOL_EVENT_MAP = new Map<string, { toolType: string; status: HostedToolStatus }>([
	["response.web_search_call.in_progress", { toolType: "web_search", status: "in_progress" }],
	["response.web_search_call.searching", { toolType: "web_search", status: "searching" }],
	["response.web_search_call.completed", { toolType: "web_search", status: "completed" }],
	["response.file_search_call.in_progress", { toolType: "file_search", status: "in_progress" }],
	["response.file_search_call.searching", { toolType: "file_search", status: "searching" }],
	["response.file_search_call.completed", { toolType: "file_search", status: "completed" }],
	[
		"response.code_interpreter_call.in_progress",
		{ toolType: "code_interpreter", status: "in_progress" },
	],
	[
		"response.code_interpreter_call.interpreting",
		{ toolType: "code_interpreter", status: "interpreting" },
	],
	[
		"response.code_interpreter_call.completed",
		{ toolType: "code_interpreter", status: "completed" },
	],
	[
		"response.image_generation_call.in_progress",
		{ toolType: "image_generation", status: "in_progress" },
	],
	[
		"response.image_generation_call.generating",
		{ toolType: "image_generation", status: "generating" },
	],
	[
		"response.image_generation_call.completed",
		{ toolType: "image_generation", status: "completed" },
	],
]);

export class AzureResponsesModel implements Model {
	private readonly url: string;
	private readonly apiKey?: string;
	private readonly tokenProvider?: () => Promise<string>;
	private readonly deployment: string;
	private readonly store: boolean;
	private readonly maxRetries: number;

	constructor(config: AzureResponsesModelConfig) {
		if (config.apiKey && config.azureAdTokenProvider) {
			throw new StratusError("Provide either apiKey or azureAdTokenProvider, not both");
		}
		if (!config.apiKey && !config.azureAdTokenProvider) {
			throw new StratusError("Provide either apiKey or azureAdTokenProvider");
		}
		this.apiKey = config.apiKey;
		this.tokenProvider = config.azureAdTokenProvider;
		this.deployment = config.deployment;
		this.store = config.store ?? false;
		this.maxRetries = config.maxRetries ?? 3;
		this.url = resolveResponsesUrl(config.endpoint, config.apiVersion ?? DEFAULT_API_VERSION);
	}

	private async getAuthHeaders(): Promise<Record<string, string>> {
		if (this.tokenProvider) {
			const token = await this.tokenProvider();
			return { Authorization: `Bearer ${token}` };
		}
		// Constructor validates exactly one of apiKey/tokenProvider is set.
		return { "api-key": this.apiKey as string };
	}

	async getResponse(request: ModelRequest, options?: ModelRequestOptions): Promise<ModelResponse> {
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
		// SSE-level retries are separate from doFetch's HTTP-level retries.
		// Use a fixed budget of 3 to avoid quadratic retry multiplication.
		const maxSseRetries = 3;
		for (let sseAttempt = 0; sseAttempt <= maxSseRetries; sseAttempt++) {
			const response = await this.doFetch(body, options?.signal);

			if (!response.body) {
				throw new ModelError("Response body is null");
			}

			let content = "";
			// Keyed by item.id (the Responses API item identifier), storing call_id for SDK events
			const toolCalls = new Map<string, { callId: string; name: string; arguments: string }>();
			let usage: UsageInfo | undefined;
			let finishReason: FinishReason | undefined;
			let responseId: string | undefined;
			// Deferred error from response.failed with no error details —
			// allows the subsequent `error` SSE event to provide the real message.
			let deferredFailure: string | undefined;
			let hasYielded = false;
			let sseRateLimited = false;

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
						hasYielded = true;
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
								hasYielded = true;
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
							hasYielded = true;
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
								hasYielded = true;
								yield { type: "tool_call_done", toolCallId: existing.callId };
							}
						}
						break;
					}
					// Hosted tool streaming events
					case "response.web_search_call.in_progress":
					case "response.web_search_call.searching":
					case "response.web_search_call.completed":
					case "response.file_search_call.in_progress":
					case "response.file_search_call.searching":
					case "response.file_search_call.completed":
					case "response.code_interpreter_call.in_progress":
					case "response.code_interpreter_call.interpreting":
					case "response.code_interpreter_call.completed":
					case "response.image_generation_call.in_progress":
					case "response.image_generation_call.generating":
					case "response.image_generation_call.completed": {
						const mapped = HOSTED_TOOL_EVENT_MAP.get(event.type);
						if (mapped) {
							hasYielded = true;
							yield { type: "hosted_tool_call", toolType: mapped.toolType, status: mapped.status };
						}
						break;
					}
					case "response.completed": {
						const resp = event.response;
						if (resp?.id) {
							responseId = resp.id;
						}
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
					case "response.failed": {
						const errorMsg = event.response?.error?.message;
						if (errorMsg) {
							throw new ModelError(`Azure API response failed: ${errorMsg}`, { status: 200 });
						}
						// error is null — defer to let the subsequent `error` event
						// provide the real details (e.g. too_many_requests).
						deferredFailure = "Response failed";
						break;
					}
					case "error": {
						const err = event.error;
						const errorType = err?.type ?? "unknown";
						const errorMsg = err?.message ?? "Unknown error";
						if (errorType === "too_many_requests") {
							if (!hasYielded && sseAttempt < maxSseRetries) {
								sseRateLimited = true;
								break; // exit SSE loop, retry in outer loop
							}
							throw new ModelError(`Azure API rate limited (SSE): ${errorMsg}`, { status: 429 });
						}
						throw new ModelError(`Azure API stream error (${errorType}): ${errorMsg}`, {
							status: 200,
						});
					}
				}
			}

			// SSE rate limited before any events were yielded — retry with backoff
			if (sseRateLimited) {
				const waitMs = computeRetryDelay(response.headers, sseAttempt);
				console.warn(
					`[AzureResponsesModel] 429 rate limited (SSE), retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${sseAttempt + 1}/${maxSseRetries})`,
				);
				await abortableSleep(waitMs, options?.signal);
				if (options?.signal?.aborted) {
					throw new ModelError("Azure API request aborted during SSE retry backoff", {
						status: 429,
					});
				}
				continue;
			}

			// If response.failed had no error details and no subsequent error event provided one
			if (deferredFailure) {
				throw new ModelError(`Azure API response failed: ${deferredFailure}`, { status: 200 });
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
					responseId,
				},
			};
			return; // success — exit retry loop
		} // end SSE retry loop

		throw new ModelError("Max SSE retries exceeded for rate-limited request", { status: 429 });
	}

	private buildRequestBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
		// ModelSettings.store overrides config-level store
		const effectiveStore = request.modelSettings?.store ?? this.store;
		const body: Record<string, unknown> = {
			model: this.deployment,
			store: effectiveStore,
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
			body.tools = request.tools.map((def) => {
				if (isFunctionToolDefinition(def)) {
					return flattenToolDefinition(def);
				}
				// Hosted tool definitions pass through as-is
				return def;
			});
		}

		if (request.responseFormat) {
			body.text = convertResponseFormat(request.responseFormat);
		}

		// Only send previous_response_id when store is enabled (API needs to persist responses)
		if (effectiveStore && request.previousResponseId) {
			body.previous_response_id = request.previousResponseId;
		}

		const s = request.modelSettings;
		if (s) {
			if (s.temperature !== undefined) body.temperature = s.temperature;
			if (s.topP !== undefined) body.top_p = s.topP;
			if (s.maxCompletionTokens !== undefined) {
				body.max_output_tokens = s.maxCompletionTokens;
			} else if (s.maxTokens !== undefined) {
				body.max_output_tokens = s.maxTokens;
			}
			if (s.toolChoice !== undefined) body.tool_choice = convertToolChoice(s.toolChoice);
			if (s.parallelToolCalls !== undefined) body.parallel_tool_calls = s.parallelToolCalls;
			if (s.reasoningEffort !== undefined || s.reasoningSummary !== undefined) {
				const reasoning: Record<string, unknown> = {};
				if (s.reasoningEffort !== undefined) reasoning.effort = s.reasoningEffort;
				if (s.reasoningSummary !== undefined) reasoning.summary = s.reasoningSummary;
				body.reasoning = reasoning;
			}
			if (s.promptCacheKey !== undefined) body.prompt_cache_key = s.promptCacheKey;
			if (s.truncation !== undefined) body.truncation = s.truncation;
			if (s.store !== undefined) body.store = s.store;
			if (s.metadata !== undefined) body.metadata = s.metadata;
			if (s.user !== undefined) body.user = s.user;
		}

		return body;
	}

	private async doFetch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			let response: Response;
			try {
				const authHeaders = await this.getAuthHeaders();
				response = await fetch(this.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...authHeaders,
					},
					body: JSON.stringify(body),
					signal,
				});
			} catch (fetchErr) {
				// Network errors (timeout, connection reset, DNS failure)
				// are retryable unless the caller aborted.
				if (signal?.aborted) throw fetchErr;
				if (attempt < this.maxRetries) {
					const waitMs = Math.min(1000 * 2 ** attempt + Math.random() * 1000, 30000);
					await abortableSleep(waitMs, signal);
					if (signal?.aborted) throw fetchErr;
					continue;
				}
				throw new ModelError(
					`Azure API network error after ${this.maxRetries + 1} attempts: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
					{ cause: fetchErr },
				);
			}

			if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
				const waitMs = computeRetryDelay(response.headers, attempt);
				console.warn(
					`[AzureResponsesModel] ${response.status} retryable error, retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${this.maxRetries})`,
				);
				await abortableSleep(waitMs, signal);
				if (signal?.aborted) {
					throw new ModelError("Azure API request aborted during retry backoff", { status: response.status });
				}
				continue;
			}

			if (!response.ok) {
				await this.handleErrorResponse(response);
			}

			return response;
		}

		// Unreachable: the final iteration always returns or throws above.
		// Kept for TypeScript's control-flow analysis.
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
				responseId: json.id,
			};
		}

		const output = json.output ?? [];
		const toolCalls = extractToolCalls(output);
		const content = extractTextContent(output);

		const usage: UsageInfo | undefined = json.usage ? parseResponsesUsage(json.usage) : undefined;

		const finishReason: FinishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

		return {
			content,
			toolCalls,
			usage,
			finishReason,
			responseId: json.id,
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

function convertUserContent(content: string | ContentPart[]): ResponsesContentPart[] {
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

function isFunctionToolDefinition(
	def: ToolDefinition | HostedToolDefinition,
): def is ToolDefinition {
	return (
		"function" in def &&
		(def as ToolDefinition).function != null &&
		typeof (def as ToolDefinition).function === "object"
	);
}

type ResponsesToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

function convertToolChoice(toolChoice: ToolChoice): ResponsesToolChoice {
	if (typeof toolChoice === "string") return toolChoice;
	// Chat Completions format: { type: "function", function: { name } }
	// Responses API format: { type: "function", name }
	return { type: toolChoice.type, name: toolChoice.function.name };
}

function flattenToolDefinition(def: ToolDefinition): Record<string, unknown> {
	return {
		type: "function",
		name: def.function.name,
		description: def.function.description,
		parameters: def.function.parameters,
		...(def.function.strict !== undefined ? { strict: def.function.strict } : {}),
	};
}

function convertResponseFormat(format: ResponseFormat): Record<string, unknown> | undefined {
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
	id?: string;
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
	| {
			type: "response.completed";
			response?: { id?: string; status?: string; usage?: ResponsesUsage };
	  }
	// Hosted tool streaming events
	| { type: "response.web_search_call.in_progress" }
	| { type: "response.web_search_call.searching" }
	| { type: "response.web_search_call.completed" }
	| { type: "response.file_search_call.in_progress" }
	| { type: "response.file_search_call.searching" }
	| { type: "response.file_search_call.completed" }
	| { type: "response.code_interpreter_call.in_progress" }
	| { type: "response.code_interpreter_call.interpreting" }
	| { type: "response.code_interpreter_call.completed" }
	| { type: "response.image_generation_call.in_progress" }
	| { type: "response.image_generation_call.generating" }
	| { type: "response.image_generation_call.completed" }
	// Error / failure events (e.g. SSE-level 429)
	| {
			type: "response.failed";
			response?: {
				id?: string;
				status?: string;
				error?: { message?: string; type?: string; code?: string };
			};
	  }
	| { type: "error"; error?: { type?: string; code?: string; message?: string } };
