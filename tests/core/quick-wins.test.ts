import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { RunContext } from "../../src/core/context";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run, stream } from "../../src/core/run";
import { createSession, prompt } from "../../src/core/session";
import { tool } from "../../src/core/tool";
import type { ContentPart } from "../../src/core/types";

function mockModel(
	responses: ModelResponse[],
): Model & { requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	return {
		requests,
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			if (response.content) {
				yield { type: "content_delta", content: response.content };
			}
			for (const tc of response.toolCalls) {
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield { type: "tool_call_delta", toolCallId: tc.id, arguments: tc.function.arguments };
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

describe("finishReason", () => {
	test("available on RunResult from run()", async () => {
		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.finishReason).toBe("stop");
	});

	test("available on RunResult from stream()", async () => {
		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "Hi");

		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.finishReason).toBe("stop");
	});

	test("tracks last model call after tool loop", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "greet", arguments: '{"name":"world"}' } },
				],
				finishReason: "tool_calls",
			},
			{
				content: "Hello world!",
				toolCalls: [],
				finishReason: "stop",
			},
		]);

		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => `Hi ${params.name}`,
		});

		const agent = new Agent({ name: "test", model, tools: [greetTool] });
		const result = await run(agent, "Greet the world");

		expect(result.finishReason).toBe("stop");
	});

	test("finishReason on toolUseBehavior stop", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "greet", arguments: '{"name":"world"}' } },
				],
				finishReason: "tool_calls",
			},
		]);

		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => `Hi ${params.name}`,
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [greetTool],
			toolUseBehavior: "stop_on_first_tool",
		});
		const result = await run(agent, "Greet");

		expect(result.finishReason).toBe("tool_calls");
	});

	test("undefined when model does not provide finishReason", async () => {
		const model = mockModel([
			{ content: "Hi", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.finishReason).toBeUndefined();
	});
});

describe("cache tokens", () => {
	test("accumulate across calls", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } },
				],
				usage: {
					promptTokens: 100,
					completionTokens: 10,
					totalTokens: 110,
					cacheReadTokens: 50,
				},
			},
			{
				content: "Done",
				toolCalls: [],
				usage: {
					promptTokens: 120,
					completionTokens: 5,
					totalTokens: 125,
					cacheReadTokens: 80,
				},
			},
		]);

		const noopTool = tool({
			name: "noop",
			description: "No-op",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [noopTool] });
		const result = await run(agent, "test");

		expect(result.usage.cacheReadTokens).toBe(130);
		expect(result.usage.cacheCreationTokens).toBeUndefined();
	});

	test("undefined when absent", async () => {
		const model = mockModel([
			{
				content: "Hi",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.usage.cacheReadTokens).toBeUndefined();
		expect(result.usage.cacheCreationTokens).toBeUndefined();
	});

	test("RunContext.addUsage accumulates cacheCreationTokens", () => {
		const ctx = new RunContext(undefined);
		ctx.addUsage({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			cacheCreationTokens: 20,
		});
		ctx.addUsage({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			cacheCreationTokens: 30,
		});
		expect(ctx.usage.cacheCreationTokens).toBe(50);
	});
});

describe("multimodal UserMessage", () => {
	test("run() with ContentPart[] input messages", async () => {
		const model = mockModel([
			{
				content: "I see an image",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{ type: "image_url", image_url: { url: "https://example.com/img.png" } },
				],
			},
		]);

		expect(result.output).toBe("I see an image");
		// No system message, so user message is at index 0
		expect(model.requests[0]!.messages[0]!.role).toBe("user");
	});

	test("session.send() with ContentPart[]", async () => {
		const model = mockModel([
			{ content: "I see it", toolCalls: [] },
		]);

		const session = createSession({ model });
		const parts: ContentPart[] = [
			{ type: "text", text: "Describe this" },
			{ type: "image_url", image_url: { url: "https://example.com/img.png", detail: "high" } },
		];
		session.send(parts);

		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.output).toBe("I see it");
	});

	test("prompt() with ContentPart[]", async () => {
		const model = mockModel([
			{ content: "Described", toolCalls: [] },
		]);

		const parts: ContentPart[] = [
			{ type: "text", text: "Describe" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
		];

		const result = await prompt(parts, { model });
		expect(result.output).toBe("Described");
	});

	test("extractUserText extracts text-only from multimodal messages", async () => {
		const hookInput: string[] = [];
		const model = mockModel([
			{ content: "Ok", toolCalls: [] },
		]);

		const agent = new Agent({
			name: "test",
			model,
			hooks: {
				beforeRun: ({ input }) => {
					hookInput.push(input);
				},
			},
		});

		await run(agent, [
			{
				role: "user",
				content: [
					{ type: "text", text: "Hello" },
					{ type: "image_url", image_url: { url: "https://example.com/img.png" } },
					{ type: "text", text: "World" },
				],
			},
		]);

		expect(hookInput[0]).toBe("Hello\nWorld");
	});
});
