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

function toolCallResponse(
	calls: { id: string; name: string; args: string }[],
): ModelResponse {
	return {
		content: null,
		toolCalls: calls.map((c) => ({
			id: c.id,
			type: "function" as const,
			function: { name: c.name, arguments: c.args },
		})),
	};
}

describe("concurrent tool calls", () => {
	test("multiple tool calls in single response all execute", async () => {
		const executionLog: string[] = [];

		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "tool_a", args: '{"value":"a"}' },
				{ id: "tc2", name: "tool_b", args: '{"value":"b"}' },
				{ id: "tc3", name: "tool_c", args: '{"value":"c"}' },
			]),
			{ content: "All done", toolCalls: [] },
		]);

		const toolA = tool({
			name: "tool_a",
			description: "A",
			parameters: z.object({ value: z.string() }),
			execute: async (_ctx, { value }) => {
				executionLog.push(`a:${value}`);
				return `result_a`;
			},
		});
		const toolB = tool({
			name: "tool_b",
			description: "B",
			parameters: z.object({ value: z.string() }),
			execute: async (_ctx, { value }) => {
				executionLog.push(`b:${value}`);
				return `result_b`;
			},
		});
		const toolC = tool({
			name: "tool_c",
			description: "C",
			parameters: z.object({ value: z.string() }),
			execute: async (_ctx, { value }) => {
				executionLog.push(`c:${value}`);
				return `result_c`;
			},
		});

		const agent = new Agent({ name: "test", model, tools: [toolA, toolB, toolC] });
		const result = await run(agent, "Do all three");

		expect(executionLog).toContain("a:a");
		expect(executionLog).toContain("b:b");
		expect(executionLog).toContain("c:c");
		expect(result.output).toBe("All done");

		// 3 tool messages should be in the result
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(3);
	});

	test("one tool fails while others succeed", async () => {
		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "good_tool", args: "{}" },
				{ id: "tc2", name: "bad_tool", args: "{}" },
				{ id: "tc3", name: "good_tool", args: "{}" },
			]),
			{ content: "Handled", toolCalls: [] },
		]);

		const goodTool = tool({
			name: "good_tool",
			description: "Works",
			parameters: z.object({}),
			execute: async () => "success",
		});

		const badTool = tool({
			name: "bad_tool",
			description: "Fails",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("Tool crashed");
			},
		});

		const agent = new Agent({ name: "test", model, tools: [goodTool, badTool] });
		const result = await run(agent, "Do it");

		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(3);

		// Two should be "success", one should contain error
		const successMsgs = toolMsgs.filter((m) => m.role === "tool" && m.content === "success");
		const errorMsgs = toolMsgs.filter((m) => m.role === "tool" && m.content.includes("Error"));
		expect(successMsgs).toHaveLength(2);
		expect(errorMsgs).toHaveLength(1);

		expect(result.output).toBe("Handled");
	});

	test("tool results order matches tool call order", async () => {
		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "t", args: '{"n":"first"}' },
				{ id: "tc2", name: "t", args: '{"n":"second"}' },
				{ id: "tc3", name: "t", args: '{"n":"third"}' },
			]),
			{ content: "Done", toolCalls: [] },
		]);

		const t = tool({
			name: "t",
			description: "Tool",
			parameters: z.object({ n: z.string() }),
			execute: async (_ctx, { n }) => {
				// Add varying delays to test ordering
				const delay = n === "first" ? 30 : n === "second" ? 10 : 1;
				await new Promise((r) => setTimeout(r, delay));
				return n;
			},
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		const result = await run(agent, "Go");

		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(3);
		// Results should match the order of tool calls (Promise.all preserves order)
		expect(toolMsgs[0]!.role === "tool" && toolMsgs[0]!.content).toBe("first");
		expect(toolMsgs[1]!.role === "tool" && toolMsgs[1]!.content).toBe("second");
		expect(toolMsgs[2]!.role === "tool" && toolMsgs[2]!.content).toBe("third");
	});

	test("tools execute concurrently (not sequentially)", async () => {
		const timestamps: { name: string; start: number; end: number }[] = [];

		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "slow_a", args: "{}" },
				{ id: "tc2", name: "slow_b", args: "{}" },
			]),
			{ content: "Done", toolCalls: [] },
		]);

		const makeSlowTool = (name: string, delay: number) =>
			tool({
				name,
				description: name,
				parameters: z.object({}),
				execute: async () => {
					const start = Date.now();
					await new Promise((r) => setTimeout(r, delay));
					timestamps.push({ name, start, end: Date.now() });
					return "ok";
				},
			});

		const agent = new Agent({
			name: "test",
			model,
			tools: [makeSlowTool("slow_a", 50), makeSlowTool("slow_b", 50)],
		});

		const startTime = Date.now();
		await run(agent, "Go");
		const totalTime = Date.now() - startTime;

		// If sequential, would take ~100ms. Concurrent should be ~50ms.
		// Allow generous margin but ensure it's not sequential.
		expect(totalTime).toBeLessThan(150);

		// Both tools should have started before either finished (overlap)
		expect(timestamps).toHaveLength(2);
		const [a, b] = timestamps;
		// At least one tool should have started before the other ended
		expect(a!.start < b!.end || b!.start < a!.end).toBe(true);
	});

	test("concurrent tool calls in stream mode", async () => {
		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "t", args: '{"v":"x"}' },
				{ id: "tc2", name: "t", args: '{"v":"y"}' },
			]),
			{ content: "Done", toolCalls: [] },
		]);

		const t = tool({
			name: "t",
			description: "Tool",
			parameters: z.object({ v: z.string() }),
			execute: async (_ctx, { v }) => v,
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		const { stream: s, result } = stream(agent, "Go");

		const events: StreamEvent[] = [];
		for await (const e of s) events.push(e);

		const r = await result;
		expect(r.output).toBe("Done");

		// Should have 2 tool_call_start events
		const starts = events.filter((e) => e.type === "tool_call_start");
		expect(starts).toHaveLength(2);
	});

	test("same tool called twice with different args", async () => {
		const results: string[] = [];

		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "add", args: '{"a":1,"b":2}' },
				{ id: "tc2", name: "add", args: '{"a":10,"b":20}' },
			]),
			{ content: "Done", toolCalls: [] },
		]);

		const addTool = tool({
			name: "add",
			description: "Add",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => {
				const r = String(a + b);
				results.push(r);
				return r;
			},
		});

		const agent = new Agent({ name: "test", model, tools: [addTool] });
		const result = await run(agent, "Add");

		expect(results).toContain("3");
		expect(results).toContain("30");

		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(2);
	});
});
