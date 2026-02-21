import { ContentFilterError, ModelError } from "../core/errors";
import type {
	Model,
	ModelRequest,
	ModelRequestOptions,
	ModelResponse,
	StreamEvent,
	UsageInfo,
} from "../core/model";
import type { ChatMessage, ToolCall } from "../core/types";
import { resolveChatCompletionsUrl } from "./endpoint";
import { parseSSE } from "./sse-parser";

export interface AzureChatCompletionsModelConfig {
	endpoint: string;
	apiKey: string;
	deployment: string;
	apiVersion?: string;
}

const DEFAULT_API_VERSION = "2025-03-01-preview";

export class AzureChatCompletionsModel implements Model {
	private readonly url: string;
	private readonly apiKey: string;

	constructor(config: AzureChatCompletionsModelConfig) {
		this.apiKey = config.apiKey;
		this.url = resolveChatCompletionsUrl(
			config.endpoint,
			config.deployment,
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
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
		let finishReason: string | undefined;
		let usage: UsageInfo | undefined;

		for await (const data of parseSSE(response.body)) {
			let chunk: AzureStreamChunk;
			try {
				chunk = JSON.parse(data);
			} catch {
				continue;
			}

			if (chunk.usage) {
				usage = {
					promptTokens: chunk.usage.prompt_tokens,
					completionTokens: chunk.usage.completion_tokens,
					totalTokens: chunk.usage.total_tokens,
					...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
						? { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens }
						: {}),
					...(chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined
						? { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens }
						: {}),
				};
			}

			const choice = chunk.choices?.[0];
			if (!choice) continue;

			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}

			const delta = choice.delta;
			if (!delta) continue;

			if (delta.content) {
				content += delta.content;
				yield { type: "content_delta", content: delta.content };
			}

			if (delta.tool_calls) {
				for (const tc of delta.tool_calls) {
					const existing = toolCalls.get(tc.index);
					if (!existing) {
						const id = tc.id ?? "";
						const name = tc.function?.name ?? "";
						toolCalls.set(tc.index, { id, name, arguments: tc.function?.arguments ?? "" });
						if (id && name) {
							yield { type: "tool_call_start", toolCall: { id, name } };
						}
					} else {
						if (tc.id) existing.id = tc.id;
						if (tc.function?.name) existing.name = tc.function.name;
						if (tc.function?.arguments) {
							existing.arguments += tc.function.arguments;
							yield {
								type: "tool_call_delta",
								toolCallId: existing.id,
								arguments: tc.function.arguments,
							};
						}
					}
				}
			}
		}

		const finalToolCalls: ToolCall[] = Array.from(toolCalls.values()).map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: { name: tc.name, arguments: tc.arguments },
		}));

		for (const tc of finalToolCalls) {
			yield { type: "tool_call_done", toolCallId: tc.id };
		}

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
			messages: request.messages.map(serializeMessage),
		};

		if (stream) {
			body.stream = true;
			body.stream_options = { include_usage: true };
		}

		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools;
		}

		if (request.responseFormat) {
			body.response_format = request.responseFormat;
		}

		const s = request.modelSettings;
		if (s) {
			if (s.temperature !== undefined) body.temperature = s.temperature;
			if (s.topP !== undefined) body.top_p = s.topP;
			if (s.maxTokens !== undefined) body.max_tokens = s.maxTokens;
			if (s.maxCompletionTokens !== undefined)
				body.max_completion_tokens = s.maxCompletionTokens;
			if (s.stop !== undefined) body.stop = s.stop;
			if (s.presencePenalty !== undefined) body.presence_penalty = s.presencePenalty;
			if (s.frequencyPenalty !== undefined) body.frequency_penalty = s.frequencyPenalty;
			if (s.toolChoice !== undefined) body.tool_choice = s.toolChoice;
			if (s.parallelToolCalls !== undefined) body.parallel_tool_calls = s.parallelToolCalls;
			if (s.seed !== undefined) body.seed = s.seed;
			if (s.reasoningEffort !== undefined) body.reasoning_effort = s.reasoningEffort;
			if (s.promptCacheKey !== undefined) body.prompt_cache_key = s.promptCacheKey;
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
			let parsed: AzureErrorResponse | undefined;
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

	private parseResponse(json: AzureChatResponse): ModelResponse {
		const choice = json.choices?.[0];

		if (!choice) {
			throw new ModelError("No choices in response");
		}

		if (choice.finish_reason === "content_filter") {
			throw new ContentFilterError();
		}

		const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: {
				name: tc.function.name,
				arguments: tc.function.arguments,
			},
		}));

		const usage: UsageInfo | undefined = json.usage
			? {
					promptTokens: json.usage.prompt_tokens,
					completionTokens: json.usage.completion_tokens,
					totalTokens: json.usage.total_tokens,
					...(json.usage.prompt_tokens_details?.cached_tokens !== undefined
						? { cacheReadTokens: json.usage.prompt_tokens_details.cached_tokens }
						: {}),
					...(json.usage.completion_tokens_details?.reasoning_tokens !== undefined
						? { reasoningTokens: json.usage.completion_tokens_details.reasoning_tokens }
						: {}),
				}
			: undefined;

		return {
			content: choice.message.content,
			toolCalls,
			usage,
			finishReason: choice.finish_reason,
		};
	}
}

function serializeMessage(msg: ChatMessage): Record<string, unknown> {
	switch (msg.role) {
		case "system":
			return { role: "system", content: msg.content };
		case "developer":
			return { role: "developer", content: msg.content };
		case "user":
			return { role: "user", content: msg.content };
		case "assistant": {
			const out: Record<string, unknown> = { role: "assistant", content: msg.content };
			if (msg.tool_calls && msg.tool_calls.length > 0) {
				out.tool_calls = msg.tool_calls;
			}
			return out;
		}
		case "tool":
			return { role: "tool", tool_call_id: msg.tool_call_id, content: msg.content };
	}
}

interface AzureChatResponse {
	choices: {
		message: {
			role: string;
			content: string | null;
			tool_calls?: {
				id: string;
				type: string;
				function: { name: string; arguments: string };
			}[];
		};
		finish_reason: string;
	}[];
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
		completion_tokens_details?: {
			reasoning_tokens?: number;
		};
	};
}

interface AzureErrorResponse {
	error?: {
		code?: string;
		message?: string;
	};
}

interface AzureStreamChunk {
	choices?: {
		delta?: {
			role?: string;
			content?: string;
			tool_calls?: {
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}[];
		};
		finish_reason?: string;
	}[];
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
		completion_tokens_details?: {
			reasoning_tokens?: number;
		};
	};
}
