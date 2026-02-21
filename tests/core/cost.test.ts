import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { createCostEstimator } from "../../src/core/cost";
import { MaxBudgetExceededError } from "../../src/core/errors";
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

describe("createCostEstimator", () => {
	test("calculates cost from input and output tokens", () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		const cost = estimator({
			promptTokens: 1000,
			completionTokens: 500,
			totalTokens: 1500,
		});

		expect(cost).toBeCloseTo(0.025, 6); // 0.01 + 0.015
	});

	test("accounts for cached tokens", () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
			cachedInputTokenCostPer1k: 0.005,
		});

		const cost = estimator({
			promptTokens: 1000,
			completionTokens: 500,
			totalTokens: 1500,
			cacheReadTokens: 400,
		});

		// input: (600/1000)*0.01 = 0.006, cached: (400/1000)*0.005 = 0.002, output: (500/1000)*0.03 = 0.015
		expect(cost).toBeCloseTo(0.023, 6);
	});

	test("zero tokens returns zero cost", () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		const cost = estimator({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		});

		expect(cost).toBe(0);
	});
});

describe("cost tracking in run", () => {
	test("totalCostUsd is calculated when costEstimator provided", async () => {
		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		const result = await run(agent, "Hi", { costEstimator: estimator });

		expect(result.totalCostUsd).toBeCloseTo(0.025, 6);
	});

	test("totalCostUsd accumulates across turns", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 2000, completionTokens: 500, totalTokens: 2500 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "noop",
				description: "noop",
				parameters: z.object({}),
				execute: async () => "ok",
			})],
		});

		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		const result = await run(agent, "Do it", { costEstimator: estimator });

		// Turn 1: (1000/1000)*0.01 + (500/1000)*0.03 = 0.025
		// Turn 2: (2000/1000)*0.01 + (500/1000)*0.03 = 0.035
		expect(result.totalCostUsd).toBeCloseTo(0.06, 6);
	});

	test("totalCostUsd is 0 when no costEstimator", async () => {
		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.totalCostUsd).toBe(0);
	});
});

describe("budget limits", () => {
	test("maxBudgetUsd without costEstimator throws at startup", async () => {
		const model = mockModel([
			{ content: "Hello!", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
		]);

		const agent = new Agent({ name: "test", model });

		await expect(run(agent, "Hi", { maxBudgetUsd: 1.0 })).rejects.toThrow(
			"maxBudgetUsd requires a costEstimator",
		);
	});

	test("exceeding budget throws MaxBudgetExceededError", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "noop", arguments: "{}" } }],
				usage: { promptTokens: 10000, completionTokens: 5000, totalTokens: 15000 },
			},
			{
				content: "Done",
				toolCalls: [],
				usage: { promptTokens: 10000, completionTokens: 5000, totalTokens: 15000 },
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [tool({
				name: "noop",
				description: "noop",
				parameters: z.object({}),
				execute: async () => "ok",
			})],
		});

		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		// Each turn costs: (10000/1000)*0.01 + (5000/1000)*0.03 = 0.25
		// Budget of 0.20 should be exceeded after first turn
		try {
			await run(agent, "Do it", { costEstimator: estimator, maxBudgetUsd: 0.20 });
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(MaxBudgetExceededError);
			const e = error as MaxBudgetExceededError;
			expect(e.budgetUsd).toBe(0.20);
			expect(e.spentUsd).toBeCloseTo(0.25, 4);
		}
	});

	test("budget enforcement in stream", async () => {
		const model = mockModel([
			{
				content: "Expensive response",
				toolCalls: [],
				usage: { promptTokens: 100000, completionTokens: 50000, totalTokens: 150000 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		const { stream: s, result } = stream(agent, "Expensive", {
			costEstimator: estimator,
			maxBudgetUsd: 0.001,
		});

		// Suppress unhandled rejection from result promise
		result.catch(() => {});

		try {
			for await (const _event of s) {
				// drain
			}
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(MaxBudgetExceededError);
		}
	});

	test("cost in stream result", async () => {
		const model = mockModel([
			{
				content: "Hello!",
				toolCalls: [],
				usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
			},
		]);

		const agent = new Agent({ name: "test", model });
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.01,
			outputTokenCostPer1k: 0.03,
		});

		const { stream: s, result } = stream(agent, "Hi", { costEstimator: estimator });
		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.totalCostUsd).toBeCloseTo(0.025, 6);
	});
});
