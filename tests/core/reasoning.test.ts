import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import type { ChatMessage, DeveloperMessage } from "../../src/core/types";

function mockModel(responses: ModelResponse[], capture?: { requests: ModelRequest[] }): Model {
	let callIndex = 0;
	return {
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			capture?.requests.push(request);
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			capture?.requests.push(request);
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

describe("reasoning models", () => {
	test("DeveloperMessage is included in ChatMessage union", () => {
		const msg: DeveloperMessage = { role: "developer", content: "You are a helpful assistant" };
		const chatMsg: ChatMessage = msg;
		expect(chatMsg.role).toBe("developer");
	});

	test("developer messages are passed through to model", async () => {
		const capture: { requests: ModelRequest[] } = { requests: [] };
		const model = mockModel(
			[
				{
					content: "Hello!",
					toolCalls: [],
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				},
			],
			capture,
		);

		const agent = new Agent({ name: "test", model });
		const input: ChatMessage[] = [
			{ role: "developer", content: "You are a helpful coding assistant" },
			{ role: "user", content: "Hi" },
		];
		await run(agent, input);

		const messages = capture.requests[0]!.messages;
		expect(messages[0]!.role).toBe("developer");
		expect((messages[0] as DeveloperMessage).content).toBe("You are a helpful coding assistant");
	});

	test("reasoningEffort is set in modelSettings", async () => {
		const capture: { requests: ModelRequest[] } = { requests: [] };
		const model = mockModel(
			[
				{
					content: "Done",
					toolCalls: [],
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				},
			],
			capture,
		);

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: { reasoningEffort: "high" },
		});
		await run(agent, "Think hard");

		expect(capture.requests[0]!.modelSettings?.reasoningEffort).toBe("high");
	});

	test("maxCompletionTokens is set in modelSettings", async () => {
		const capture: { requests: ModelRequest[] } = { requests: [] };
		const model = mockModel(
			[
				{
					content: "Done",
					toolCalls: [],
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				},
			],
			capture,
		);

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: { maxCompletionTokens: 4096 },
		});
		await run(agent, "Generate");

		expect(capture.requests[0]!.modelSettings?.maxCompletionTokens).toBe(4096);
	});

	test("reasoning tokens are accumulated in usage", async () => {
		const model = mockModel([
			{
				content: "Answer",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60, reasoningTokens: 30 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Reason about this");

		expect(result.usage.reasoningTokens).toBe(30);
	});

	test("reasoning tokens accumulate across turns", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 30, totalTokens: 40, reasoningTokens: 20 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60, reasoningTokens: 25 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [
				tool({
					name: "noop",
					description: "Does nothing",
					parameters: z.object({}),
					execute: async () => "ok",
				}),
			],
		});
		const result = await run(agent, "Think step by step");

		expect(result.usage.reasoningTokens).toBe(45);
	});

	test("reasoning tokens in streamed response", async () => {
		const model = mockModel([
			{
				content: "Answer",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60, reasoningTokens: 35 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "Reason");

		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.usage.reasoningTokens).toBe(35);
	});
});
