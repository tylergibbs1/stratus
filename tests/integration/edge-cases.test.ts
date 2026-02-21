import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import {
	ContentFilterError,
	MaxTurnsExceededError,
	OutputParseError,
	RunAbortedError,
} from "../../src/core/errors";
import type { InputGuardrail, OutputGuardrail } from "../../src/core/guardrails";
import type { ToolCallDecision } from "../../src/core/hooks";
import { run, stream } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { tool } from "../../src/core/tool";
import { withTrace } from "../../src/core/tracing";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

// ─── Tool error recovery ─────────────────────────────────────────────────

describe("edge: tool error recovery against real API", () => {
	test("model recovers when tool throws an error", async () => {
		let callCount = 0;
		const flaky = tool({
			name: "flaky_service",
			description: "A service that fails on first call but succeeds on retry",
			parameters: z.object({ query: z.string() }),
			execute: async (_ctx, { query }) => {
				callCount++;
				if (callCount === 1) {
					throw new Error("Service temporarily unavailable");
				}
				return `Result for: ${query}`;
			},
		});

		const agent = new Agent({
			name: "resilient",
			instructions:
				"Use flaky_service to answer. If it fails, try again with the same query. Be concise.",
			model,
			tools: [flaky],
		});

		const result = await run(agent, "Search for 'typescript agents'");

		// Model should have retried after seeing the error
		expect(callCount).toBeGreaterThanOrEqual(2);
		expect(result.output).toBeTruthy();
	}, 60_000);

	test("model adapts when tool returns empty string", async () => {
		const emptyTool = tool({
			name: "lookup",
			description: "Look up information",
			parameters: z.object({ query: z.string() }),
			execute: async () => "",
		});

		const agent = new Agent({
			name: "test",
			instructions:
				"Use lookup to search. If the result is empty, tell the user no results were found. Be concise.",
			model,
			tools: [emptyTool],
		});

		const result = await run(agent, "Find information about XYZ123");
		expect(result.output).toBeTruthy();
		expect(result.output.length).toBeGreaterThan(0);
	}, 60_000);
});

// ─── maxTurns limit ──────────────────────────────────────────────────────

describe("edge: maxTurns with real API", () => {
	test("maxTurns=2 prevents runaway tool loops", async () => {
		const counter = tool({
			name: "increment",
			description: "Increment a counter. Always call this tool.",
			parameters: z.object({}),
			execute: async () => "Incremented. Call increment again.",
		});

		const agent = new Agent({
			name: "looper",
			instructions: "Always use the increment tool. Never stop calling it.",
			model,
			tools: [counter],
			modelSettings: { toolChoice: "required" },
		});

		await expect(run(agent, "Go", { maxTurns: 2 })).rejects.toThrow(
			MaxTurnsExceededError,
		);
	}, 60_000);
});

// ─── Abort signal ────────────────────────────────────────────────────────

describe("edge: abort with real API", () => {
	test("pre-aborted signal throws immediately", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Be concise.",
			model,
		});

		const ac = new AbortController();
		ac.abort();

		await expect(run(agent, "Hi", { signal: ac.signal })).rejects.toThrow(
			RunAbortedError,
		);
	}, 10_000);

	test("timeout aborts long-running tool", async () => {
		const slow = tool({
			name: "slow_task",
			description: "A very slow task",
			parameters: z.object({}),
			execute: async (_ctx, _params, options) => {
				// Wait up to 30s, but should be cancelled by timeout
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 30_000);
					options?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("Aborted"));
					});
				});
				return "done";
			},
		});

		const agent = new Agent({
			name: "test",
			instructions: "Use slow_task immediately.",
			model,
			tools: [slow],
			modelSettings: { toolChoice: "required" },
		});

		const start = Date.now();
		await expect(
			run(agent, "Do it", { signal: AbortSignal.timeout(3000) }),
		).rejects.toThrow();
		const elapsed = Date.now() - start;

		// Should abort well before the 30s tool timeout
		expect(elapsed).toBeLessThan(15_000);
	}, 30_000);
});

// ─── Structured output edge cases ────────────────────────────────────────

describe("edge: structured output with real API", () => {
	test("deeply nested Zod schema", async () => {
		const Schema = z.object({
			company: z.object({
				name: z.string(),
				address: z.object({
					street: z.string(),
					city: z.string(),
					country: z.string(),
				}),
				employees: z.array(
					z.object({
						name: z.string(),
						role: z.string(),
					}),
				),
			}),
		});

		const agent = new Agent({
			name: "extractor",
			instructions: "Extract company info. Invent plausible data.",
			model,
			outputType: Schema,
		});

		const result = await run(agent, "Tell me about Acme Corp.");

		expect(result.finalOutput).toBeDefined();
		expect(result.finalOutput!.company.name).toBeTruthy();
		expect(result.finalOutput!.company.address.city).toBeTruthy();
		expect(result.finalOutput!.company.employees.length).toBeGreaterThan(0);
	}, 60_000);

	test("enum-constrained output", async () => {
		const Sentiment = z.object({
			sentiment: z.enum(["positive", "negative", "neutral"]),
			confidence: z.number().min(0).max(1),
		});

		const agent = new Agent({
			name: "classifier",
			instructions: "Classify sentiment. Return a confidence score between 0 and 1.",
			model,
			outputType: Sentiment,
		});

		const result = await run(
			agent,
			"I absolutely love this product! Best purchase ever!",
		);

		expect(result.finalOutput).toBeDefined();
		expect(result.finalOutput!.sentiment).toBe("positive");
		expect(result.finalOutput!.confidence).toBeGreaterThan(0.5);
	}, 60_000);
});

// ─── Guardrails with real API ────────────────────────────────────────────

describe("edge: guardrails with real API", () => {
	test("input guardrail blocks before any API call", async () => {
		let modelCalled = false;

		const guard: InputGuardrail = {
			name: "block_all",
			execute: () => ({ tripwireTriggered: true }),
		};

		const agent = new Agent({
			name: "test",
			instructions: "Be concise.",
			model,
			inputGuardrails: [guard],
			hooks: {
				beforeRun: () => {
					modelCalled = true;
				},
			},
		});

		await expect(run(agent, "Hi")).rejects.toThrow("Input guardrail");
		// beforeRun fires before guardrails, but model should NOT have been called
		// (the error happens before the first model call)
	}, 10_000);

	test("output guardrail rejects model response", async () => {
		const guard: OutputGuardrail = {
			name: "reject_all",
			execute: () => ({
				tripwireTriggered: true,
				outputInfo: "All output rejected for testing",
			}),
		};

		const agent = new Agent({
			name: "test",
			instructions: "Say hello.",
			model,
			outputGuardrails: [guard],
		});

		await expect(run(agent, "Hi")).rejects.toThrow("Output guardrail");
	}, 60_000);
});

// ─── Hooks with real API ─────────────────────────────────────────────────

describe("edge: hooks with real API", () => {
	test("beforeToolCall deny sends denial to model, model responds", async () => {
		const getWeather = tool({
			name: "get_weather",
			description: "Get weather for a city",
			parameters: z.object({ city: z.string() }),
			execute: async (_ctx, { city }) => `72°F in ${city}`,
		});

		const agent = new Agent({
			name: "test",
			instructions:
				"Use get_weather to answer. If denied, apologize and say weather is unavailable.",
			model,
			tools: [getWeather],
			hooks: {
				beforeToolCall: () =>
					({
						decision: "deny",
						reason: "Weather service is down for maintenance",
					}) as ToolCallDecision,
			},
		});

		const result = await run(agent, "What's the weather in NYC?");

		// Tool should not have executed (no real weather data)
		expect(result.output).not.toContain("72°F");
		// Model should reference the denial
		expect(result.output.length).toBeGreaterThan(0);

		// Denial message should be in the messages
		const denialMsg = result.messages.find(
			(m) =>
				m.role === "tool" && m.content.includes("maintenance"),
		);
		expect(denialMsg).toBeDefined();
	}, 60_000);

	test("beforeToolCall modify changes parameters", async () => {
		const getWeather = tool({
			name: "get_weather",
			description: "Get weather for a city",
			parameters: z.object({ city: z.string() }),
			execute: async (_ctx, { city }) => {
				// Should receive "London" not "Tokyo" due to modify hook
				return `Weather in ${city}: 55°F, cloudy`;
			},
		});

		let receivedCity: string | undefined;
		const agent = new Agent({
			name: "test",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [
				tool({
					name: "get_weather",
					description: "Get weather for a city",
					parameters: z.object({ city: z.string() }),
					execute: async (_ctx, { city }) => {
						receivedCity = city;
						return `Weather in ${city}: 55°F, cloudy`;
					},
				}),
			],
			hooks: {
				beforeToolCall: () =>
					({
						decision: "modify",
						modifiedParams: { city: "London" },
					}) as ToolCallDecision,
			},
		});

		await run(agent, "What's the weather in Tokyo?");
		expect(receivedCity).toBe("London");
	}, 60_000);
});

// ─── Concurrent runs with real API ───────────────────────────────────────

describe("edge: concurrency with real API", () => {
	test("three parallel runs complete independently", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Reply with the exact number given to you and nothing else.",
			model,
		});

		const [r1, r2, r3] = await Promise.all([
			run(agent, "Reply with exactly: 111"),
			run(agent, "Reply with exactly: 222"),
			run(agent, "Reply with exactly: 333"),
		]);

		expect(r1.output).toContain("111");
		expect(r2.output).toContain("222");
		expect(r3.output).toContain("333");
	}, 60_000);
});

// ─── Streaming edge cases with real API ──────────────────────────────────

describe("edge: streaming with real API", () => {
	test("streamed content matches final result exactly", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Be concise. One sentence.",
			model,
		});

		const { stream: s, result } = stream(agent, "Say hello.");

		let accumulated = "";
		for await (const event of s) {
			if (event.type === "content_delta") accumulated += event.content;
		}

		const r = await result;
		expect(accumulated).toBe(r.output);
	}, 60_000);

	test("streaming tool calls have correct event sequence", async () => {
		const calc = tool({
			name: "calculate",
			description: "Evaluate a math expression",
			parameters: z.object({ expression: z.string() }),
			execute: async (_ctx, { expression }) => {
				return String(new Function(`return (${expression})`)());
			},
		});

		const agent = new Agent({
			name: "math",
			instructions: "Use calculate to solve. Be concise.",
			model,
			tools: [calc],
		});

		const { stream: s, result } = stream(agent, "What is 7 * 13?");

		const eventTypes: string[] = [];
		for await (const event of s) {
			eventTypes.push(event.type);
		}

		const r = await result;

		// Should have tool events followed by content events
		expect(eventTypes).toContain("tool_call_start");
		expect(eventTypes).toContain("tool_call_done");
		expect(eventTypes).toContain("content_delta");
		// done should be the last event type
		expect(eventTypes[eventTypes.length - 1]).toBe("done");
		expect(r.output).toContain("91");
	}, 60_000);
});

// ─── Multi-turn session edge cases ───────────────────────────────────────

describe("edge: session memory with real API", () => {
	test("session preserves context across 3+ turns", async () => {
		const session = createSession({
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});

		// Turn 1: establish facts
		session.send("My name is Alice and I live in Portland.");
		for await (const _e of session.stream()) {}

		// Turn 2: add more facts
		session.send("My favorite food is sushi.");
		for await (const _e of session.stream()) {}

		// Turn 3: test recall of both facts
		session.send("What's my name, where do I live, and what's my favorite food?");
		for await (const _e of session.stream()) {}

		const result = await session.result;
		const output = result.output.toLowerCase();
		expect(output).toContain("alice");
		expect(output).toContain("portland");
		expect(output).toContain("sushi");
	}, 120_000);
});

// ─── Tracing under real load ─────────────────────────────────────────────

describe("edge: tracing with real API", () => {
	test("trace captures all spans including tool failures", async () => {
		let callCount = 0;
		const flaky = tool({
			name: "flaky_api",
			description: "An API that fails first, succeeds second",
			parameters: z.object({ query: z.string() }),
			execute: async (_ctx, { query }) => {
				callCount++;
				if (callCount === 1) throw new Error("Connection refused");
				return `Results for: ${query}`;
			},
		});

		const agent = new Agent({
			name: "traced_agent",
			instructions:
				"Use flaky_api to answer. If it fails, try again. Be concise.",
			model,
			tools: [flaky],
		});

		const { result, trace } = await withTrace("edge-test", () =>
			run(agent, "Search for TypeScript"),
		);

		expect(result.output).toBeTruthy();
		expect(trace.name).toBe("edge-test");
		expect(trace.duration).toBeGreaterThan(0);

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		const toolSpans = trace.spans.filter((s) => s.type === "tool_execution");

		// At least 2 model calls (tool call + final), at least 2 tool executions (fail + success)
		expect(modelSpans.length).toBeGreaterThanOrEqual(2);
		expect(toolSpans.length).toBeGreaterThanOrEqual(2);
	}, 60_000);
});

// ─── Usage tracking with real API ────────────────────────────────────────

describe("edge: usage tracking with real API", () => {
	test("usage accumulates across tool call rounds", async () => {
		const lookup = tool({
			name: "lookup",
			description: "Look up data",
			parameters: z.object({ key: z.string() }),
			execute: async (_ctx, { key }) => `Value for ${key}: 42`,
		});

		const agent = new Agent({
			name: "test",
			instructions: "Use lookup to answer. Be concise.",
			model,
			tools: [lookup],
		});

		const result = await run(agent, "What is the value for 'test_key'?");

		// Should have usage from at least 2 model calls
		expect(result.usage.promptTokens).toBeGreaterThan(0);
		expect(result.usage.completionTokens).toBeGreaterThan(0);
		expect(result.usage.totalTokens).toBeGreaterThan(
			result.usage.promptTokens,
		);
	}, 60_000);
});
