import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { createCostEstimator } from "../../src/core/cost";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
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

describe("onStop hook", () => {
	test("fires on MaxTurnsExceededError", async () => {
		let stopReason: string | undefined;
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: null,
				toolCalls: [{ id: "tc2", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [
				tool({
					name: "noop",
					description: "noop",
					parameters: z.object({}),
					execute: async () => "ok",
				}),
			],
			hooks: {
				onStop: async ({ reason }) => {
					stopReason = reason;
				},
			},
		});

		try {
			await run(agent, "Loop forever", { maxTurns: 1 });
		} catch {
			// expected
		}

		expect(stopReason).toBe("max_turns");
	});

	test("fires on MaxBudgetExceededError", async () => {
		let stopReason: string | undefined;
		const model = mockModel([
			{
				content: "Expensive",
				toolCalls: [],
				usage: { promptTokens: 100000, completionTokens: 50000, totalTokens: 150000 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			hooks: {
				onStop: async ({ reason }) => {
					stopReason = reason;
				},
			},
		});

		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		try {
			await run(agent, "Expensive", { costEstimator: estimator, maxBudgetUsd: 0.001 });
		} catch {
			// expected
		}

		expect(stopReason).toBe("max_budget");
	});
});

describe("onSubagentStart/onSubagentStop hooks", () => {
	test("fires around subagent execution", async () => {
		const events: string[] = [];

		const childModel = mockModel([
			{
				content: "Child result",
				toolCalls: [],
				usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
			},
		]);

		const childAgent = new Agent({ name: "child", model: childModel });

		const sa = subagent({
			agent: childAgent,
			toolName: "ask_child",
			toolDescription: "Ask the child agent",
			inputSchema: z.object({ query: z.string() }),
			mapInput: (params: { query: string }) => params.query,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "ask_child", arguments: '{"query":"hello"}' },
					},
				],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "Parent done",
				toolCalls: [],
				usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
			},
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
			hooks: {
				onSubagentStart: async ({ subagent: sa }) => {
					events.push(`start:${sa.agent.name}`);
				},
				onSubagentStop: async ({ subagent: sa, result }) => {
					events.push(`stop:${sa.agent.name}:${result}`);
				},
			},
		});

		await run(parentAgent, "Use child");

		expect(events).toEqual(["start:child", "stop:child:Child result"]);
	});
});

describe("onSessionStart/onSessionEnd hooks", () => {
	test("fires on session stream lifecycle", async () => {
		const events: string[] = [];

		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const session = createSession({
			model,
			hooks: {
				onSessionStart: async () => {
					events.push("session_start");
				},
				onSessionEnd: async () => {
					events.push("session_end");
				},
			},
		});

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		expect(events).toEqual(["session_start", "session_end"]);
	});

	test("onSessionStart fires only once", async () => {
		let startCount = 0;
		let endCount = 0;

		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
			{
				content: "World!",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		]);

		const session = createSession({
			model,
			hooks: {
				onSessionStart: async () => {
					startCount++;
				},
				onSessionEnd: async () => {
					endCount++;
				},
			},
		});

		// First message
		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		// Second message
		session.send("Hello again");
		for await (const _event of session.stream()) {
			// drain
		}

		expect(startCount).toBe(1);
		expect(endCount).toBe(2); // Fires every stream
	});
});
