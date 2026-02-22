import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import { subagent } from "../../src/core/subagent";
import { getCurrentTrace, withTrace } from "../../src/core/tracing";

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

describe("tracing extended", () => {
	test("trace with multiple model calls records all spans", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } },
				],
			},
			{ content: "3", toolCalls: [] },
		]);

		const addTool = tool({
			name: "add",
			description: "Add",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const agent = new Agent({ name: "calc", model, tools: [addTool] });

		const { trace } = await withTrace("multi-call-trace", () => run(agent, "Add"));

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		expect(modelSpans).toHaveLength(2);
		expect(modelSpans[0]!.name).toBe("model_call:calc");
		expect(modelSpans[1]!.name).toBe("model_call:calc");
	});

	test("trace records model error on span", async () => {
		const failingModel: Model = {
			async getResponse(): Promise<ModelResponse> {
				throw new Error("API timeout");
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				throw new Error("API timeout");
			},
		};

		const agent = new Agent({ name: "fail_agent", model: failingModel });

		let caughtError = false;
		const { trace } = await withTrace("error-trace", async () => {
			try {
				return await run(agent, "Hi");
			} catch {
				caughtError = true;
				// Return a dummy to satisfy type — trace is still recorded
				return null as any;
			}
		});

		expect(caughtError).toBe(true);

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		expect(modelSpans).toHaveLength(1);
		expect(modelSpans[0]!.metadata?.error).toBe("API timeout");
	});

	test("concurrent traces are isolated", async () => {
		const modelA = mockModel([{ content: "A", toolCalls: [] }]);
		const modelB = mockModel([{ content: "B", toolCalls: [] }]);

		const agentA = new Agent({ name: "agent_a", model: modelA });
		const agentB = new Agent({ name: "agent_b", model: modelB });

		const [resultA, resultB] = await Promise.all([
			withTrace("trace_a", () => run(agentA, "Hi")),
			withTrace("trace_b", () => run(agentB, "Hi")),
		]);

		expect(resultA.trace.name).toBe("trace_a");
		expect(resultB.trace.name).toBe("trace_b");

		// Each trace should only have spans from its own agent
		const aSpans = resultA.trace.spans.filter((s) => s.type === "model_call");
		const bSpans = resultB.trace.spans.filter((s) => s.type === "model_call");

		expect(aSpans).toHaveLength(1);
		expect(aSpans[0]!.name).toBe("model_call:agent_a");

		expect(bSpans).toHaveLength(1);
		expect(bSpans[0]!.name).toBe("model_call:agent_b");
	});

	test("trace with handoff chain records all handoff spans", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "transfer_to_b", arguments: "{}" } }],
			},
			{
				content: null,
				toolCalls: [{ id: "tc2", type: "function", function: { name: "transfer_to_c", arguments: "{}" } }],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const agentC = new Agent({ name: "c", model });
		const agentB = new Agent({ name: "b", model, handoffs: [agentC] });
		const agentA = new Agent({ name: "a", model, handoffs: [agentB] });

		const { trace } = await withTrace("chain", () => run(agentA, "Go"));

		const handoffSpans = trace.spans.filter((s) => s.type === "handoff");
		expect(handoffSpans).toHaveLength(2);

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		expect(modelSpans).toHaveLength(3);
	});

	test("trace with subagent records subagent span", async () => {
		const childModel = mockModel([{ content: "child result", toolCalls: [] }]);
		const childAgent = new Agent({ name: "child", model: childModel });

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (p) => p.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "run_child", arguments: '{"q":"hi"}' } }],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const parent = new Agent({ name: "parent", model: parentModel, subagents: [sa] });

		const { trace } = await withTrace("sub-trace", () => run(parent, "test"));

		const subSpans = trace.spans.filter((s) => s.type === "subagent");
		expect(subSpans).toHaveLength(1);
		expect(subSpans[0]!.name).toContain("child");
	});

	test("getCurrentTrace returns undefined outside withTrace", () => {
		expect(getCurrentTrace()).toBeUndefined();
	});

	test("trace duration is positive", async () => {
		const model = mockModel([{ content: "Hello", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });

		const { trace } = await withTrace("duration-test", () => run(agent, "Hi"));

		expect(trace.duration).toBeGreaterThan(0);
		for (const span of trace.spans) {
			expect(span.duration).toBeGreaterThanOrEqual(0);
		}
	});

	test("span metadata includes agent name and turn", async () => {
		const model = mockModel([{ content: "Hello", toolCalls: [] }]);
		const agent = new Agent({ name: "my_agent", model });

		const { trace } = await withTrace("meta-test", () => run(agent, "Hi"));

		const modelSpan = trace.spans.find((s) => s.type === "model_call");
		expect(modelSpan).toBeDefined();
		expect(modelSpan!.metadata?.agent).toBe("my_agent");
		expect(modelSpan!.metadata?.turn).toBe(0);
	});
});
