import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	approvalsFromAISDKMessages,
	createAISDKUIMessageStreamResponse,
	createStratusChatResponse,
	fromAISDKMessages,
	resumeSessionFromAISDKMessages,
	resumeStratusChatResponse,
	toAISDKLanguageModel,
	toAISDKToolApprovalRequests,
	toAISDKToolSet,
	toAISDKUIMessage,
	toAISDKUIMessageChunks,
	toAISDKUIMessageStream,
	toAISDKUIMessages,
	toOpenAIAgentsStyleStreamEvents,
} from "../../src/ai-sdk/index";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { InterruptedRunResult, RunResult } from "../../src/core/result";
import { run } from "../../src/core/run";
import { tool } from "../../src/core/tool";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

function response(content: string): ModelResponse {
	return {
		content,
		toolCalls: [],
		finishReason: "stop",
		usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
	};
}

function mockModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	return {
		requests,
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			requests.push(structuredClone(request));
			const next = responses[callIndex++];
			if (!next) throw new Error("No more mock responses");
			return next;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			requests.push(structuredClone(request));
			const next = responses[callIndex++];
			if (!next) throw new Error("No more mock responses");
			if (next.content) yield { type: "content_delta", content: next.content };
			for (const tc of next.toolCalls) {
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield {
					type: "tool_call_delta",
					toolCallId: tc.id,
					arguments: tc.function.arguments,
				};
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response: next };
		},
	};
}

describe("ai-sdk interop", () => {
	test("converts UI messages with tool output into Stratus chat messages", () => {
		const messages = fromAISDKMessages([
			{
				id: "u1",
				role: "user",
				parts: [
					{ type: "text", text: "Check weather" },
					{ type: "file", url: "https://example.com/photo.png", mediaType: "image/png" },
				],
			},
			{
				id: "a1",
				role: "assistant",
				parts: [
					{ type: "text", text: "I will check." },
					{
						type: "tool-weather",
						toolCallId: "call_1",
						state: "output-available",
						input: { city: "Austin" },
						output: { temp: 72 },
					},
				],
			},
		]);

		expect(messages[0]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Check weather" },
				{ type: "image_url", image_url: { url: "https://example.com/photo.png" } },
			],
		});
		expect(messages[1]).toEqual({
			role: "assistant",
			content: "I will check.",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "weather", arguments: '{"city":"Austin"}' },
				},
			],
		});
		expect(messages[2]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: '{"temp":72}',
		});
	});

	test("converts AI SDK model messages into Stratus chat messages", () => {
		const messages = fromAISDKMessages([
			{ role: "system", content: "Be brief" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Calling a tool" },
					{ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { id: 7 } },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "lookup",
						output: { type: "text", value: "found" },
					},
				],
			},
		]);

		expect(messages).toEqual([
			{ role: "system", content: "Be brief" },
			{
				role: "assistant",
				content: "Calling a tool",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"id":7}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "found" },
		]);
	});

	test("converts Stratus stream events to AI SDK UI message chunks", async () => {
		async function* events(): AsyncGenerator<StreamEvent> {
			yield { type: "content_delta", content: "Hi " };
			yield { type: "content_delta", content: "there" };
			yield { type: "tool_call_start", toolCall: { id: "call_1", name: "lookup" } };
			yield { type: "tool_call_delta", toolCallId: "call_1", arguments: '{"id":' };
			yield { type: "tool_call_delta", toolCallId: "call_1", arguments: "7}" };
			yield { type: "tool_call_done", toolCallId: "call_1" };
			yield {
				type: "done",
				response: {
					content: "Hi there",
					toolCalls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "lookup", arguments: '{"id":7}' },
						},
					],
					finishReason: "tool_calls",
				},
			};
		}

		const chunks = await collect(toAISDKUIMessageChunks(events(), { messageId: "m1" }));

		expect(chunks[0]).toEqual({ type: "start", messageId: "m1", messageMetadata: undefined });
		expect(chunks).toContainEqual({ type: "text-start", id: "stratus-text" });
		expect(chunks).toContainEqual({ type: "text-delta", id: "stratus-text", delta: "Hi " });
		expect(chunks).toContainEqual({ type: "text-end", id: "stratus-text" });
		expect(chunks).toContainEqual({
			type: "tool-input-available",
			toolCallId: "call_1",
			toolName: "lookup",
			input: { id: 7 },
		});
		expect(chunks.at(-1)).toEqual({
			type: "finish",
			finishReason: "tool-calls",
			messageMetadata: undefined,
		});
	});

	test("creates an AI SDK UI message SSE response", async () => {
		async function* events(): AsyncGenerator<StreamEvent> {
			yield { type: "content_delta", content: "Hello" };
			yield { type: "done", response: response("Hello") };
		}

		const stream = toAISDKUIMessageStream(events(), { messageId: "m1" });
		const res = createAISDKUIMessageStreamResponse({ stream });

		expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const body = await res.text();
		expect(body).toContain('data: {"type":"start","messageId":"m1"}');
		expect(body).toContain('data: {"type":"text-delta","id":"stratus-text","delta":"Hello"}');
	});

	test("converts a RunResult to an assistant UI message", () => {
		const result = new RunResult({
			output: "Done",
			messages: [
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: "Done" },
			],
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			lastAgent: {} as never,
		});

		expect(toAISDKUIMessage(result, { id: "m1" })).toEqual({
			id: "m1",
			role: "assistant",
			metadata: undefined,
			parts: [{ type: "text", text: "Done" }],
		});
	});

	test("converts Stratus history to UI messages and resumes a session from UI messages", () => {
		const uiMessages = toAISDKUIMessages([
			{ role: "user", content: "What is the weather?" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "weather", arguments: '{"city":"Austin"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "72F" },
			{ role: "assistant", content: "It is 72F." },
		]);

		expect(uiMessages[1]?.parts).toContainEqual({
			type: "tool-weather",
			toolCallId: "call_1",
			state: "output-available",
			input: { city: "Austin" },
			output: "72F",
		});

		const model = mockModel([{ content: "next", toolCalls: [] }]);
		const session = resumeSessionFromAISDKMessages(uiMessages, { model }, { id: "s1" });
		expect(session.id).toBe("s1");
		expect(session.messages.some((message) => message.role === "tool")).toBe(true);
	});

	test("converts Stratus tools to an AI SDK-style tool set", async () => {
		const add = tool({
			name: "add",
			description: "Add numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: (context: { prefix: string }, { a, b }) => `${context.prefix}${a + b}`,
		});

		const tools = toAISDKToolSet([add], { prefix: "=" });

		expect(Object.keys(tools)).toEqual(["add"]);
		expect(tools.add.description).toBe("Add numbers");
		expect(await tools.add.execute({ a: 2, b: 3 })).toBe("=5");
	});

	test("creates a one-call Stratus chat response from UI messages", async () => {
		const model = mockModel([
			{ content: "Hello from Stratus", toolCalls: [], finishReason: "stop" },
		]);
		const agent = new Agent({ name: "assistant", model });

		const res = createStratusChatResponse({
			agent,
			messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
			messageId: "m1",
		});

		const body = await res.text();
		expect(body).toContain(
			'data: {"type":"text-delta","id":"stratus-text","delta":"Hello from Stratus"}',
		);
		expect(body).toContain('data: {"type":"finish","finishReason":"stop"}');
		expect(model.requests[0]?.messages).toEqual([{ role: "user", content: "Hi" }]);
	});

	test("bridges Stratus tool approvals to and from AI SDK UI messages", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/a"}' },
					},
				],
			},
			{ content: "Deleted.", toolCalls: [], finishReason: "stop" },
		]);
		const deleteFile = tool({
			name: "delete_file",
			description: "Delete a file",
			parameters: z.object({ path: z.string() }),
			execute: (_ctx, { path }) => `Deleted ${path}`,
			needsApproval: true,
		});
		const agent = new Agent({ name: "assistant", model, tools: [deleteFile] });
		const interrupted = await run(agent, "Delete it");

		expect(interrupted).toBeInstanceOf(InterruptedRunResult);
		if (!(interrupted instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		expect(toAISDKToolApprovalRequests(interrupted)).toEqual([
			{
				type: "tool-approval-request",
				approvalId: "call_1",
				toolCallId: "call_1",
				isAutomatic: false,
			},
		]);

		const approvalMessages = [
			{
				id: "a1",
				role: "assistant" as const,
				parts: [
					{
						type: "tool-delete_file" as const,
						toolCallId: "call_1",
						state: "approval-responded" as const,
						input: { path: "/tmp/a" },
						approval: { approved: true },
					},
				],
			},
		];
		expect(approvalsFromAISDKMessages(approvalMessages, interrupted.pendingToolCalls)).toEqual([
			{ toolCallId: "call_1", decision: "approve", denyMessage: undefined },
		]);

		const res = resumeStratusChatResponse({
			interrupted,
			messages: approvalMessages,
			messageId: "m2",
		});
		const body = await res.text();
		expect(body).toContain('data: {"type":"text-delta","id":"stratus-text","delta":"Deleted."}');
	});

	test("chat response emits approval chunks when Stratus interrupts", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/a"}' },
					},
				],
				finishReason: "tool_calls",
			},
		]);
		const deleteFile = tool({
			name: "delete_file",
			description: "Delete a file",
			parameters: z.object({ path: z.string() }),
			execute: () => "deleted",
			needsApproval: true,
		});
		const agent = new Agent({ name: "assistant", model, tools: [deleteFile] });

		const res = createStratusChatResponse({
			agent,
			messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Delete it" }] }],
		});
		const body = await res.text();
		expect(body).toContain(
			'data: {"type":"tool-approval-request","approvalId":"call_1","toolCallId":"call_1","isAutomatic":false}',
		);
	});

	test("adapts a Stratus model to an AI SDK-style language model", async () => {
		const model = mockModel([
			{
				content: "Generated",
				toolCalls: [],
				finishReason: "stop",
				usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
			},
			{
				content: "Streamed",
				toolCalls: [],
				finishReason: "stop",
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			},
		]);
		const languageModel = toAISDKLanguageModel(model, { modelId: "test-model" });

		const generated = await languageModel.doGenerate({
			messages: [{ role: "user", content: "Hi" }],
		});
		expect(generated.content).toEqual([{ type: "text", text: "Generated" }]);
		expect(generated.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });

		const streamed = await languageModel.doStream({
			messages: [{ role: "user", content: "Hi again" }],
		});
		const chunks = await Array.fromAsync(streamed.stream);
		expect(chunks).toContainEqual({ type: "text-delta", id: "stratus-text", delta: "Streamed" });
		expect(chunks).toContainEqual({
			type: "finish",
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});
	});

	test("projects Stratus stream events into OpenAI Agents-style events", async () => {
		async function* events(): AsyncGenerator<StreamEvent> {
			yield { type: "content_delta", content: "Hi" };
			yield { type: "tool_call_start", toolCall: { id: "call_1", name: "lookup" } };
			yield { type: "tool_call_delta", toolCallId: "call_1", arguments: '{"id":7}' };
			yield { type: "tool_call_done", toolCallId: "call_1" };
			yield { type: "subagent_start", agentName: "researcher" };
			yield { type: "subagent_end", agentName: "researcher", result: "done" };
		}

		const projected = await collect(toOpenAIAgentsStyleStreamEvents(events()));
		expect(projected).toContainEqual({
			type: "run_item_stream_event",
			name: "tool_called",
			item: { toolCallId: "call_1", toolName: "lookup" },
		});
		expect(projected).toContainEqual({
			type: "agent_updated_stream_event",
			agent: { name: "researcher" },
		});
	});
});
