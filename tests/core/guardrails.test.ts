import { describe, expect, mock, test } from "bun:test";
import { Agent } from "../../src/core/agent";
import {
	InputGuardrailTripwireTriggered,
	OutputGuardrailTripwireTriggered,
} from "../../src/core/errors";
import type { InputGuardrail, OutputGuardrail } from "../../src/core/guardrails";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";

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
			yield { type: "done", response };
		},
	};
}

describe("guardrails", () => {
	test("input guardrail blocks before model call", async () => {
		const modelGetResponse = mock(() =>
			Promise.resolve({ content: "Should not reach", toolCalls: [] } as ModelResponse),
		);
		const model: Model = {
			getResponse: modelGetResponse,
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "", toolCalls: [] } };
			},
		};

		const guardrail: InputGuardrail = {
			name: "block_bad_input",
			execute: (input) => ({
				tripwireTriggered: input.includes("bad"),
				outputInfo: "Blocked bad input",
			}),
		};

		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [guardrail],
		});

		try {
			await run(agent, "This is bad input");
			expect(true).toBe(false); // Should not reach
		} catch (error) {
			expect(error).toBeInstanceOf(InputGuardrailTripwireTriggered);
			expect((error as InputGuardrailTripwireTriggered).guardrailName).toBe("block_bad_input");
			expect((error as InputGuardrailTripwireTriggered).outputInfo).toBe("Blocked bad input");
		}

		// Model should NOT have been called
		expect(modelGetResponse).not.toHaveBeenCalled();
	});

	test("input guardrail passes when not triggered", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);

		const guardrail: InputGuardrail = {
			name: "safe_check",
			execute: () => ({ tripwireTriggered: false }),
		};

		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [guardrail],
		});

		const result = await run(agent, "This is fine");
		expect(result.output).toBe("Hello!");
	});

	test("output guardrail blocks on specific output", async () => {
		const model = mockModel([{ content: "sensitive data here", toolCalls: [] }]);

		const guardrail: OutputGuardrail = {
			name: "block_sensitive",
			execute: (output) => ({
				tripwireTriggered: output.includes("sensitive"),
				outputInfo: "Contains sensitive data",
			}),
		};

		const agent = new Agent({
			name: "test",
			model,
			outputGuardrails: [guardrail],
		});

		try {
			await run(agent, "Tell me something");
			expect(true).toBe(false);
		} catch (error) {
			expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
			expect((error as OutputGuardrailTripwireTriggered).guardrailName).toBe("block_sensitive");
		}
	});

	test("multiple guardrails run in parallel", async () => {
		const model = mockModel([{ content: "ok", toolCalls: [] }]);
		const executionOrder: string[] = [];

		const guardrail1: InputGuardrail = {
			name: "g1",
			execute: async () => {
				executionOrder.push("g1_start");
				await new Promise((r) => setTimeout(r, 10));
				executionOrder.push("g1_end");
				return { tripwireTriggered: false };
			},
		};

		const guardrail2: InputGuardrail = {
			name: "g2",
			execute: async () => {
				executionOrder.push("g2_start");
				await new Promise((r) => setTimeout(r, 10));
				executionOrder.push("g2_end");
				return { tripwireTriggered: false };
			},
		};

		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [guardrail1, guardrail2],
		});

		await run(agent, "Hello");

		// Both should start before either ends (parallel execution)
		expect(executionOrder[0]).toBe("g1_start");
		expect(executionOrder[1]).toBe("g2_start");
	});

	test("output guardrails run on current agent after handoff", async () => {
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
			{ content: "response from B", toolCalls: [] },
		]);

		const outputGuardrailB: OutputGuardrail = {
			name: "b_guardrail",
			execute: (output) => ({
				tripwireTriggered: output.includes("response from B"),
			}),
		};

		const agentB = new Agent({
			name: "agent_b",
			model,
			outputGuardrails: [outputGuardrailB],
		});

		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [agentB],
		});

		expect(run(agentA, "Transfer")).rejects.toThrow(OutputGuardrailTripwireTriggered);
	});
});
