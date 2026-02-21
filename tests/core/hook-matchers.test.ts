import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { MatchedAfterToolCallHook, MatchedToolCallHook } from "../../src/core/hooks";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
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

describe("hook matchers: beforeToolCall", () => {
	test("backward compatible function form still works", async () => {
		const called: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "get_weather", arguments: '{}' } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "get_weather",
				description: "Get weather",
				parameters: z.object({}),
				execute: async () => "sunny",
			})],
			hooks: {
				beforeToolCall: async ({ toolCall }) => {
					called.push(toolCall.function.name);
				},
			},
		});

		await run(agent, "Weather?");
		expect(called).toEqual(["get_weather"]);
	});

	test("string matcher filters by tool name", async () => {
		const denied: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "safe_tool", arguments: '{}' } },
					{ id: "tc2", type: "function", function: { name: "dangerous_tool", arguments: '{}' } },
				],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const matchers: MatchedToolCallHook[] = [
			{
				match: "dangerous_tool",
				hook: ({ toolCall }) => {
					denied.push(toolCall.function.name);
					return { decision: "deny", reason: "Not allowed" };
				},
			},
		];

		const agent = new Agent({
			name: "test",
			model,
			tools: [
				tool({
					name: "safe_tool",
					description: "Safe",
					parameters: z.object({}),
					execute: async () => "safe_result",
				}),
				tool({
					name: "dangerous_tool",
					description: "Dangerous",
					parameters: z.object({}),
					execute: async () => "dangerous_result",
				}),
			],
			hooks: {
				beforeToolCall: matchers,
			},
		});

		const result = await run(agent, "Use both");
		expect(denied).toEqual(["dangerous_tool"]);
		// The safe tool should have executed, dangerous should have been denied
		expect(result.messages.some(
			(m) => m.role === "tool" && m.content === "safe_result",
		)).toBe(true);
		expect(result.messages.some(
			(m) => m.role === "tool" && m.content === "Not allowed",
		)).toBe(true);
	});

	test("regex matcher filters by pattern", async () => {
		const matched: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{}' } },
					{ id: "tc2", type: "function", function: { name: "write_file", arguments: '{}' } },
					{ id: "tc3", type: "function", function: { name: "get_weather", arguments: '{}' } },
				],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const matchers: MatchedToolCallHook[] = [
			{
				match: /.*_file$/,
				hook: ({ toolCall }) => {
					matched.push(toolCall.function.name);
				},
			},
		];

		const agent = new Agent({
			name: "test",
			model,
			tools: [
				tool({ name: "read_file", description: "R", parameters: z.object({}), execute: async () => "r" }),
				tool({ name: "write_file", description: "W", parameters: z.object({}), execute: async () => "w" }),
				tool({ name: "get_weather", description: "G", parameters: z.object({}), execute: async () => "g" }),
			],
			hooks: {
				beforeToolCall: matchers,
			},
		});

		await run(agent, "Do things");
		expect(matched).toEqual(["read_file", "write_file"]);
	});

	test("array of matchers matches any", async () => {
		const matched: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "tool_a", arguments: '{}' } },
					{ id: "tc2", type: "function", function: { name: "tool_b", arguments: '{}' } },
					{ id: "tc3", type: "function", function: { name: "tool_c", arguments: '{}' } },
				],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const matchers: MatchedToolCallHook[] = [
			{
				match: ["tool_a", "tool_c"],
				hook: ({ toolCall }) => {
					matched.push(toolCall.function.name);
				},
			},
		];

		const agent = new Agent({
			name: "test",
			model,
			tools: [
				tool({ name: "tool_a", description: "A", parameters: z.object({}), execute: async () => "a" }),
				tool({ name: "tool_b", description: "B", parameters: z.object({}), execute: async () => "b" }),
				tool({ name: "tool_c", description: "C", parameters: z.object({}), execute: async () => "c" }),
			],
			hooks: {
				beforeToolCall: matchers,
			},
		});

		await run(agent, "All tools");
		expect(matched).toEqual(["tool_a", "tool_c"]);
	});

	test("first deny short-circuits", async () => {
		const called: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "my_tool", arguments: '{}' } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const matchers: MatchedToolCallHook[] = [
			{
				match: "my_tool",
				hook: () => {
					called.push("first");
					return { decision: "deny" as const, reason: "Blocked by first" };
				},
			},
			{
				match: "my_tool",
				hook: () => {
					called.push("second");
				},
			},
		];

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "my_tool",
				description: "My tool",
				parameters: z.object({}),
				execute: async () => "result",
			})],
			hooks: {
				beforeToolCall: matchers,
			},
		});

		await run(agent, "Use it");
		expect(called).toEqual(["first"]); // second never called
	});
});

describe("hook matchers: afterToolCall", () => {
	test("backward compatible function form", async () => {
		const results: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "my_tool", arguments: '{}' } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "my_tool",
				description: "My tool",
				parameters: z.object({}),
				execute: async () => "tool_output",
			})],
			hooks: {
				afterToolCall: async ({ result }) => {
					results.push(result);
				},
			},
		});

		await run(agent, "Use it");
		expect(results).toEqual(["tool_output"]);
	});

	test("matched afterToolCall array form", async () => {
		const results: string[] = [];
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "tool_a", arguments: '{}' } },
					{ id: "tc2", type: "function", function: { name: "tool_b", arguments: '{}' } },
				],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const matchers: MatchedAfterToolCallHook[] = [
			{
				match: "tool_a",
				hook: ({ result }) => {
					results.push(`a:${result}`);
				},
			},
		];

		const agent = new Agent({
			name: "test",
			model,
			tools: [
				tool({ name: "tool_a", description: "A", parameters: z.object({}), execute: async () => "result_a" }),
				tool({ name: "tool_b", description: "B", parameters: z.object({}), execute: async () => "result_b" }),
			],
			hooks: {
				afterToolCall: matchers,
			},
		});

		await run(agent, "Use both");
		expect(results).toEqual(["a:result_a"]);
	});
});
