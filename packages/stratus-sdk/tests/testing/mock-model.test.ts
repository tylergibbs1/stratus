import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { stream, run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import { createMockModel, textResponse, toolCallResponse } from "../../src/testing/index";

describe("textResponse", () => {
	test("builds a text-only ModelResponse", () => {
		const r = textResponse("Hello!");
		expect(r.content).toBe("Hello!");
		expect(r.toolCalls).toEqual([]);
		expect(r.finishReason).toBe("stop");
	});

	test("accepts optional usage and responseId", () => {
		const r = textResponse("ok", {
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			responseId: "resp_123",
		});
		expect(r.usage!.promptTokens).toBe(10);
		expect(r.responseId).toBe("resp_123");
	});
});

describe("toolCallResponse", () => {
	test("builds a tool call ModelResponse", () => {
		const r = toolCallResponse([{ name: "search", args: { q: "test" } }]);
		expect(r.content).toBeNull();
		expect(r.toolCalls).toHaveLength(1);
		expect(r.toolCalls[0]!.function.name).toBe("search");
		expect(r.toolCalls[0]!.function.arguments).toBe('{"q":"test"}');
		expect(r.finishReason).toBe("tool_calls");
	});

	test("auto-generates tool call IDs", () => {
		const r = toolCallResponse([
			{ name: "a", args: {} },
			{ name: "b", args: {} },
		]);
		expect(r.toolCalls[0]!.id).toBe("tc_0");
		expect(r.toolCalls[1]!.id).toBe("tc_1");
	});

	test("uses custom IDs when provided", () => {
		const r = toolCallResponse([{ name: "a", args: {}, id: "custom_1" }]);
		expect(r.toolCalls[0]!.id).toBe("custom_1");
	});
});

describe("createMockModel", () => {
	test("returns responses in sequence", async () => {
		const model = createMockModel([textResponse("first"), textResponse("second")]);

		const r1 = await model.getResponse({ messages: [{ role: "user", content: "1" }] });
		expect(r1.content).toBe("first");

		const r2 = await model.getResponse({ messages: [{ role: "user", content: "2" }] });
		expect(r2.content).toBe("second");
	});

	test("throws when responses exhausted", async () => {
		const model = createMockModel([textResponse("only one")]);

		await model.getResponse({ messages: [{ role: "user", content: "1" }] });
		await expect(model.getResponse({ messages: [{ role: "user", content: "2" }] })).rejects.toThrow(
			"No more mock responses",
		);
	});

	test("capture: true records requests", async () => {
		const model = createMockModel([textResponse("ok")], { capture: true });

		await model.getResponse({
			messages: [{ role: "user", content: "hello" }],
		});

		expect(model.requests).toHaveLength(1);
		expect(model.requests[0]!.messages[0]!.content).toBe("hello");
	});

	test("streaming yields content_delta and done", async () => {
		const model = createMockModel([textResponse("Hello world")]);

		const events = [];
		for await (const event of model.getStreamedResponse({
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(event);
		}

		expect(events[0]!.type).toBe("content_delta");
		expect(events[events.length - 1]!.type).toBe("done");
	});

	test("streaming yields tool call events", async () => {
		const model = createMockModel([toolCallResponse([{ name: "search", args: { q: "test" } }])]);

		const events = [];
		for await (const event of model.getStreamedResponse({
			messages: [{ role: "user", content: "hi" }],
		})) {
			events.push(event);
		}

		const types = events.map((e) => e.type);
		expect(types).toContain("tool_call_start");
		expect(types).toContain("tool_call_delta");
		expect(types).toContain("tool_call_done");
		expect(types).toContain("done");
	});
});

describe("end-to-end with run()", () => {
	test("mock model works with Agent + run()", async () => {
		const model = createMockModel([textResponse("I'm a mock!")]);
		const agent = new Agent({
			name: "test-agent",
			model,
			instructions: "Be helpful.",
		});

		const result = await run(agent, "Hello");
		expect(result.output).toBe("I'm a mock!");
	});

	test("mock model works with tools", async () => {
		const add = tool({
			name: "add",
			description: "Add two numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const model = createMockModel([
			toolCallResponse([{ name: "add", args: { a: 2, b: 3 } }]),
			textResponse("The answer is 5"),
		]);

		const agent = new Agent({
			name: "calculator",
			model,
			tools: [add],
		});

		const result = await run(agent, "What is 2 + 3?");
		expect(result.output).toBe("The answer is 5");
	});

	test("mock model works with stream()", async () => {
		const model = createMockModel([textResponse("Streamed!")]);
		const agent = new Agent({ name: "streamer", model });

		const { stream: s, result: resultPromise } = stream(agent, "Hi");
		const deltas: string[] = [];
		for await (const event of s) {
			if (event.type === "content_delta") deltas.push(event.content);
		}
		const result = await resultPromise;

		expect(deltas).toEqual(["Streamed!"]);
		expect(result.output).toBe("Streamed!");
	});
});
