import type { Agent } from "../core/agent";
import type { FinishReason, Model, ModelRequest, ModelResponse, StreamEvent } from "../core/model";
import type { InterruptedRunResult, PendingToolCall, RunResult } from "../core/result";
import { type RunOptions, resumeRun, stream, type ToolApproval } from "../core/run";
import { resumeSession, type SessionConfig, type SessionSnapshot } from "../core/session";
import type { FunctionTool } from "../core/tool";
import type {
	AssistantMessage,
	ChatMessage,
	ContentPart,
	FileContentPart,
	ImageContentPart,
	ModelSettings,
	TextContentPart,
	ToolCall,
	ToolMessage,
} from "../core/types";

export interface AISDKUIMessage {
	id: string;
	role: "system" | "user" | "assistant";
	metadata?: unknown;
	parts: AISDKUIMessagePart[];
}

export type AISDKUIMessagePart =
	| { type: "text"; text: string }
	| { type: "file"; url: string; mediaType: string; filename?: string }
	| ({ type: `tool-${string}` } & AISDKToolUIPart)
	| ({ type: "dynamic-tool"; toolName: string } & AISDKToolUIPart)
	| { type: string; [key: string]: unknown };

export interface AISDKToolUIPart {
	toolCallId: string;
	state:
		| "input-streaming"
		| "input-available"
		| "approval-requested"
		| "approval-responded"
		| "output-available"
		| "output-error"
		| "output-denied";
	input?: unknown;
	output?: unknown;
	errorText?: string;
	approval?: { approved?: boolean; reason?: string };
}

export type AISDKModelMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | AISDKModelContentPart[] }
	| { role: "assistant"; content: string | AISDKModelContentPart[] }
	| { role: "tool"; content: AISDKModelContentPart[] };

export type AISDKModelContentPart =
	| { type: "text"; text: string }
	| { type: "image"; image: string | URL | { type: "reference"; reference: string } }
	| {
			type: "file";
			data: string | URL | { type: "url"; url: string } | { type: "reference"; reference: string };
			filename?: string;
			mediaType?: string;
	  }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
	| { type: string; [key: string]: unknown };

export type AISDKMessage = AISDKUIMessage | AISDKModelMessage;

export type AISDKUIMessageChunk =
	| { type: "start"; messageId?: string; messageMetadata?: unknown }
	| { type: "text-start"; id: string }
	| { type: "text-delta"; id: string; delta: string }
	| { type: "text-end"; id: string }
	| { type: "tool-input-start"; toolCallId: string; toolName: string }
	| { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
	| { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
	| {
			type: "tool-input-error";
			toolCallId: string;
			toolName: string;
			input: unknown;
			errorText: string;
	  }
	| { type: "tool-output-available"; toolCallId: string; output: unknown }
	| { type: "tool-approval-request"; approvalId: string; toolCallId: string; isAutomatic?: boolean }
	| { type: "tool-approval-response"; approvalId: string; approved: boolean; reason?: string }
	| { type: "data-stratus-event"; data: StreamEvent }
	| { type: "finish"; finishReason?: string; messageMetadata?: unknown }
	| { type: "error"; errorText: string };

export interface FromAISDKMessagesOptions {
	/**
	 * Convert custom UI data parts into Stratus user content. Return undefined to ignore a part.
	 */
	convertDataPart?: (part: AISDKUIMessagePart) => TextContentPart | FileContentPart | undefined;
}

export interface ToAISDKUIMessageOptions {
	id?: string;
	metadata?: unknown;
}

export interface ToAISDKUIMessageStreamOptions {
	messageId?: string;
	textId?: string;
	messageMetadata?: unknown;
	sendStart?: boolean;
	sendFinish?: boolean;
}

export interface AISDKUIMessageStreamResponseInit extends ResponseInit {
	consumeSseStream?: (options: { stream: ReadableStream<string> }) => PromiseLike<void> | void;
}

export interface CreateStratusChatResponseOptions<TContext, TOutput = undefined>
	extends AISDKUIMessageStreamResponseInit {
	agent: Agent<TContext, TOutput>;
	messages: AISDKMessage[];
	runOptions?: RunOptions<TContext, TOutput>;
	messageId?: string;
	messageMetadata?: unknown;
	convertDataPart?: FromAISDKMessagesOptions["convertDataPart"];
}

export interface ResumeStratusChatResponseOptions<TContext, TOutput = undefined>
	extends AISDKUIMessageStreamResponseInit {
	interrupted: InterruptedRunResult<TOutput>;
	messages: AISDKMessage[];
	runOptions?: RunOptions<TContext, TOutput>;
	messageId?: string;
	messageMetadata?: unknown;
}

export type AISDKToolSet<TContext = unknown> = Record<
	string,
	{
		description: string;
		inputSchema: FunctionTool<unknown, TContext>["parameters"];
		execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<string> | string;
	}
>;

export type AISDKLanguageModelFinishReason =
	| "stop"
	| "length"
	| "content-filter"
	| "tool-calls"
	| "unknown";

export interface AISDKLanguageModelCallOptions {
	prompt?: AISDKModelMessage[];
	messages?: AISDKModelMessage[];
	tools?: Array<{
		type?: "function";
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
		parameters?: Record<string, unknown>;
	}>;
	toolChoice?: unknown;
	temperature?: number;
	topP?: number;
	maxOutputTokens?: number;
	abortSignal?: AbortSignal;
	[key: string]: unknown;
}

export interface AISDKLanguageModel {
	specificationVersion: "v2";
	provider: string;
	modelId: string;
	supportedUrls: Record<string, RegExp[]>;
	doGenerate(options: AISDKLanguageModelCallOptions): Promise<{
		content: Array<
			| { type: "text"; text: string }
			| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
		>;
		finishReason: AISDKLanguageModelFinishReason;
		usage: { inputTokens: number; outputTokens: number; totalTokens: number };
		response?: { id?: string };
	}>;
	doStream(options: AISDKLanguageModelCallOptions): Promise<{
		stream: ReadableStream<
			| { type: "text-delta"; id: string; delta: string }
			| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
			| {
					type: "finish";
					finishReason: AISDKLanguageModelFinishReason;
					usage: { inputTokens: number; outputTokens: number; totalTokens: number };
			  }
		>;
	}>;
}

export type OpenAIAgentsStyleStreamEvent =
	| { type: "raw_model_stream_event"; data: StreamEvent; source?: "stratus" }
	| {
			type: "run_item_stream_event";
			name:
				| "message_output_created"
				| "tool_called"
				| "tool_output"
				| "tool_approval_requested"
				| "handoff_occurred"
				| "reasoning_item_created";
			item: Record<string, unknown>;
	  }
	| { type: "agent_updated_stream_event"; agent: { name: string } };

function isUIMessage(message: AISDKMessage): message is AISDKUIMessage {
	return "parts" in message && Array.isArray(message.parts);
}

function stringifyOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "type" in value) {
		const typed = value as { type: string; value?: unknown; reason?: string };
		if (typed.type === "text" || typed.type === "error-text") return String(typed.value ?? "");
		if (typed.type === "execution-denied") return typed.reason ?? "Tool execution denied";
	}
	return JSON.stringify(value);
}

function parseJsonish(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function toolNameFromUIPart(part: AISDKUIMessagePart): string | undefined {
	if (part.type === "dynamic-tool" && typeof part.toolName === "string") return part.toolName;
	if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextUIPart(part: AISDKUIMessagePart): part is { type: "text"; text: string } {
	return part.type === "text" && typeof (part as Record<string, unknown>).text === "string";
}

function isFileUIPart(
	part: AISDKUIMessagePart,
): part is { type: "file"; url: string; mediaType: string; filename?: string } {
	return (
		part.type === "file" &&
		typeof (part as Record<string, unknown>).url === "string" &&
		typeof (part as Record<string, unknown>).mediaType === "string"
	);
}

function isModelTextPart(part: AISDKModelContentPart): part is { type: "text"; text: string } {
	return part.type === "text" && typeof (part as Record<string, unknown>).text === "string";
}

function isModelToolCallPart(
	part: AISDKModelContentPart,
): part is { type: "tool-call"; toolCallId: string; toolName: string; input: unknown } {
	return (
		part.type === "tool-call" &&
		typeof (part as Record<string, unknown>).toolCallId === "string" &&
		typeof (part as Record<string, unknown>).toolName === "string"
	);
}

function isModelToolResultPart(
	part: AISDKModelContentPart,
): part is { type: "tool-result"; toolCallId: string; toolName: string; output: unknown } {
	return (
		part.type === "tool-result" && typeof (part as Record<string, unknown>).toolCallId === "string"
	);
}

function imagePartFromUrl(url: string): ImageContentPart {
	return { type: "image_url", image_url: { url } };
}

function filePartFromUrl(url: string, filename?: string): FileContentPart {
	return { type: "file", file: { url }, filename };
}

function contentPartFromModelPart(part: AISDKModelContentPart): ContentPart | undefined {
	if (isModelTextPart(part)) return { type: "text", text: part.text };
	if (part.type === "image") {
		const image = (part as { image?: unknown }).image;
		if (typeof image === "string") return imagePartFromUrl(image);
		if (image instanceof URL) return imagePartFromUrl(image.toString());
		if (isRecord(image) && image.type === "reference" && typeof image.reference === "string") {
			return { type: "image_url", image_url: { file_id: image.reference } };
		}
	}
	if (part.type === "file") {
		const file = part as { data?: unknown; filename?: unknown };
		const filename = typeof file.filename === "string" ? file.filename : undefined;
		if (typeof file.data === "string") return filePartFromUrl(file.data, filename);
		if (file.data instanceof URL) return filePartFromUrl(file.data.toString(), filename);
		if (isRecord(file.data) && file.data.type === "url" && typeof file.data.url === "string") {
			return filePartFromUrl(file.data.url, filename);
		}
		if (
			isRecord(file.data) &&
			file.data.type === "reference" &&
			typeof file.data.reference === "string"
		) {
			return { type: "file", file: { file_id: file.data.reference }, filename };
		}
	}
	return undefined;
}

function contentPartFromUIPart(
	part: AISDKUIMessagePart,
	options?: FromAISDKMessagesOptions,
): ContentPart | undefined {
	if (isTextUIPart(part)) return { type: "text", text: part.text };
	if (isFileUIPart(part)) {
		if (part.mediaType.startsWith("image/")) return imagePartFromUrl(part.url);
		return filePartFromUrl(part.url, part.filename);
	}
	if (part.type.startsWith("data-")) return options?.convertDataPart?.(part);
	return undefined;
}

function normalizeContent(parts: ContentPart[]): string | ContentPart[] {
	if (parts.length === 0) return "";
	if (parts.every((part) => part.type === "text")) {
		return parts.map((part) => (part as TextContentPart).text).join("");
	}
	return parts;
}

function fromUIMessage(message: AISDKUIMessage, options?: FromAISDKMessagesOptions): ChatMessage[] {
	if (message.role === "system") {
		return [
			{
				role: "system",
				content: message.parts.map((p) => (isTextUIPart(p) ? p.text : "")).join(""),
			},
		];
	}

	if (message.role === "user") {
		const parts = message.parts
			.map((part) => contentPartFromUIPart(part, options))
			.filter((part): part is ContentPart => part !== undefined);
		return [{ role: "user", content: normalizeContent(parts) }];
	}

	const text = message.parts
		.filter(isTextUIPart)
		.map((part) => part.text)
		.join("");
	const toolCalls: ToolCall[] = [];
	const toolMessages: ToolMessage[] = [];

	for (const part of message.parts) {
		const toolName = toolNameFromUIPart(part);
		if (!toolName || !("toolCallId" in part)) continue;
		const toolPart = part as AISDKToolUIPart;
		const input = "input" in part ? part.input : undefined;
		if (
			toolPart.state === "input-available" ||
			toolPart.state === "approval-requested" ||
			toolPart.state === "approval-responded" ||
			toolPart.state === "output-available" ||
			toolPart.state === "output-error" ||
			toolPart.state === "output-denied"
		) {
			toolCalls.push({
				id: toolPart.toolCallId,
				type: "function",
				function: { name: toolName, arguments: JSON.stringify(input ?? {}) },
			});
		}
		if (toolPart.state === "output-available") {
			toolMessages.push({
				role: "tool",
				tool_call_id: toolPart.toolCallId,
				content: stringifyOutput(toolPart.output),
			});
		}
		if (toolPart.state === "output-error") {
			toolMessages.push({
				role: "tool",
				tool_call_id: toolPart.toolCallId,
				content: toolPart.errorText ?? "Tool execution failed",
			});
		}
		if (toolPart.state === "output-denied") {
			toolMessages.push({
				role: "tool",
				tool_call_id: toolPart.toolCallId,
				content: toolPart.approval?.reason ?? "Tool execution denied",
			});
		}
	}

	const assistant: AssistantMessage = {
		role: "assistant",
		content: text || null,
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};
	return [assistant, ...toolMessages];
}

function fromModelMessage(message: AISDKModelMessage): ChatMessage[] {
	if (message.role === "system") return [{ role: "system", content: message.content }];
	if (message.role === "user") {
		if (typeof message.content === "string") return [{ role: "user", content: message.content }];
		const parts = message.content
			.map(contentPartFromModelPart)
			.filter((part): part is ContentPart => part !== undefined);
		return [{ role: "user", content: normalizeContent(parts) }];
	}
	if (message.role === "tool") {
		return message.content.filter(isModelToolResultPart).map((part) => ({
			role: "tool" as const,
			tool_call_id: String(part.toolCallId),
			content: stringifyOutput(part.output),
		}));
	}

	if (typeof message.content === "string") {
		return [{ role: "assistant", content: message.content }];
	}

	const text = message.content
		.filter(isModelTextPart)
		.map((part) => part.text)
		.join("");
	const toolCalls = message.content.filter(isModelToolCallPart).map<ToolCall>((part) => ({
		id: part.toolCallId,
		type: "function",
		function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
	}));

	return [
		{
			role: "assistant",
			content: text || null,
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		},
	];
}

export function fromAISDKMessages(
	messages: AISDKMessage[],
	options?: FromAISDKMessagesOptions,
): ChatMessage[] {
	return messages.flatMap((message) =>
		isUIMessage(message) ? fromUIMessage(message, options) : fromModelMessage(message),
	);
}

export function toAISDKUIMessages(
	messagesOrSnapshot: ChatMessage[] | SessionSnapshot | RunResult<unknown>,
): AISDKUIMessage[] {
	const messages = Array.isArray(messagesOrSnapshot)
		? messagesOrSnapshot
		: "messages" in messagesOrSnapshot
			? messagesOrSnapshot.messages
			: [];
	const toolResults = new Map<string, string>();
	const uiMessages: AISDKUIMessage[] = [];

	for (const message of messages) {
		if (message.role === "tool") {
			toolResults.set(message.tool_call_id, message.content);
		}
	}

	for (const message of messages) {
		if (message.role === "tool") {
			continue;
		}
		if (message.role === "developer") continue;

		if (message.role === "assistant") {
			const parts: AISDKUIMessagePart[] = contentToUIParts(message.content);
			for (const toolCall of message.tool_calls ?? []) {
				const toolName = toolCall.function.name;
				const output = toolResults.get(toolCall.id);
				parts.push({
					type: `tool-${toolName}`,
					toolCallId: toolCall.id,
					state: output === undefined ? "input-available" : "output-available",
					input: parseJsonish(toolCall.function.arguments),
					...(output === undefined ? {} : { output }),
				});
			}
			uiMessages.push({
				id: crypto.randomUUID(),
				role: "assistant",
				parts,
			});
			continue;
		}

		uiMessages.push({
			id: crypto.randomUUID(),
			role: message.role,
			parts: userOrSystemContentToUIParts(message.content),
		});
	}

	return uiMessages;
}

export function toSessionSnapshotFromAISDKMessages(
	messages: AISDKMessage[],
	options?: FromAISDKMessagesOptions & { id?: string },
): SessionSnapshot {
	return {
		id: options?.id ?? crypto.randomUUID(),
		messages: fromAISDKMessages(messages, options).filter((message) => message.role !== "system"),
	};
}

export function resumeSessionFromAISDKMessages<TContext = unknown, TOutput = undefined>(
	messages: AISDKMessage[],
	config: SessionConfig<TContext, TOutput>,
	options?: FromAISDKMessagesOptions & { id?: string },
) {
	return resumeSession(toSessionSnapshotFromAISDKMessages(messages, options), config);
}

function contentToUIParts(content: AssistantMessage["content"]): AISDKUIMessagePart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

function userOrSystemContentToUIParts(content: string | ContentPart[]): AISDKUIMessagePart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.flatMap<AISDKUIMessagePart>((part) => {
		if (part.type === "text") return [{ type: "text", text: part.text }];
		if (part.type === "image_url" && "url" in part.image_url) {
			return [{ type: "file", url: part.image_url.url, mediaType: "image" }];
		}
		if (part.type === "file" && "url" in part.file) {
			return [
				{
					type: "file",
					url: part.file.url,
					mediaType: "application/octet-stream",
					filename: part.filename,
				},
			];
		}
		return [];
	});
}

export function toAISDKUIMessage(
	result: RunResult<unknown> | ChatMessage[],
	options?: ToAISDKUIMessageOptions,
): AISDKUIMessage {
	const messages = Array.isArray(result) ? result : result.messages;
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
	return {
		id: options?.id ?? crypto.randomUUID(),
		role: "assistant",
		metadata: options?.metadata,
		parts: lastAssistant ? contentToUIParts(lastAssistant.content) : [],
	};
}

function finishReasonFromEvent(event: Extract<StreamEvent, { type: "done" }>): string | undefined {
	switch (event.response.finishReason) {
		case "stop":
		case "length":
		case "content_filter":
			return event.response.finishReason;
		case "tool_calls":
			return "tool-calls";
		default:
			return event.response.finishReason;
	}
}

export function toAISDKToolApprovalRequests(
	interrupted: InterruptedRunResult<unknown>,
): AISDKUIMessageChunk[] {
	return interrupted.pendingToolCalls.map((call) => ({
		type: "tool-approval-request",
		approvalId: call.toolCallId,
		toolCallId: call.toolCallId,
		isAutomatic: false,
	}));
}

export function approvalsFromAISDKMessages(
	messages: AISDKMessage[],
	pendingToolCalls: PendingToolCall[],
): ToolApproval[] {
	const pending = new Set(pendingToolCalls.map((call) => call.toolCallId));
	const approvals = new Map<string, ToolApproval>();

	for (const message of messages) {
		if (!isUIMessage(message)) continue;
		for (const part of message.parts) {
			const toolName = toolNameFromUIPart(part);
			if (!toolName || !("toolCallId" in part)) continue;
			const toolPart = part as AISDKToolUIPart;
			if (!pending.has(toolPart.toolCallId)) continue;
			if (toolPart.state === "approval-responded" || toolPart.state === "output-denied") {
				const approved = toolPart.approval?.approved === true;
				approvals.set(toolPart.toolCallId, {
					toolCallId: toolPart.toolCallId,
					decision: approved ? "approve" : "deny",
					denyMessage: approved
						? undefined
						: (toolPart.approval?.reason ?? "Tool call denied by user"),
				});
			}
		}
	}

	return [...approvals.values()];
}

export async function* toAISDKUIMessageChunks(
	events: AsyncIterable<StreamEvent>,
	options?: ToAISDKUIMessageStreamOptions,
): AsyncGenerator<AISDKUIMessageChunk> {
	const textId = options?.textId ?? "stratus-text";
	const toolInputs = new Map<string, { toolName: string; text: string; available: boolean }>();
	let startedText = false;
	let endedText = false;

	if (options?.sendStart !== false) {
		yield {
			type: "start",
			messageId: options?.messageId,
			messageMetadata: options?.messageMetadata,
		};
	}

	for await (const event of events) {
		switch (event.type) {
			case "content_delta":
				if (!startedText) {
					startedText = true;
					yield { type: "text-start", id: textId };
				}
				yield { type: "text-delta", id: textId, delta: event.content };
				break;
			case "tool_call_start":
				toolInputs.set(event.toolCall.id, {
					toolName: event.toolCall.name,
					text: "",
					available: false,
				});
				yield {
					type: "tool-input-start",
					toolCallId: event.toolCall.id,
					toolName: event.toolCall.name,
				};
				break;
			case "tool_call_delta": {
				const input = toolInputs.get(event.toolCallId);
				if (input) input.text += event.arguments;
				yield {
					type: "tool-input-delta",
					toolCallId: event.toolCallId,
					inputTextDelta: event.arguments,
				};
				break;
			}
			case "tool_call_done": {
				const input = toolInputs.get(event.toolCallId);
				if (input && !input.available) {
					input.available = true;
					yield {
						type: "tool-input-available",
						toolCallId: event.toolCallId,
						toolName: input.toolName,
						input: parseJsonish(input.text || "{}"),
					};
				}
				break;
			}
			case "done":
				if (startedText && !endedText) {
					endedText = true;
					yield { type: "text-end", id: textId };
				}
				for (const toolCall of event.response.toolCalls) {
					if (toolInputs.has(toolCall.id)) continue;
					yield {
						type: "tool-input-available",
						toolCallId: toolCall.id,
						toolName: toolCall.function.name,
						input: parseJsonish(toolCall.function.arguments),
					};
				}
				if (options?.sendFinish !== false) {
					yield {
						type: "finish",
						finishReason: finishReasonFromEvent(event),
						messageMetadata: options?.messageMetadata,
					};
				}
				break;
			default:
				yield { type: "data-stratus-event", data: event };
		}
	}
}

async function* appendApprovalRequests<TOutput>(
	events: AsyncIterable<StreamEvent>,
	result: Promise<RunResult<TOutput> | InterruptedRunResult<TOutput>>,
	options?: ToAISDKUIMessageStreamOptions,
): AsyncGenerator<AISDKUIMessageChunk> {
	yield* toAISDKUIMessageChunks(events, { ...options, sendFinish: false });
	const finalResult = await result;
	if (finalResult.interrupted) {
		yield* toAISDKToolApprovalRequests(finalResult as InterruptedRunResult<unknown>);
		if (options?.sendFinish !== false) {
			yield {
				type: "finish",
				finishReason: "tool-calls",
				messageMetadata: options?.messageMetadata,
			};
		}
		return;
	}
	if (options?.sendFinish !== false) {
		yield {
			type: "finish",
			finishReason: mapFinishReason(finalResult.finishReason),
			messageMetadata: options?.messageMetadata,
		};
	}
}

export function toAISDKUIMessageStream(
	events: AsyncIterable<StreamEvent>,
	options?: ToAISDKUIMessageStreamOptions,
): ReadableStream<AISDKUIMessageChunk> {
	const chunks = toAISDKUIMessageChunks(events, options);
	return new ReadableStream({
		async pull(controller) {
			const next = await chunks.next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		async cancel() {
			await chunks.return?.(undefined);
		},
	});
}

function asyncIterableToReadableStream<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	return new ReadableStream<T>({
		async pull(controller) {
			const next = await iterator.next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

function jsonToSseStream(stream: ReadableStream<AISDKUIMessageChunk>): ReadableStream<string> {
	return stream.pipeThrough(
		new TransformStream<AISDKUIMessageChunk, string>({
			transform(chunk, controller) {
				controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
			},
		}),
	);
}

export function createAISDKUIMessageStreamResponse(
	options: AISDKUIMessageStreamResponseInit & { stream: ReadableStream<AISDKUIMessageChunk> },
): Response {
	let sseStream = jsonToSseStream(options.stream);
	if (options.consumeSseStream) {
		const [primary, secondary] = sseStream.tee();
		sseStream = primary;
		options.consumeSseStream({ stream: secondary });
	}

	const headers = new Headers(options.headers);
	headers.set("content-type", "text/event-stream; charset=utf-8");
	headers.set("x-vercel-ai-ui-message-stream", "v1");

	return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
		status: options.status,
		statusText: options.statusText,
		headers,
	});
}

export function createStratusChatResponse<TContext, TOutput = undefined>(
	options: CreateStratusChatResponseOptions<TContext, TOutput>,
): Response {
	const input = fromAISDKMessages(options.messages, {
		convertDataPart: options.convertDataPart,
	});
	const streamed = stream(options.agent, input, options.runOptions);
	const uiStream = asyncIterableToReadableStream(
		appendApprovalRequests(streamed.stream, streamed.result, {
			messageId: options.messageId,
			messageMetadata: options.messageMetadata,
		}),
	);
	return createAISDKUIMessageStreamResponse({ ...options, stream: uiStream });
}

export function resumeStratusChatResponse<TContext, TOutput = undefined>(
	options: ResumeStratusChatResponseOptions<TContext, TOutput>,
): Response {
	const approvals = approvalsFromAISDKMessages(
		options.messages,
		options.interrupted.pendingToolCalls,
	);
	const result = resumeRun<TContext, TOutput>(options.interrupted, approvals, options.runOptions);
	const uiStream = asyncIterableToReadableStream(
		(async function* (): AsyncGenerator<AISDKUIMessageChunk> {
			yield {
				type: "start",
				messageId: options.messageId,
				messageMetadata: options.messageMetadata,
			};
			try {
				const resumed = await result;
				if (resumed.interrupted) {
					yield* toAISDKToolApprovalRequests(resumed as InterruptedRunResult<unknown>);
					yield {
						type: "finish",
						finishReason: "tool-calls",
						messageMetadata: options.messageMetadata,
					};
					return;
				}
				const message = toAISDKUIMessage(resumed as RunResult<unknown>, {
					id: options.messageId,
					metadata: options.messageMetadata,
				});
				const textPart = message.parts.find(isTextUIPart);
				if (textPart) {
					const textId = "stratus-text";
					yield { type: "text-start", id: textId };
					yield { type: "text-delta", id: textId, delta: textPart.text };
					yield { type: "text-end", id: textId };
				}
				yield {
					type: "finish",
					finishReason: mapFinishReason(resumed.finishReason),
					messageMetadata: options.messageMetadata,
				};
			} catch (error) {
				yield {
					type: "error",
					errorText: error instanceof Error ? error.message : String(error),
				};
			}
		})(),
	);
	return createAISDKUIMessageStreamResponse({ ...options, stream: uiStream });
}

export function toAISDKToolSet<TContext>(
	tools: FunctionTool<unknown, TContext>[],
	context: TContext,
): AISDKToolSet<TContext> {
	return Object.fromEntries(
		tools.map((tool) => [
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.parameters,
				execute: (input: unknown, options?: { signal?: AbortSignal }) =>
					tool.execute(context, input, options),
			},
		]),
	);
}

function mapFinishReason(reason: FinishReason | undefined): AISDKLanguageModelFinishReason {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "content_filter":
			return "content-filter";
		case "tool_calls":
			return "tool-calls";
		default:
			return "unknown";
	}
}

function mapUsage(response: Pick<ModelResponse, "usage">): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
} {
	return {
		inputTokens: response.usage?.promptTokens ?? 0,
		outputTokens: response.usage?.completionTokens ?? 0,
		totalTokens: response.usage?.totalTokens ?? 0,
	};
}

function requestFromAISDKCall(options: AISDKLanguageModelCallOptions): ModelRequest {
	const messages = fromAISDKMessages((options.messages ?? options.prompt ?? []) as AISDKMessage[]);
	const reasoningEffort =
		typeof options.reasoningEffort === "string"
			? (options.reasoningEffort as ModelSettings["reasoningEffort"])
			: undefined;
	return {
		messages,
		tools: options.tools?.map((tool) => ({
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description ?? tool.name,
				parameters: tool.inputSchema ?? tool.parameters ?? { type: "object", properties: {} },
			},
		})),
		modelSettings: {
			temperature: typeof options.temperature === "number" ? options.temperature : undefined,
			topP: typeof options.topP === "number" ? options.topP : undefined,
			maxTokens: typeof options.maxOutputTokens === "number" ? options.maxOutputTokens : undefined,
			reasoningEffort,
		},
	};
}

export function toAISDKLanguageModel(
	model: Model,
	options?: { provider?: string; modelId?: string },
): AISDKLanguageModel {
	return {
		specificationVersion: "v2",
		provider: options?.provider ?? "stratus",
		modelId: options?.modelId ?? "stratus-model",
		supportedUrls: {},
		async doGenerate(callOptions) {
			const response = await model.getResponse(requestFromAISDKCall(callOptions), {
				signal: callOptions.abortSignal,
			});
			return {
				content: [
					...(response.content ? [{ type: "text" as const, text: response.content }] : []),
					...response.toolCalls.map((toolCall) => ({
						type: "tool-call" as const,
						toolCallId: toolCall.id,
						toolName: toolCall.function.name,
						input: parseJsonish(toolCall.function.arguments),
					})),
				],
				finishReason: mapFinishReason(response.finishReason),
				usage: mapUsage(response),
				response: { id: response.responseId },
			};
		},
		async doStream(callOptions) {
			const request = requestFromAISDKCall(callOptions);
			const events = model.getStreamedResponse(request, { signal: callOptions.abortSignal });
			return {
				stream: asyncIterableToReadableStream(
					(async function* () {
						for await (const event of events) {
							if (event.type === "content_delta") {
								yield { type: "text-delta" as const, id: "stratus-text", delta: event.content };
							} else if (event.type === "done") {
								for (const toolCall of event.response.toolCalls) {
									yield {
										type: "tool-call" as const,
										toolCallId: toolCall.id,
										toolName: toolCall.function.name,
										input: parseJsonish(toolCall.function.arguments),
									};
								}
								yield {
									type: "finish" as const,
									finishReason: mapFinishReason(event.response.finishReason),
									usage: mapUsage(event.response),
								};
							}
						}
					})(),
				),
			};
		},
	};
}

export async function* toOpenAIAgentsStyleStreamEvents(
	events: AsyncIterable<StreamEvent>,
): AsyncGenerator<OpenAIAgentsStyleStreamEvent> {
	const toolInputs = new Map<string, { toolName: string; text: string }>();
	for await (const event of events) {
		yield { type: "raw_model_stream_event", data: event, source: "stratus" };
		switch (event.type) {
			case "content_delta":
				yield {
					type: "run_item_stream_event",
					name: "message_output_created",
					item: { content: event.content },
				};
				break;
			case "tool_call_start":
				toolInputs.set(event.toolCall.id, { toolName: event.toolCall.name, text: "" });
				yield {
					type: "run_item_stream_event",
					name: "tool_called",
					item: { toolCallId: event.toolCall.id, toolName: event.toolCall.name },
				};
				break;
			case "tool_call_delta": {
				const input = toolInputs.get(event.toolCallId);
				if (input) input.text += event.arguments;
				break;
			}
			case "tool_call_done": {
				const input = toolInputs.get(event.toolCallId);
				yield {
					type: "run_item_stream_event",
					name: "tool_output",
					item: {
						toolCallId: event.toolCallId,
						toolName: input?.toolName,
						input: input ? parseJsonish(input.text || "{}") : undefined,
					},
				};
				break;
			}
			case "subagent_start":
				yield { type: "agent_updated_stream_event", agent: { name: event.agentName } };
				break;
			case "subagent_end":
				yield {
					type: "run_item_stream_event",
					name: "handoff_occurred",
					item: { agentName: event.agentName, result: event.result },
				};
				break;
		}
	}
}
