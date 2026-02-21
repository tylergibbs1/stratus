import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run, stream } from "../../src/core/run";
import { tool } from "../../src/core/tool";

function mockModel(responses: ModelResponse[]): Model {
	let callIndex = 0;
	return {
		async getResponse(_request: ModelRequest): Promise<ModelResponse> {
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(_request: ModelRequest): AsyncGenerator<StreamEvent> {
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

describe("numTurns", () => {
	test("single turn returns numTurns = 1", async () => {
		const model = mockModel([
			{ content: "Hello!", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
		]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.numTurns).toBe(1);
	});

	test("two turns with tool call returns numTurns = 2", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "noop",
				description: "noop",
				parameters: z.object({}),
				execute: async () => "ok",
			})],
		});
		const result = await run(agent, "Do something");

		expect(result.numTurns).toBe(2);
	});

	test("three turns returns numTurns = 3", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: null,
				toolCalls: [{ id: "tc2", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "noop",
				description: "noop",
				parameters: z.object({}),
				execute: async () => "ok",
			})],
		});
		const result = await run(agent, "Do things");

		expect(result.numTurns).toBe(3);
	});

	test("numTurns in streamed result", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "noop",
				description: "noop",
				parameters: z.object({}),
				execute: async () => "ok",
			})],
		});

		const { stream: s, result } = stream(agent, "Do something");
		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.numTurns).toBe(2);
	});

	test("stop_on_first_tool counts the single turn", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			toolUseBehavior: "stop_on_first_tool",
			tools: [tool({
				name: "noop",
				description: "noop",
				parameters: z.object({}),
				execute: async () => "tool_result",
			})],
		});
		const result = await run(agent, "Do it");

		expect(result.numTurns).toBe(1);
	});
});
