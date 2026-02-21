import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { MaxTurnsExceededError } from "../../src/core/errors";
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
				yield {
					type: "tool_call_delta",
					toolCallId: tc.id,
					arguments: tc.function.arguments,
				};
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

describe("run", () => {
	test("simple text response", async () => {
		const model = mockModel([
			{ content: "Hello!", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.output).toBe("Hello!");
		expect(result.usage.totalTokens).toBe(15);
	});

	test("tool call loop", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
				],
			},
			{
				content: "The weather in NYC is sunny.",
				toolCalls: [],
			},
		]);

		const weatherTool = tool({
			name: "get_weather",
			description: "Get weather",
			parameters: z.object({ city: z.string() }),
			execute: async (_ctx, params) => `Sunny in ${params.city}`,
		});

		const agent = new Agent({ name: "test", model, tools: [weatherTool] });
		const result = await run(agent, "What's the weather in NYC?");

		expect(result.output).toBe("The weather in NYC is sunny.");
		expect(result.messages).toHaveLength(4); // user, assistant(tool_call), tool, assistant
	});

	test("parallel tool calls", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } },
					{ id: "tc2", type: "function", function: { name: "add", arguments: '{"a":3,"b":4}' } },
				],
			},
			{
				content: "1+2=3 and 3+4=7",
				toolCalls: [],
			},
		]);

		const addTool = tool({
			name: "add",
			description: "Add numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const agent = new Agent({ name: "test", model, tools: [addTool] });
		const result = await run(agent, "Add these");

		expect(result.output).toBe("1+2=3 and 3+4=7");
		// user, assistant(2 tool_calls), tool, tool, assistant
		expect(result.messages).toHaveLength(5);
	});

	test("max turns exceeded", async () => {
		const model = mockModel(
			Array.from({ length: 5 }, () => ({
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } },
				],
			})),
		);

		const noopTool = tool({
			name: "noop",
			description: "No-op",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [noopTool] });

		expect(run(agent, "loop", { maxTurns: 3 })).rejects.toThrow(MaxTurnsExceededError);
	});

	test("unknown tool returns error message", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "nonexistent", arguments: "{}" } },
				],
			},
			{
				content: "I couldn't find that tool.",
				toolCalls: [],
			},
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "call something");

		expect(result.output).toBe("I couldn't find that tool.");
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg?.role === "tool") {
			expect(toolMsg.content).toContain("Unknown tool");
		}
	});

	test("system prompt from function", async () => {
		const model = mockModel([
			{ content: "I'm helpful!", toolCalls: [] },
		]);

		const agent = new Agent({
			name: "test",
			model,
			instructions: async (ctx: { persona: string }) => `You are ${ctx.persona}`,
		});

		const result = await run(agent, "Hello", { context: { persona: "a helpful assistant" } });
		expect(result.output).toBe("I'm helpful!");
		expect(result.messages[0]?.role).toBe("system");
		if (result.messages[0]?.role === "system") {
			expect(result.messages[0].content).toBe("You are a helpful assistant");
		}
	});

	test("no model throws", async () => {
		const agent = new Agent({ name: "test" });
		expect(run(agent, "hi")).rejects.toThrow("No model provided");
	});
});

describe("stream", () => {
	test("streams content deltas", async () => {
		const model = mockModel([
			{ content: "Hello world", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model });
		const events: StreamEvent[] = [];
		for await (const event of stream(agent, "Hi").stream) {
			events.push(event);
		}

		expect(events.some((e) => e.type === "content_delta")).toBe(true);
		expect(events.some((e) => e.type === "done")).toBe(true);
	});

	test("streams with tool calls", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "greet", arguments: '{"name":"World"}' } },
				],
			},
			{
				content: "Hello, World!",
				toolCalls: [],
			},
		]);

		const greetTool = tool({
			name: "greet",
			description: "Greet someone",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, { name }) => `Hi ${name}!`,
		});

		const agent = new Agent({ name: "test", model, tools: [greetTool] });
		const events: StreamEvent[] = [];
		for await (const event of stream(agent, "Greet World").stream) {
			events.push(event);
		}

		expect(events.filter((e) => e.type === "done")).toHaveLength(2);
		expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
	});
});
