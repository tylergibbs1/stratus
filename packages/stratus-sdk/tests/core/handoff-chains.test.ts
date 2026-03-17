import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import {
	InputGuardrailTripwireTriggered,
	OutputGuardrailTripwireTriggered,
} from "../../src/core/errors";
import type { InputGuardrail, OutputGuardrail } from "../../src/core/guardrails";
import { handoff } from "../../src/core/handoff";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import { withTrace } from "../../src/core/tracing";

function textResponse(content: string): ModelResponse {
	return { content, toolCalls: [] };
}

function handoffResponse(targetName: string): ModelResponse {
	return {
		content: null,
		toolCalls: [
			{
				id: `tc_${targetName}`,
				type: "function",
				function: { name: `transfer_to_${targetName}`, arguments: "{}" },
			},
		],
	};
}

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

function capturingModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
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
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield { type: "tool_call_delta", toolCallId: tc.id, arguments: tc.function.arguments };
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

describe("handoff chains (A→B→C)", () => {
	test("three-agent handoff chain works end-to-end", async () => {
		// Shared model: A hands off to B, B hands off to C, C responds
		const model = mockModel([
			handoffResponse("agent_b"),
			handoffResponse("agent_c"),
			textResponse("Hello from Agent C!"),
		]);

		const agentC = new Agent({ name: "agent_c", model, instructions: "You are C" });
		const agentB = new Agent({
			name: "agent_b",
			model,
			instructions: "You are B",
			handoffs: [agentC],
		});
		const agentA = new Agent({
			name: "agent_a",
			model,
			instructions: "You are A",
			handoffs: [agentB],
		});

		const result = await run(agentA, "Start chain");

		expect(result.lastAgent.name).toBe("agent_c");
		expect(result.output).toBe("Hello from Agent C!");
	});

	test("system prompt updates at each hop in chain", async () => {
		const model = capturingModel([
			handoffResponse("agent_b"),
			handoffResponse("agent_c"),
			textResponse("Done"),
		]);

		const agentC = new Agent({ name: "agent_c", model, instructions: "Prompt C" });
		const agentB = new Agent({
			name: "agent_b",
			model,
			instructions: "Prompt B",
			handoffs: [agentC],
		});
		const agentA = new Agent({
			name: "agent_a",
			model,
			instructions: "Prompt A",
			handoffs: [agentB],
		});

		await run(agentA, "Transfer");

		// Request 0: Agent A's prompt
		const sys0 = model.requests[0]?.messages.find((m) => m.role === "system");
		expect(sys0?.role === "system" && sys0.content).toBe("Prompt A");

		// Request 1: Agent B's prompt
		const sys1 = model.requests[1]?.messages.find((m) => m.role === "system");
		expect(sys1?.role === "system" && sys1.content).toBe("Prompt B");

		// Request 2: Agent C's prompt
		const sys2 = model.requests[2]?.messages.find((m) => m.role === "system");
		expect(sys2?.role === "system" && sys2.content).toBe("Prompt C");
	});

	test("handoff chain in stream mode produces correct done events", async () => {
		const model = mockModel([
			handoffResponse("agent_b"),
			handoffResponse("agent_c"),
			textResponse("Streamed from C"),
		]);

		const agentC = new Agent({ name: "agent_c", model });
		const agentB = new Agent({ name: "agent_b", model, handoffs: [agentC] });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const events: StreamEvent[] = [];
		const { stream: s, result } = stream(agentA, "Transfer");
		for await (const e of s) events.push(e);

		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(3);

		const r = await result;
		expect(r.lastAgent.name).toBe("agent_c");
		expect(r.output).toBe("Streamed from C");
	});

	test("onHandoff callbacks fire at each hop", async () => {
		const callOrder: string[] = [];

		const model = mockModel([
			handoffResponse("agent_b"),
			handoffResponse("agent_c"),
			textResponse("Done"),
		]);

		const agentC = new Agent({ name: "agent_c", model });
		const agentB = new Agent({
			name: "agent_b",
			model,
			handoffs: [
				handoff({
					agent: agentC,
					onHandoff: () => {
						callOrder.push("B→C");
					},
				}),
			],
		});
		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [
				handoff({
					agent: agentB,
					onHandoff: () => {
						callOrder.push("A→B");
					},
				}),
			],
		});

		await run(agentA, "Transfer");

		expect(callOrder).toEqual(["A→B", "B→C"]);
	});

	test("tracing records handoff spans for each hop", async () => {
		const model = mockModel([
			handoffResponse("agent_b"),
			handoffResponse("agent_c"),
			textResponse("Done"),
		]);

		const agentC = new Agent({ name: "agent_c", model });
		const agentB = new Agent({ name: "agent_b", model, handoffs: [agentC] });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const { trace } = await withTrace("chain-trace", () => run(agentA, "Transfer"));

		const handoffSpans = trace.spans.filter((s) => s.type === "handoff");
		expect(handoffSpans).toHaveLength(2);
		expect(handoffSpans[0]!.name).toBe("handoff:agent_a->agent_b");
		expect(handoffSpans[1]!.name).toBe("handoff:agent_b->agent_c");
	});

	test("usage accumulates across all hops in chain", async () => {
		const model = mockModel([
			{
				...handoffResponse("agent_b"),
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			},
			{
				...handoffResponse("agent_c"),
				usage: { promptTokens: 150, completionTokens: 15, totalTokens: 165 },
			},
			{
				...textResponse("Done"),
				usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
			},
		]);

		const agentC = new Agent({ name: "agent_c", model });
		const agentB = new Agent({ name: "agent_b", model, handoffs: [agentC] });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const result = await run(agentA, "Transfer");

		expect(result.usage.promptTokens).toBe(450);
		expect(result.usage.completionTokens).toBe(45);
		expect(result.usage.totalTokens).toBe(495);
		expect(result.numTurns).toBe(3);
	});
});

describe("guardrail + handoff interactions", () => {
	test("input guardrail on entry agent blocks before any handoff", async () => {
		const modelGetResponse = mock(() => Promise.resolve(textResponse("Should not reach")));
		const model: Model = {
			getResponse: modelGetResponse,
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: textResponse("nope") };
			},
		};

		const guardrail: InputGuardrail = {
			name: "block_all",
			execute: () => ({ tripwireTriggered: true, outputInfo: "blocked" }),
		};

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({
			name: "agent_a",
			model,
			inputGuardrails: [guardrail],
			handoffs: [agentB],
		});

		await expect(run(agentA, "Transfer")).rejects.toThrow(InputGuardrailTripwireTriggered);
		expect(modelGetResponse).not.toHaveBeenCalled();
	});

	test("output guardrail on target agent fires after handoff", async () => {
		const model = mockModel([handoffResponse("agent_b"), textResponse("sensitive output from B")]);

		const outputGuardrail: OutputGuardrail = {
			name: "b_output_check",
			execute: (output) => ({
				tripwireTriggered: output.includes("sensitive"),
				outputInfo: "blocked sensitive content",
			}),
		};

		const agentB = new Agent({
			name: "agent_b",
			model,
			outputGuardrails: [outputGuardrail],
		});

		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [agentB],
		});

		await expect(run(agentA, "Transfer")).rejects.toThrow(OutputGuardrailTripwireTriggered);
	});

	test("different guardrails on different agents in chain", async () => {
		const model = mockModel([handoffResponse("agent_b"), textResponse("clean output from B")]);

		// Agent A has a passing input guardrail
		const inputGuardrailA: InputGuardrail = {
			name: "a_input",
			execute: () => ({ tripwireTriggered: false }),
		};

		// Agent B has a passing output guardrail
		const outputGuardrailB: OutputGuardrail = {
			name: "b_output",
			execute: () => ({ tripwireTriggered: false }),
		};

		const agentB = new Agent({
			name: "agent_b",
			model,
			outputGuardrails: [outputGuardrailB],
		});

		const agentA = new Agent({
			name: "agent_a",
			model,
			inputGuardrails: [inputGuardrailA],
			handoffs: [agentB],
		});

		const result = await run(agentA, "Transfer");
		expect(result.lastAgent.name).toBe("agent_b");
		expect(result.output).toBe("clean output from B");
	});

	test("beforeHandoff hook deny prevents agent switch", async () => {
		const model = mockModel([handoffResponse("agent_b"), textResponse("Stayed with A")]);

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [agentB],
			hooks: {
				beforeHandoff: () => ({
					decision: "deny" as const,
					reason: "Handoff not allowed",
				}),
			},
		});

		const result = await run(agentA, "Transfer");
		// Should stay on agent_a since handoff was denied
		expect(result.lastAgent.name).toBe("agent_a");
		expect(result.output).toBe("Stayed with A");
	});

	test("handoff with agent that has tools carries tools forward", async () => {
		let toolExecuted = false;

		const model = mockModel([
			handoffResponse("agent_b"),
			{
				content: null,
				toolCalls: [{ id: "tc2", type: "function", function: { name: "b_tool", arguments: "{}" } }],
			},
			textResponse("B used its tool"),
		]);

		const bTool = tool({
			name: "b_tool",
			description: "B's tool",
			parameters: z.object({}),
			execute: async () => {
				toolExecuted = true;
				return "b_tool_result";
			},
		});

		const agentB = new Agent({ name: "agent_b", model, tools: [bTool] });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const result = await run(agentA, "Transfer");

		expect(result.lastAgent.name).toBe("agent_b");
		expect(toolExecuted).toBe(true);
		expect(result.output).toBe("B used its tool");
	});
});
