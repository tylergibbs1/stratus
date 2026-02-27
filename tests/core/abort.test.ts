import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { RunAbortedError } from "../../src/core/errors";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
import { createSession } from "../../src/core/session";
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

describe("abort signal", () => {
	test("pre-aborted signal throws immediately", async () => {
		const model = mockModel([{ content: "Hi", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });

		const ac = new AbortController();
		ac.abort();

		await expect(run(agent, "Hi", { signal: ac.signal })).rejects.toThrow(RunAbortedError);
	});

	test("abort between turns throws RunAbortedError", async () => {
		const ac = new AbortController();

		const noopTool = tool({
			name: "noop",
			description: "noop",
			parameters: z.object({}),
			execute: async () => {
				ac.abort();
				return "ok";
			},
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
			},
			{ content: "Should not reach", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [noopTool] });

		await expect(run(agent, "test", { signal: ac.signal })).rejects.toThrow(RunAbortedError);
	});

	test("signal passed to model", async () => {
		const receivedSignals: (AbortSignal | undefined)[] = [];

		const model: Model = {
			async getResponse(_request, options) {
				receivedSignals.push(options?.signal);
				return { content: "Hi", toolCalls: [] };
			},
			async *getStreamedResponse() {
				yield { type: "done", response: { content: "Hi", toolCalls: [] } };
			},
		};

		const agent = new Agent({ name: "test", model });
		const ac = new AbortController();
		await run(agent, "Hi", { signal: ac.signal });

		expect(receivedSignals[0]).toBe(ac.signal);
	});

	test("signal passed to tool execute", async () => {
		const receivedSignals: (AbortSignal | undefined)[] = [];

		const testTool = tool({
			name: "test_tool",
			description: "test",
			parameters: z.object({}),
			execute: async (_ctx, _params, options) => {
				receivedSignals.push(options?.signal);
				return "ok";
			},
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "test_tool", arguments: "{}" } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [testTool] });
		const ac = new AbortController();
		await run(agent, "test", { signal: ac.signal });

		expect(receivedSignals[0]).toBe(ac.signal);
	});

	test("abort during stream rejects result promise", async () => {
		const ac = new AbortController();

		const noopTool = tool({
			name: "noop",
			description: "noop",
			parameters: z.object({}),
			execute: async () => {
				ac.abort();
				return "ok";
			},
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
			},
			{ content: "Should not reach", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [noopTool] });
		const { stream: s, result } = stream(agent, "test", { signal: ac.signal });

		try {
			for await (const _event of s) {
				// drain
			}
		} catch {
			// stream may throw
		}

		await expect(result).rejects.toThrow(RunAbortedError);
	});

	test("session.stream({ signal }) cancels", async () => {
		const ac = new AbortController();

		const noopTool = tool({
			name: "noop",
			description: "noop",
			parameters: z.object({}),
			execute: async () => {
				ac.abort();
				return "ok";
			},
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
			},
			{ content: "Should not reach", toolCalls: [] },
		]);

		const session = createSession({ model, tools: [noopTool] });
		session.send("test");

		let threw = false;
		try {
			for await (const _event of session.stream({ signal: ac.signal })) {
				// drain
			}
		} catch (e) {
			if (e instanceof RunAbortedError) threw = true;
		}

		expect(threw).toBe(true);
	});
});
