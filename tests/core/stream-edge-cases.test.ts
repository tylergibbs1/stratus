import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { RunAbortedError, StratusError } from "../../src/core/errors";
import type { Model, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream } from "../../src/core/run";
import { tool } from "../../src/core/tool";

function textResponse(content: string): ModelResponse {
	return { content, toolCalls: [] };
}

function toolCallResponse(calls: { id: string; name: string; args: string }[]): ModelResponse {
	return {
		content: null,
		toolCalls: calls.map((c) => ({
			id: c.id,
			type: "function" as const,
			function: { name: c.name, arguments: c.args },
		})),
	};
}

// A streaming model that yields content in multiple chunks
function chunkingStreamModel(responses: ModelResponse[]): Model {
	let callIndex = 0;
	return {
		async getResponse(): Promise<ModelResponse> {
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			if (response.content) {
				// Split content into individual characters for granular streaming
				for (const char of response.content) {
					yield { type: "content_delta", content: char };
				}
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

describe("stream edge cases", () => {
	test("abort signal during streaming rejects result", async () => {
		const ac = new AbortController();

		// Model that yields some content then the caller aborts
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				return textResponse("Hello");
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "content_delta", content: "Hel" };
				ac.abort();
				yield { type: "content_delta", content: "lo" };
				yield { type: "done", response: textResponse("Hello") };
			},
		};

		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "Hi", { signal: ac.signal });

		const events: StreamEvent[] = [];
		let streamThrew = false;
		try {
			for await (const e of s) events.push(e);
		} catch {
			streamThrew = true;
		}

		expect(streamThrew).toBe(true);
		await expect(result).rejects.toThrow(RunAbortedError);
	});

	test("abort signal between tool execution and next model call in stream", async () => {
		const ac = new AbortController();

		const model = chunkingStreamModel([
			toolCallResponse([{ id: "tc1", name: "t", args: "{}" }]),
			textResponse("Should not reach."),
		]);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => {
				ac.abort();
				return "done";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		const { stream: s, result } = stream(agent, "Go", { signal: ac.signal });

		let threw = false;
		try {
			for await (const _e of s) {
			}
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
		await expect(result).rejects.toThrow(RunAbortedError);
	});

	test("stream collects all content deltas into final output", async () => {
		const model = chunkingStreamModel([textResponse("Hello world")]);
		const agent = new Agent({ name: "test", model });

		const { stream: s, result } = stream(agent, "Hi");

		const contentDeltas: string[] = [];
		for await (const e of s) {
			if (e.type === "content_delta") contentDeltas.push(e.content);
		}

		const r = await result;
		// Each char is a separate delta
		expect(contentDeltas.join("")).toBe("Hello world");
		expect(r.output).toBe("Hello world");
	});

	test("stream with tool call produces correct event sequence", async () => {
		const model = chunkingStreamModel([
			toolCallResponse([{ id: "tc1", name: "greet", args: '{"name":"World"}' }]),
			textResponse("Hi World!"),
		]);

		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, { name }) => `Hi ${name}!`,
		});

		const agent = new Agent({ name: "test", model, tools: [greetTool] });
		const { stream: s, result } = stream(agent, "Greet World");

		const eventTypes: string[] = [];
		for await (const e of s) {
			eventTypes.push(e.type);
		}

		// First turn: tool_call_start, tool_call_delta, tool_call_done, done
		// Second turn: content_delta(s), done
		expect(eventTypes.filter((t) => t === "done")).toHaveLength(2);
		expect(eventTypes).toContain("tool_call_start");
		expect(eventTypes).toContain("content_delta");

		const r = await result;
		expect(r.output).toBe("Hi World!");
	});

	test("stream model that throws propagates to both stream and result", async () => {
		const failingModel: Model = {
			async getResponse(): Promise<ModelResponse> {
				throw new Error("Model exploded");
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				throw new Error("Model exploded");
			},
		};

		const agent = new Agent({ name: "test", model: failingModel });
		const { stream: s, result } = stream(agent, "Hi");

		let streamError: Error | undefined;
		try {
			for await (const _e of s) {
			}
		} catch (e) {
			streamError = e as Error;
		}

		expect(streamError).toBeDefined();
		expect(streamError!.message).toBe("Model exploded");
		await expect(result).rejects.toThrow("Model exploded");
	});

	test("stream without done event throws StratusError", async () => {
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				return textResponse("hello");
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "content_delta", content: "hello" };
				// Missing done event
			},
		};

		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "Hi");

		let threw = false;
		try {
			for await (const _e of s) {
			}
		} catch (e) {
			if (e instanceof StratusError) threw = true;
		}

		expect(threw).toBe(true);
		await expect(result).rejects.toThrow(StratusError);
	});

	test("stream numTurns counts correctly across tool calls", async () => {
		const model = chunkingStreamModel([
			toolCallResponse([{ id: "tc1", name: "t", args: "{}" }]),
			toolCallResponse([{ id: "tc2", name: "t", args: "{}" }]),
			textResponse("Done"),
		]);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		const { stream: s, result } = stream(agent, "Go");

		for await (const _e of s) {
		}

		const r = await result;
		expect(r.numTurns).toBe(3);
		expect(r.output).toBe("Done");
	});

	test("stream usage accumulates across turns", async () => {
		const responses: ModelResponse[] = [
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "t", arguments: "{}" } }],
				usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
			},
		];

		const model = chunkingStreamModel(responses);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		const { stream: s, result } = stream(agent, "Go");

		for await (const _e of s) {
		}

		const r = await result;
		expect(r.usage.promptTokens).toBe(300);
		expect(r.usage.completionTokens).toBe(130);
		expect(r.usage.totalTokens).toBe(430);
	});
});
