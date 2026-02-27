import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { createSession, prompt } from "../../src/core/session";
import { tool } from "../../src/core/tool";

function mockModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
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
				yield {
					type: "tool_call_start",
					toolCall: { id: tc.id, name: tc.function.name },
				};
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

describe("prompt", () => {
	test("returns RunResult with output", async () => {
		const model = mockModel([
			{
				content: "4",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
			},
		]);

		const result = await prompt("What is 2+2?", { model });

		expect(result.output).toBe("4");
		expect(result.usage.totalTokens).toBe(11);
	});

	test("prompt with tools", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "add", arguments: '{"a":2,"b":2}' },
					},
				],
			},
			{ content: "The answer is 4.", toolCalls: [] },
		]);

		const addTool = tool({
			name: "add",
			description: "Add two numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const result = await prompt("What is 2+2?", { model, tools: [addTool] });

		expect(result.output).toBe("The answer is 4.");
	});
});

describe("session", () => {
	test("send + stream yields events and resolves result", async () => {
		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const session = createSession({ model });
		session.send("Hi");

		const events: StreamEvent[] = [];
		for await (const event of session.stream()) {
			events.push(event);
		}

		expect(events.some((e) => e.type === "content_delta")).toBe(true);
		expect(events.some((e) => e.type === "done")).toBe(true);

		const result = await session.result;
		expect(result.output).toBe("Hello!");
		expect(result.usage.totalTokens).toBe(15);
	});

	test("multi-turn context persists", async () => {
		const model = mockModel([
			{ content: "NYC weather is sunny.", toolCalls: [] },
			{ content: "London weather is rainy.", toolCalls: [] },
		]);

		const session = createSession({ model });

		// Turn 1
		session.send("Weather in NYC?");
		for await (const _event of session.stream()) {
			// drain
		}

		// Turn 2
		session.send("What about London?");
		for await (const _event of session.stream()) {
			// drain
		}

		// Verify the second request included first turn's messages
		const secondRequest = model.requests[1]!;
		const userMessages = secondRequest.messages.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(2);
		expect(userMessages[0]!.content).toBe("Weather in NYC?");
		expect(userMessages[1]!.content).toBe("What about London?");

		// Assistant message from turn 1 should be in turn 2's context
		const assistantMessages = secondRequest.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]!.content).toBe("NYC weather is sunny.");
	});

	test("session with tools", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "get_weather", arguments: '{"city":"NYC"}' },
					},
				],
			},
			{ content: "It's sunny in NYC!", toolCalls: [] },
		]);

		const weatherTool = tool({
			name: "get_weather",
			description: "Get weather",
			parameters: z.object({ city: z.string() }),
			execute: async (_ctx, { city }) => `Sunny in ${city}`,
		});

		const session = createSession({ model, tools: [weatherTool] });
		session.send("Weather in NYC?");

		const events: StreamEvent[] = [];
		for await (const event of session.stream()) {
			events.push(event);
		}

		const result = await session.result;
		expect(result.output).toBe("It's sunny in NYC!");
		expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
	});

	test("session with structured output", async () => {
		const schema = z.object({ answer: z.number() });
		const model = mockModel([
			{
				content: '{"answer":42}',
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const session = createSession({ model, outputType: schema });
		session.send("What is the meaning of life?");
		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.finalOutput).toEqual({ answer: 42 });
	});

	test("session with handoffs switches agent mid-turn", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: {
							name: "transfer_to_specialist",
							arguments: "{}",
						},
					},
				],
			},
			{ content: "I'm the specialist. Here's your answer.", toolCalls: [] },
		]);

		const specialist = new Agent({
			name: "specialist",
			model,
			instructions: "You are a specialist.",
		});

		const session = createSession({ model, handoffs: [specialist] });
		session.send("I need a specialist.");
		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.output).toBe("I'm the specialist. Here's your answer.");
		expect(result.lastAgent.name).toBe("specialist");
	});

	test("session.messages returns accumulated history", async () => {
		const model = mockModel([{ content: "Hi there!", toolCalls: [] }]);

		const session = createSession({ model });
		expect(session.messages).toHaveLength(0);

		session.send("Hello");
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]!.role).toBe("user");

		for await (const _event of session.stream()) {
			// drain
		}

		// After stream: user + assistant
		expect(session.messages).toHaveLength(2);
		expect(session.messages[0]!.role).toBe("user");
		expect(session.messages[1]!.role).toBe("assistant");
	});

	test("messages are a copy (immutable from outside)", async () => {
		const model = mockModel([{ content: "Hi!", toolCalls: [] }]);
		const session = createSession({ model });
		session.send("Hello");

		const msgs = session.messages;
		expect(msgs).toHaveLength(1);

		// Mutating the returned array should not affect session state
		msgs.push({ role: "user", content: "injected" });
		expect(session.messages).toHaveLength(1);
	});

	test("Symbol.asyncDispose cleanup", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const session = createSession({ model });

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}
		expect(session.messages).toHaveLength(2);

		await session[Symbol.asyncDispose]();

		expect(() => session.send("After close")).toThrow("Session is closed");
		expect(session.messages).toHaveLength(0);
	});

	test("send after close throws", async () => {
		const model = mockModel([]);
		const session = createSession({ model });
		session.close();

		expect(() => session.send("Hi")).toThrow("Session is closed");
	});

	test("stream after close throws", async () => {
		const model = mockModel([]);
		const session = createSession({ model });
		session.close();

		expect(() => session.stream()).toThrow("Session is closed");
	});

	test("result before stream throws", async () => {
		const model = mockModel([]);
		const session = createSession({ model });
		session.send("Hi");

		expect(() => session.result).toThrow("No pending result");
	});

	test("session with instructions", async () => {
		const model = mockModel([{ content: "I am helpful!", toolCalls: [] }]);

		const session = createSession({
			model,
			instructions: "You are a helpful assistant.",
		});
		session.send("Hello");
		for await (const _event of session.stream()) {
			// drain
		}

		// Verify the system message was sent to the model
		const request = model.requests[0]!;
		const systemMsg = request.messages.find((m) => m.role === "system");
		expect(systemMsg).toBeDefined();
		if (systemMsg?.role === "system") {
			expect(systemMsg.content).toBe("You are a helpful assistant.");
		}
	});

	test("session has unique id", () => {
		const model = mockModel([]);
		const s1 = createSession({ model });
		const s2 = createSession({ model });

		expect(s1.id).toBeDefined();
		expect(s2.id).toBeDefined();
		expect(s1.id).not.toBe(s2.id);
	});
});
