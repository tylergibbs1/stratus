import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { AgentHooks } from "../../src/core/hooks";
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

describe("hooks", () => {
	test("beforeRun fires before model call", async () => {
		const callOrder: string[] = [];

		let callIndex = 0;
		const responses: ModelResponse[] = [{ content: "Hello!", toolCalls: [] }];
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				callOrder.push("model_call");
				const response = responses[callIndex++];
				if (!response) throw new Error("No more mock responses");
				return response;
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "", toolCalls: [] } };
			},
		};

		const hooks: AgentHooks = {
			beforeRun: () => {
				callOrder.push("before_run");
			},
		};

		const agent = new Agent({ name: "test", model, hooks });
		await run(agent, "Hi");

		expect(callOrder).toEqual(["before_run", "model_call"]);
	});

	test("afterRun fires after result is ready", async () => {
		const afterRunFn = mock(({ result }: any) => {
			expect(result.output).toBe("Done!");
		});

		const model = mockModel([{ content: "Done!", toolCalls: [] }]);
		const agent = new Agent({
			name: "test",
			model,
			hooks: { afterRun: afterRunFn },
		});

		await run(agent, "Hi");

		expect(afterRunFn).toHaveBeenCalledTimes(1);
	});

	test("beforeToolCall and afterToolCall fire around tool execution", async () => {
		const callOrder: string[] = [];

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "greet", arguments: '{"name":"World"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, { name }) => {
				callOrder.push("tool_execute");
				return `Hi ${name}!`;
			},
		});

		const hooks: AgentHooks = {
			beforeToolCall: () => {
				callOrder.push("before_tool");
			},
			afterToolCall: ({ result }) => {
				callOrder.push(`after_tool:${result}`);
			},
		};

		const agent = new Agent({ name: "test", model, tools: [greetTool], hooks });
		await run(agent, "Greet");

		expect(callOrder).toEqual(["before_tool", "tool_execute", "after_tool:Hi World!"]);
	});

	test("beforeHandoff fires on handoff", async () => {
		const beforeHandoffFn = mock(({ fromAgent, toAgent }: any) => {
			expect(fromAgent.name).toBe("agent_a");
			expect(toAgent.name).toBe("agent_b");
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "transfer_to_agent_b", arguments: "{}" } },
				],
			},
			{ content: "From B", toolCalls: [] },
		]);

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [agentB],
			hooks: { beforeHandoff: beforeHandoffFn },
		});

		await run(agentA, "Transfer");

		expect(beforeHandoffFn).toHaveBeenCalledTimes(1);
	});

	test("hooks are optional — agent with no hooks works", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");
		expect(result.output).toBe("Hello!");
	});

	test("current agent hooks used after handoff", async () => {
		const callOrder: string[] = [];

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "transfer_to_agent_b", arguments: "{}" } },
				],
			},
			{
				content: null,
				toolCalls: [
					{ id: "tc2", type: "function", function: { name: "do_work", arguments: "{}" } },
				],
			},
			{ content: "All done", toolCalls: [] },
		]);

		const workTool = tool({
			name: "do_work",
			description: "Do work",
			parameters: z.object({}),
			execute: async () => "work done",
		});

		const agentB = new Agent({
			name: "agent_b",
			model,
			tools: [workTool],
			hooks: {
				beforeToolCall: () => {
					callOrder.push("agent_b_before_tool");
				},
			},
		});

		const agentA = new Agent({
			name: "agent_a",
			model,
			handoffs: [agentB],
			hooks: {
				beforeToolCall: () => {
					callOrder.push("agent_a_before_tool");
				},
			},
		});

		await run(agentA, "Transfer then work");

		// After handoff, Agent B's hooks should fire, not Agent A's
		expect(callOrder).toEqual(["agent_b_before_tool"]);
	});

	test("hooks fire in stream mode", async () => {
		const beforeRunFn = mock(() => {});

		const model = mockModel([{ content: "Streamed!", toolCalls: [] }]);
		const agent = new Agent({
			name: "test",
			model,
			hooks: { beforeRun: beforeRunFn },
		});

		const events: StreamEvent[] = [];
		for await (const event of stream(agent, "Hi").stream) {
			events.push(event);
		}

		expect(beforeRunFn).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === "done")).toBe(true);
	});
});
