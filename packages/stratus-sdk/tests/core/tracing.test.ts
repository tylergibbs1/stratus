import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import {
	AzureMonitorTraceExporter,
	addTraceProcessor,
	clearTraceProcessors,
	getCurrentTrace,
	withTrace,
} from "../../src/core/tracing";

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

describe("tracing", () => {
	afterEach(() => {
		clearTraceProcessors();
	});

	test("withTrace records model call spans", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });

		const { result, trace } = await withTrace("test-trace", () => run(agent, "Hi"));

		expect(result.output).toBe("Hello!");
		expect(trace.name).toBe("test-trace");
		expect(trace.id).toBeDefined();
		expect(trace.duration).toBeGreaterThan(0);

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		expect(modelSpans).toHaveLength(1);
		expect(modelSpans[0]!.name).toBe("model_call:test");
		expect(modelSpans[0]!.duration).toBeGreaterThan(0);
	});

	test("withTrace records tool execution spans", async () => {
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
			description: "Add numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const agent = new Agent({ name: "test", model, tools: [addTool] });

		const { trace } = await withTrace("tool-trace", () => run(agent, "Add 1+2"));

		const toolSpans = trace.spans.filter((s) => s.type === "tool_execution");
		expect(toolSpans).toHaveLength(1);
		expect(toolSpans[0]!.name).toBe("tool:add");
		expect(toolSpans[0]!.duration).toBeGreaterThanOrEqual(0);
	});

	test("withTrace records handoff spans", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "transfer_to_agent_b", arguments: "{}" },
					},
				],
			},
			{ content: "From B", toolCalls: [] },
		]);

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const { trace } = await withTrace("handoff-trace", () => run(agentA, "Transfer"));

		const handoffSpans = trace.spans.filter((s) => s.type === "handoff");
		expect(handoffSpans).toHaveLength(1);
		expect(handoffSpans[0]!.name).toBe("handoff:agent_a->agent_b");
	});

	test("no tracing overhead when not wrapped", async () => {
		// getCurrentTrace should return undefined outside withTrace
		expect(getCurrentTrace()).toBeUndefined();

		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });

		// This should work fine without tracing
		const result = await run(agent, "Hi");
		expect(result.output).toBe("Hello!");
	});

	test("withTrace records guardrail spans", async () => {
		const model = mockModel([{ content: "ok", toolCalls: [] }]);

		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [
				{
					name: "safe_check",
					execute: () => ({ tripwireTriggered: false }),
				},
			],
		});

		const { trace } = await withTrace("guardrail-trace", () => run(agent, "Hello"));

		const guardrailSpans = trace.spans.filter((s) => s.type === "guardrail");
		expect(guardrailSpans).toHaveLength(1);
		expect(guardrailSpans[0]!.name).toBe("input_guardrails");
	});

	test("exports traces through registered processors", async () => {
		const exported: string[] = [];
		addTraceProcessor({
			exportTrace(trace) {
				exported.push(trace.name);
			},
		});

		await withTrace("processor-trace", () => "ok");

		expect(exported).toEqual(["processor-trace"]);
	});

	test("AzureMonitorTraceExporter posts trace envelopes", async () => {
		let capturedUrl = "";
		let capturedBody: unknown;
		const exporter = new AzureMonitorTraceExporter({
			connectionString:
				"InstrumentationKey=ikey;IngestionEndpoint=https://example.monitor.azure.com",
			serviceName: "stratus-test",
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				capturedUrl = String(url);
				capturedBody = JSON.parse(String(init?.body));
				return new Response("{}", { status: 200 });
			}) as typeof fetch,
		});

		await exporter.exportTrace({
			id: "trace_1",
			name: "azure-trace",
			startTime: performance.now(),
			endTime: performance.now(),
			duration: 10,
			spans: [
				{
					name: "model_call:test",
					type: "model_call",
					startTime: performance.now(),
					endTime: performance.now(),
					duration: 5,
					metadata: { agent: "test" },
					children: [],
				},
			],
		});

		expect(capturedUrl).toBe("https://example.monitor.azure.com/v2/track");
		expect(Array.isArray(capturedBody)).toBe(true);
		const items = capturedBody as any[];
		expect(items.length).toBe(2);
		expect(items[0].data.baseData.name).toBe("stratus.trace");
		expect(items[1].data.baseData.name).toBe("stratus.span");
		expect(items[1].tags["ai.cloud.role"]).toBe("stratus-test");
	});
});
