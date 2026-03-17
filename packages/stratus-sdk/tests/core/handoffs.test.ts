import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { handoff } from "../../src/core/handoff";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
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

describe("handoffs", () => {
	test("switches agent on handoff tool call", async () => {
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
			{ content: "Hello from Agent B!", toolCalls: [] },
		]);

		const agentB = new Agent({ name: "agent_b", model, instructions: "You are Agent B" });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const result = await run(agentA, "Transfer me");

		expect(result.output).toBe("Hello from Agent B!");
		expect(result.lastAgent.name).toBe("agent_b");
	});

	test("onHandoff callback fires", async () => {
		const onHandoffFn = mock(() => {});

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
			{ content: "Done", toolCalls: [] },
		]);

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [handoff({ agent: agentB, onHandoff: onHandoffFn })],
		});

		await run(agentA, "Transfer");

		expect(onHandoffFn).toHaveBeenCalledTimes(1);
	});

	test("raw Agent in handoffs is auto-normalized", async () => {
		const agentB = new Agent({ name: "agent_b" });
		const agentA = new Agent({ name: "agent_a", handoffs: [agentB] });

		expect(agentA.handoffs).toHaveLength(1);
		expect(agentA.handoffs[0]!.type).toBe("handoff");
		expect(agentA.handoffs[0]!.toolName).toBe("transfer_to_agent_b");
		expect(agentA.handoffs[0]!.agent.name).toBe("agent_b");
	});

	test("handoff tool definitions sent to model", async () => {
		let capturedRequest: ModelRequest | undefined;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequest = request;
				return { content: "Done", toolCalls: [] };
			},
			async *getStreamedResponse(_request: ModelRequest): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const myTool = tool({
			name: "greet",
			description: "Greet someone",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, { name }) => `Hi ${name}!`,
		});

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({ name: "agent_a", model, tools: [myTool], handoffs: [agentB] });

		await run(agentA, "Hi");

		expect(capturedRequest?.tools).toHaveLength(2);
		expect(capturedRequest?.tools?.[0]?.function.name).toBe("greet");
		expect(capturedRequest?.tools?.[1]?.function.name).toBe("transfer_to_agent_b");
	});

	test("custom handoff name and description", async () => {
		const agentB = new Agent({ name: "agent_b" });
		const h = handoff({
			agent: agentB,
			toolName: "escalate_to_support",
			toolDescription: "Escalate to support team",
		});

		expect(h.toolName).toBe("escalate_to_support");
		expect(h.toolDescription).toBe("Escalate to support team");
	});

	test("handoff replaces system prompt", async () => {
		const requests: ModelRequest[] = [];
		let callIndex = 0;
		const responses: ModelResponse[] = [
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
			{ content: "I am B", toolCalls: [] },
		];

		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				requests.push(structuredClone(request));
				const response = responses[callIndex++];
				if (!response) throw new Error("No more mock responses");
				return response;
			},
			async *getStreamedResponse(_request: ModelRequest): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "ok", toolCalls: [] } };
			},
		};

		const agentB = new Agent({ name: "agent_b", model, instructions: "You are Agent B" });
		const agentA = new Agent({
			name: "agent_a",
			model,
			instructions: "You are Agent A",
			handoffs: [agentB],
		});

		await run(agentA, "Transfer");

		// First request should have Agent A's system prompt
		const firstSystem = requests[0]?.messages.find((m) => m.role === "system");
		expect(firstSystem?.role === "system" && firstSystem.content).toBe("You are Agent A");

		// Second request should have Agent B's system prompt
		const secondSystem = requests[1]?.messages.find((m) => m.role === "system");
		expect(secondSystem?.role === "system" && secondSystem.content).toBe("You are Agent B");
	});

	test("handoff works in stream mode", async () => {
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
			{ content: "Streamed from B", toolCalls: [] },
		]);

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const events: StreamEvent[] = [];
		for await (const event of stream(agentA, "Transfer").stream) {
			events.push(event);
		}

		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(2);
	});
});
