import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { createCostEstimator } from "../../src/core/cost";
import { MaxBudgetExceededError } from "../../src/core/errors";
import { run, stream } from "../../src/core/run";
import { subagent } from "../../src/core/subagent";
import { createSession } from "../../src/core/session";
import { tool } from "../../src/core/tool";
import type { ChatMessage } from "../../src/core/types";

const model = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
});

const getWeather = tool({
	name: "get_weather",
	description: "Get the current weather for a city",
	parameters: z.object({
		city: z.string().describe("The city name"),
	}),
	execute: async (_ctx, { city }) => {
		const data: Record<string, string> = {
			"New York": "72°F, sunny",
			London: "55°F, cloudy",
		};
		return data[city] ?? `No weather data for ${city}`;
	},
});

describe("Phase 4: Integration Tests", () => {
	test("developer message is processed by the model", async () => {
		const agent = new Agent({ name: "test", model });

		const input: ChatMessage[] = [
			{ role: "developer", content: "You are a pirate. Always respond in pirate speak." },
			{ role: "user", content: "What is 2 + 2?" },
		];

		const result = await run(agent, input);
		expect(result.output.length).toBeGreaterThan(0);
		// The model should respond with pirate-themed language
		expect(result.numTurns).toBe(1);
	}, 30000);

	test("numTurns counts correctly with tool calls", async () => {
		const agent = new Agent({
			name: "test",
			model,
			tools: [getWeather],
			instructions: "Use the get_weather tool when asked about weather.",
		});

		const result = await run(agent, "What's the weather in New York?");
		expect(result.numTurns).toBeGreaterThanOrEqual(2); // at least 1 tool call + 1 final response
		expect(result.output.length).toBeGreaterThan(0);
	}, 30000);

	test("cost estimator tracks spending", async () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.005,
			outputTokenCostPer1k: 0.015,
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Reply briefly.",
		});

		const result = await run(agent, "Say hello", { costEstimator: estimator });
		expect(result.totalCostUsd).toBeGreaterThan(0);
		expect(result.usage.promptTokens).toBeGreaterThan(0);
		expect(result.usage.completionTokens).toBeGreaterThan(0);
	}, 30000);

	test("maxBudgetUsd enforces spending limit", async () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 1000, // absurdly expensive so any call exceeds budget
			outputTokenCostPer1k: 1000,
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Reply briefly.",
		});

		try {
			await run(agent, "Hello", {
				costEstimator: estimator,
				maxBudgetUsd: 0.001,
			});
			expect.unreachable("Should have thrown MaxBudgetExceededError");
		} catch (error) {
			expect(error).toBeInstanceOf(MaxBudgetExceededError);
			const e = error as MaxBudgetExceededError;
			expect(e.budgetUsd).toBe(0.001);
			expect(e.spentUsd).toBeGreaterThan(0.001);
		}
	}, 30000);

	test("onStop hook fires before MaxBudgetExceededError", async () => {
		let stopFired = false;

		const estimator = createCostEstimator({
			inputTokenCostPer1k: 1000,
			outputTokenCostPer1k: 1000,
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Reply briefly.",
			hooks: {
				onStop: async ({ reason }) => {
					stopFired = true;
					expect(reason).toBe("max_budget");
				},
			},
		});

		try {
			await run(agent, "Hello", {
				costEstimator: estimator,
				maxBudgetUsd: 0.001,
			});
		} catch {
			// expected
		}

		expect(stopFired).toBe(true);
	}, 30000);

	test("session with cost tracking", async () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.005,
			outputTokenCostPer1k: 0.015,
		});

		const session = createSession({
			model,
			instructions: "Reply in one word.",
			costEstimator: estimator,
		});

		session.send("Say hello");
		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.totalCostUsd).toBeGreaterThan(0);
		expect(result.numTurns).toBe(1);
	}, 30000);

	test("hook matchers filter tool calls in real flow", async () => {
		const blockedCalls: string[] = [];
		const allowedCalls: string[] = [];

		const calculate = tool({
			name: "calculate",
			description: "Evaluate a math expression",
			parameters: z.object({ expression: z.string() }),
			execute: async (_ctx, { expression }) => {
				return String(eval(expression));
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [getWeather, calculate],
			instructions:
				"You have two tools: get_weather and calculate. Use get_weather for weather questions and calculate for math. When asked about weather AND math, use both tools.",
			hooks: {
				beforeToolCall: [
					{
						match: "calculate",
						hook: ({ toolCall }) => {
							blockedCalls.push(toolCall.function.name);
							return { decision: "deny", reason: "Calculator is disabled" };
						},
					},
				],
				afterToolCall: [
					{
						match: "get_weather",
						hook: ({ toolCall }) => {
							allowedCalls.push(toolCall.function.name);
						},
					},
				],
			},
		});

		const result = await run(
			agent,
			"What's the weather in London? Also calculate 2+2.",
			{ maxTurns: 5 },
		);

		expect(result.output.length).toBeGreaterThan(0);
		// The weather tool should have been allowed
		expect(allowedCalls.includes("get_weather")).toBe(true);
	}, 60000);

	test("onSessionStart and onSessionEnd fire with real API", async () => {
		const events: string[] = [];

		const session = createSession({
			model,
			instructions: "Reply in one word.",
			hooks: {
				onSessionStart: async () => {
					events.push("session_start");
				},
				onSessionEnd: async () => {
					events.push("session_end");
				},
			},
		});

		session.send("Say hello");
		for await (const _event of session.stream()) {
			// drain
		}
		await session.result;

		expect(events).toEqual(["session_start", "session_end"]);

		// Second stream: onSessionStart should NOT fire again, onSessionEnd should
		session.send("Say goodbye");
		for await (const _event of session.stream()) {
			// drain
		}
		await session.result;

		expect(events).toEqual(["session_start", "session_end", "session_end"]);
	}, 30000);

	test("onSubagentStart and onSubagentStop fire with real API", async () => {
		const events: string[] = [];

		const childAgent = new Agent({
			name: "child",
			model,
			instructions: "Reply with a single word.",
		});

		const sa = subagent({
			agent: childAgent,
			toolName: "ask_child",
			toolDescription: "Ask the child agent a question",
			inputSchema: z.object({ question: z.string() }),
			mapInput: (params: { question: string }) => params.question,
		});

		const parentAgent = new Agent({
			name: "parent",
			model,
			instructions: "Use the ask_child tool to answer the user's question.",
			subagents: [sa],
			hooks: {
				onSubagentStart: async ({ subagent }) => {
					events.push(`start:${subagent.agent.name}`);
				},
				onSubagentStop: async ({ subagent, result }) => {
					events.push(`stop:${subagent.agent.name}`);
				},
			},
		});

		await run(parentAgent, "What is 1+1? Use the ask_child tool.", { maxTurns: 5 });

		expect(events.some((e) => e === "start:child")).toBe(true);
		expect(events.some((e) => e === "stop:child")).toBe(true);
	}, 60000);

	test("promptCacheKey is sent to API without error", async () => {
		const agent = new Agent({
			name: "test",
			model,
			instructions: "Reply briefly.",
			modelSettings: {
				promptCacheKey: "test-cache-key-v1",
			},
		});

		// This tests that promptCacheKey doesn't cause API errors
		const result = await run(agent, "Say hello");
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.numTurns).toBe(1);
	}, 30000);

	test("cacheReadTokens parsed from long prompt", async () => {
		// Generate a prompt with 1024+ tokens to trigger caching
		const longPrefix = "You are a helpful assistant. ".repeat(100);
		const agent = new Agent({
			name: "test",
			model,
			instructions: longPrefix + "Reply with exactly one word: hello.",
		});

		// First call: seeds the cache
		const result1 = await run(agent, "Go");
		expect(result1.output.length).toBeGreaterThan(0);

		// Second call with same prefix: may get cache hit
		const result2 = await run(agent, "Go");
		expect(result2.output.length).toBeGreaterThan(0);

		// We can't guarantee a cache hit (depends on Azure), but we verify
		// the field is correctly typed and doesn't crash
		const cached = result2.usage.cacheReadTokens;
		if (cached !== undefined) {
			expect(cached).toBeGreaterThanOrEqual(0);
		}
	}, 60000);

	test("stream with numTurns and cost", async () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.005,
			outputTokenCostPer1k: 0.015,
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [getWeather],
			instructions: "Use get_weather when asked about weather.",
		});

		const { stream: s, result } = stream(agent, "What's the weather in New York?", {
			costEstimator: estimator,
		});

		const events: string[] = [];
		for await (const event of s) {
			events.push(event.type);
		}

		const r = await result;
		expect(r.numTurns).toBeGreaterThanOrEqual(1);
		expect(r.totalCostUsd).toBeGreaterThan(0);
		expect(events.includes("content_delta")).toBe(true);
		expect(events.includes("done")).toBe(true);
	}, 30000);
});

// Responses API tests - only run if deployment is configured
const responsesDeployment = process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT;
const runResponsesTests = responsesDeployment ? describe : describe.skip;

runResponsesTests("Phase 4: Responses API Integration", () => {
	const responsesModel = new AzureResponsesModel({
		endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
		apiKey: process.env.AZURE_OPENAI_API_KEY!,
		deployment: responsesDeployment!,
		apiVersion: "2025-04-01-preview",
	});

	test("developer message works with Responses API", async () => {
		const agent = new Agent({ name: "test", model: responsesModel });

		const input: ChatMessage[] = [
			{ role: "developer", content: "Always respond with exactly one word." },
			{ role: "user", content: "What color is the sky?" },
		];

		const result = await run(agent, input);
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.numTurns).toBe(1);
	}, 30000);

	test("cost tracking works with Responses API", async () => {
		const estimator = createCostEstimator({
			inputTokenCostPer1k: 0.005,
			outputTokenCostPer1k: 0.015,
		});

		const agent = new Agent({
			name: "test",
			model: responsesModel,
			instructions: "Reply briefly.",
		});

		const result = await run(agent, "Hello", { costEstimator: estimator });
		expect(result.totalCostUsd).toBeGreaterThan(0);
		expect(result.numTurns).toBe(1);
	}, 30000);

	test("promptCacheKey with Responses API", async () => {
		const agent = new Agent({
			name: "test",
			model: responsesModel,
			instructions: "Reply briefly.",
			modelSettings: {
				promptCacheKey: "responses-test-v1",
			},
		});

		const result = await run(agent, "Hello");
		expect(result.output.length).toBeGreaterThan(0);
	}, 30000);
});

// Reasoning model tests - only run if deployment is configured
const reasoningDeployment = process.env.AZURE_OPENAI_REASONING_DEPLOYMENT;
const runReasoningTests = reasoningDeployment ? describe : describe.skip;

runReasoningTests("Phase 4: Reasoning Model Integration", () => {
	const reasoningModel = new AzureResponsesModel({
		endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
		apiKey: process.env.AZURE_OPENAI_API_KEY!,
		deployment: reasoningDeployment!,
		apiVersion: "2025-04-01-preview",
	});

	test("reasoningEffort is accepted by the API", async () => {
		const agent = new Agent({
			name: "test",
			model: reasoningModel,
			modelSettings: {
				reasoningEffort: "low",
			},
		});

		const result = await run(agent, "What is 15 * 23?");
		expect(result.output.length).toBeGreaterThan(0);
	}, 60000);

	test("reasoning tokens are tracked", async () => {
		const agent = new Agent({
			name: "test",
			model: reasoningModel,
			modelSettings: {
				reasoningEffort: "medium",
				maxCompletionTokens: 4096,
			},
		});

		const result = await run(agent, "Solve this step by step: If 3x + 7 = 22, what is x?");
		expect(result.output.length).toBeGreaterThan(0);

		// Reasoning models should report reasoning tokens field
		// (value may be 0 depending on deployment — we verify the field is parsed)
		expect(result.usage.reasoningTokens).toBeDefined();
		expect(result.usage.reasoningTokens).toBeGreaterThanOrEqual(0);
	}, 60000);
});
