import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { RunAbortedError } from "../../src/core/errors";
import type { HandoffDecision, ToolCallDecision } from "../../src/core/hooks";
import { stream, run } from "../../src/core/run";
import { createSession, forkSession, resumeSession } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";
import { withTrace } from "../../src/core/tracing";
import type { ContentPart } from "../../src/core/types";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
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
			Tokyo: "85°F, humid",
			Paris: "68°F, partly cloudy",
		};
		return data[city] ?? `No weather data for ${city}`;
	},
});

const calculate = tool({
	name: "calculate",
	description: "Evaluate a math expression and return the result",
	parameters: z.object({
		expression: z.string().describe("The math expression to evaluate, e.g. '2 + 2'"),
	}),
	execute: async (_ctx, { expression }) => {
		try {
			const result = new Function(`return (${expression})`)();
			return String(result);
		} catch {
			return `Error: could not evaluate "${expression}"`;
		}
	},
});

const lookupUser = tool({
	name: "lookup_user",
	description: "Look up a user by name and return their profile",
	parameters: z.object({
		name: z.string().describe("The user's name"),
	}),
	execute: async (_ctx, { name }) => {
		const users: Record<string, object> = {
			Alice: { name: "Alice", age: 30, role: "engineer" },
			Bob: { name: "Bob", age: 25, role: "designer" },
		};
		const user = users[name];
		return user ? JSON.stringify(user) : `User "${name}" not found`;
	},
});

// ─── Basic: Text + Usage ────────────────────────────────────────────────

describe("responses api: basic", () => {
	test("simple text response with usage", async () => {
		const agent = new Agent({
			name: "greeter",
			instructions: "You are a friendly assistant. Be very concise, reply in one short sentence.",
			model,
		});

		const result = await run(agent, "Say hello.");

		expect(result.output).toBeTruthy();
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.usage.promptTokens).toBeGreaterThan(0);
		expect(result.usage.completionTokens).toBeGreaterThan(0);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
		expect(result.finishReason).toBe("stop");
	}, 60_000);
});

// ─── Tools: Single, Parallel, Multiple, toolChoice ──────────────────────

describe("responses api: tools", () => {
	test("single tool call round-trip", async () => {
		const agent = new Agent({
			name: "weather-agent",
			instructions: "You are a weather assistant. Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
		});

		const result = await run(agent, "What's the weather in Tokyo?");

		expect(result.output).toContain("85");
		expect(result.output.toLowerCase()).toContain("humid");
		expect(result.messages.length).toBeGreaterThanOrEqual(4);
	}, 60_000);

	test("parallel tool calls", async () => {
		const agent = new Agent({
			name: "weather-agent",
			instructions: "You are a weather assistant. Use get_weather for each city. Be concise.",
			model,
			tools: [getWeather],
		});

		const result = await run(agent, "Weather in New York and London?");

		expect(result.output).toContain("72");
		expect(result.output).toContain("55");
	}, 60_000);

	test("multiple tools available, model picks correct one", async () => {
		const agent = new Agent({
			name: "assistant",
			instructions:
				"You are a helpful assistant with access to weather, math, and user lookup tools. Be concise.",
			model,
			tools: [getWeather, calculate, lookupUser],
		});

		const result = await run(agent, "What's 17 * 23?");

		expect(result.output).toContain("391");
	}, 60_000);

	test("toolChoice required + stop_on_first_tool", async () => {
		const agent = new Agent({
			name: "extractor",
			instructions: "Extract the user's sentiment using the tool.",
			model,
			tools: [
				tool({
					name: "classify_sentiment",
					description: "Classify the sentiment of text",
					parameters: z.object({
						sentiment: z.enum(["positive", "negative", "neutral"]),
					}),
					execute: async (_ctx, { sentiment }) => sentiment,
				}),
			],
			modelSettings: { toolChoice: "required" },
			toolUseBehavior: "stop_on_first_tool",
		});

		const result = await run(agent, "I'm having the best day ever!");

		expect(result.output).toBe("positive");
	}, 60_000);
});

// ─── Structured Output ──────────────────────────────────────────────────

describe("responses api: structured output", () => {
	test("tool + structured output via Zod schema", async () => {
		const WeatherReport = z.object({
			city: z.string(),
			temperature: z.string(),
			condition: z.string(),
		});

		const agent = new Agent({
			name: "weather-reporter",
			instructions: "Use get_weather to look up the weather, then return a structured report.",
			model,
			tools: [getWeather],
			outputType: WeatherReport,
		});

		const result = await run(agent, "Give me a weather report for Tokyo.");

		expect(result.finalOutput).toBeDefined();
		expect(result.finalOutput!.city.toLowerCase()).toContain("tokyo");
		expect(result.finalOutput!.temperature).toContain("85");
	}, 60_000);
});

// ─── Streaming ──────────────────────────────────────────────────────────

describe("responses api: streaming", () => {
	test("streaming text yields content_delta events", async () => {
		const agent = new Agent({
			name: "streamer",
			instructions: "You are a friendly assistant. Be concise.",
			model,
		});

		const { stream: eventStream, result: resultPromise } = stream(agent, "Say hello.");

		const deltas: string[] = [];
		for await (const event of eventStream) {
			if (event.type === "content_delta") deltas.push(event.content);
		}

		const result = await resultPromise;

		expect(deltas.length).toBeGreaterThan(1);
		expect(deltas.join("")).toBe(result.output);
		expect(result.finishReason).toBe("stop");
	}, 60_000);

	test("streaming with tools yields all event types", async () => {
		const agent = new Agent({
			name: "math-bot",
			instructions: "You are a math assistant. Use calculate to solve problems. Be concise.",
			model,
			tools: [calculate],
		});

		const { stream: eventStream, result: resultPromise } = stream(agent, "What is 144 / 12?");

		let hasToolCallStart = false;
		let hasToolCallDelta = false;
		let hasToolCallDone = false;
		let hasContentDelta = false;

		for await (const event of eventStream) {
			if (event.type === "tool_call_start") hasToolCallStart = true;
			if (event.type === "tool_call_delta") hasToolCallDelta = true;
			if (event.type === "tool_call_done") hasToolCallDone = true;
			if (event.type === "content_delta") hasContentDelta = true;
		}

		const result = await resultPromise;

		expect(hasToolCallStart).toBe(true);
		expect(hasToolCallDelta).toBe(true);
		expect(hasToolCallDone).toBe(true);
		expect(hasContentDelta).toBe(true);
		expect(result.output).toContain("12");
		expect(result.lastAgent.name).toBe("math-bot");
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	}, 60_000);

	test("streaming finishReason tracks through tool loop", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
		});

		const { stream: s, result } = stream(agent, "Weather in Tokyo?");
		for await (const _event of s) {
			// drain
		}
		const r = await result;
		expect(r.finishReason).toBe("stop");
		expect(r.output).toContain("85");
	}, 60_000);
});

// ─── Handoffs ───────────────────────────────────────────────────────────

describe("responses api: handoffs", () => {
	test("handoff with tools on target agent", async () => {
		const mathAgent = new Agent({
			name: "math_expert",
			instructions: "You are a math expert. Use calculate to solve problems. Be concise.",
			model,
			tools: [calculate],
		});

		const router = new Agent({
			name: "router",
			instructions: "Transfer math questions to the math expert immediately.",
			model,
			handoffs: [mathAgent],
		});

		const result = await run(router, "What is 99 * 99?");

		expect(result.output).toContain("9801");
		expect(result.lastAgent.name).toBe("math_expert");
	}, 60_000);
});

// ─── Guardrails ─────────────────────────────────────────────────────────

describe("responses api: guardrails", () => {
	test("input guardrail blocks before tools run", async () => {
		const agent = new Agent({
			name: "guarded",
			instructions: "Look up users when asked.",
			model,
			tools: [lookupUser],
			inputGuardrails: [
				{
					name: "block_password",
					execute: (input) => ({
						tripwireTriggered: input.toLowerCase().includes("password"),
					}),
				},
			],
		});

		const result = await run(agent, "Look up Alice");
		expect(result.output).toContain("Alice");

		expect(run(agent, "Look up Alice's password")).rejects.toThrow("Input guardrail");
	}, 60_000);

	test("output guardrail validates model response", async () => {
		const outputChecks: string[] = [];

		const agent = new Agent({
			name: "test",
			instructions: "Say hello. Be concise.",
			model,
			outputGuardrails: [
				{
					name: "output_logger",
					execute: (output) => {
						outputChecks.push(output);
						return { tripwireTriggered: false };
					},
				},
			],
		});

		const result = await run(agent, "Hi");
		expect(result.output.length).toBeGreaterThan(0);
		expect(outputChecks.length).toBe(1);
		expect(outputChecks[0]).toBe(result.output);
	}, 60_000);
});

// ─── Enhanced Hooks ─────────────────────────────────────────────────────

describe("responses api: hooks", () => {
	test("hooks fire during tool use", async () => {
		const events: string[] = [];

		const agent = new Agent({
			name: "hooked",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
			hooks: {
				beforeRun: () => {
					events.push("beforeRun");
				},
				beforeToolCall: ({ toolCall }) => {
					events.push(`beforeTool:${toolCall.function.name}`);
				},
				afterToolCall: ({ toolCall }) => {
					events.push(`afterTool:${toolCall.function.name}`);
				},
				afterRun: () => {
					events.push("afterRun");
				},
			},
		});

		await run(agent, "Weather in London?");

		expect(events[0]).toBe("beforeRun");
		expect(events).toContain("beforeTool:get_weather");
		expect(events).toContain("afterTool:get_weather");
		expect(events[events.length - 1]).toBe("afterRun");
	}, 60_000);

	test("beforeToolCall deny blocks tool execution", async () => {
		const deniedTools: string[] = [];

		const agent = new Agent({
			name: "test",
			instructions: "Use get_weather to answer weather questions. Be concise.",
			model,
			tools: [getWeather],
			hooks: {
				beforeToolCall: ({ toolCall }) => {
					deniedTools.push(toolCall.function.name);
					return {
						decision: "deny",
						reason: "Weather lookups are disabled",
					} as ToolCallDecision;
				},
			},
		});

		const result = await run(agent, "What's the weather in Tokyo?");

		expect(deniedTools).toContain("get_weather");
		expect(result.output.length).toBeGreaterThan(0);
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Weather lookups are disabled",
		);
		expect(toolMsg).toBeDefined();
	}, 60_000);

	test("beforeToolCall modify changes params", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
			hooks: {
				beforeToolCall: () => {
					return {
						decision: "modify",
						modifiedParams: { city: "London" },
					} as ToolCallDecision;
				},
			},
		});

		const result = await run(agent, "What's the weather in Tokyo?");

		expect(result.output).toContain("55");
	}, 60_000);

	test("beforeHandoff deny blocks agent switch", async () => {
		const mathAgent = new Agent({
			name: "math_expert",
			instructions: "You are a math expert. Use calculate to solve problems. Be concise.",
			model,
			tools: [calculate],
		});

		const router = new Agent({
			name: "router",
			instructions:
				"Transfer math questions to the math expert. If transfer fails, answer directly.",
			model,
			handoffs: [mathAgent],
			hooks: {
				beforeHandoff: () => {
					return {
						decision: "deny",
						reason: "Math expert is offline",
					} as HandoffDecision;
				},
			},
		});

		const result = await run(router, "What is 7 * 7?");

		expect(result.lastAgent.name).toBe("router");
		const denialMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Math expert is offline",
		);
		expect(denialMsg).toBeDefined();
	}, 60_000);
});

// ─── Tracing ────────────────────────────────────────────────────────────

describe("responses api: tracing", () => {
	test("tracing captures model + tool spans", async () => {
		const agent = new Agent({
			name: "traced",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
		});

		const { result, trace } = await withTrace("responses-trace-test", () =>
			run(agent, "Weather in New York?"),
		);

		expect(result.output).toContain("72");
		expect(trace.name).toBe("responses-trace-test");
		expect(trace.duration).toBeGreaterThan(0);

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		const toolSpans = trace.spans.filter((s) => s.type === "tool_execution");

		expect(modelSpans.length).toBeGreaterThanOrEqual(2);
		expect(toolSpans.length).toBeGreaterThanOrEqual(1);
		expect(toolSpans[0]!.name).toBe("tool:get_weather");
	}, 60_000);
});

// ─── Abort Signal ───────────────────────────────────────────────────────

describe("responses api: abort signal", () => {
	test("pre-aborted signal throws RunAbortedError", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Be concise.",
			model,
		});

		const ac = new AbortController();
		ac.abort();

		await expect(run(agent, "Hi", { signal: ac.signal })).rejects.toThrow(RunAbortedError);
	}, 60_000);

	test("abort during tool execution cancels run", async () => {
		const ac = new AbortController();

		const slowTool = tool({
			name: "slow_task",
			description: "A slow task",
			parameters: z.object({}),
			execute: async () => {
				ac.abort();
				return "done";
			},
		});

		const agent = new Agent({
			name: "test",
			instructions: "Use slow_task immediately.",
			model,
			tools: [slowTool],
			modelSettings: { toolChoice: "required" },
		});

		await expect(run(agent, "Do the slow task", { signal: ac.signal })).rejects.toThrow(
			RunAbortedError,
		);
	}, 60_000);
});

// ─── Sessions: Multi-Turn, Resume, Fork ─────────────────────────────────

describe("responses api: sessions", () => {
	test("multi-turn session preserves context", async () => {
		const session = createSession({
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});

		session.send("My favorite color is blue. Just acknowledge.");
		for await (const _event of session.stream()) {
		}
		const r1 = await session.result;
		expect(r1.output.length).toBeGreaterThan(0);

		session.send("What is my favorite color? One word.");
		for await (const _event of session.stream()) {
		}
		const r2 = await session.result;
		expect(r2.output.toLowerCase()).toContain("blue");
	}, 120_000);

	test("session with tools across multiple turns", async () => {
		const session = createSession({
			model,
			instructions: "Use get_weather to answer weather questions. Be concise.",
			tools: [getWeather],
		});

		session.send("Weather in Tokyo?");
		for await (const _event of session.stream()) {
		}
		const r1 = await session.result;
		expect(r1.output).toContain("85");

		session.send("And New York?");
		for await (const _event of session.stream()) {
		}
		const r2 = await session.result;
		expect(r2.output).toContain("72");
	}, 120_000);

	test("save and resume preserves conversation", async () => {
		const session1 = createSession({
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});
		session1.send("My name is Tyler. Remember it.");
		for await (const _event of session1.stream()) {
		}

		const snapshot = session1.save();

		const session2 = resumeSession(snapshot, {
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});
		expect(session2.id).toBe(session1.id);

		session2.send("What is my name?");
		for await (const _event of session2.stream()) {
		}
		const result = await session2.result;
		expect(result.output.toLowerCase()).toContain("tyler");
	}, 120_000);

	test("fork creates independent conversation branch", async () => {
		const session1 = createSession({
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});
		session1.send("The secret number is 42.");
		for await (const _event of session1.stream()) {
		}

		const snapshot = session1.save();

		const forked = forkSession(snapshot, {
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});
		expect(forked.id).not.toBe(session1.id);

		forked.send("What is the secret number?");
		for await (const _event of forked.stream()) {
		}
		const result = await forked.result;
		expect(result.output).toContain("42");
	}, 120_000);

	test("session stream with abort signal", async () => {
		const session = createSession({
			model,
			instructions: "Be concise.",
		});
		session.send("Hi");

		const ac = new AbortController();
		ac.abort();

		let threw = false;
		try {
			for await (const _event of session.stream({ signal: ac.signal })) {
			}
		} catch (e) {
			if (e instanceof RunAbortedError) threw = true;
		}
		expect(threw).toBe(true);
	}, 60_000);
});

// ─── Multimodal ─────────────────────────────────────────────────────────

describe("responses api: multimodal", () => {
	test("text-only ContentPart array works", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Be very concise.",
			model,
		});

		const result = await run(agent, [
			{
				role: "user",
				content: [{ type: "text", text: "What is the capital of France? One word." }],
			},
		]);

		expect(result.output.toLowerCase()).toContain("paris");
	}, 60_000);

	test("ContentPart in session.send", async () => {
		const session = createSession({
			model,
			instructions: "Be very concise. One word answers.",
		});

		const parts: ContentPart[] = [
			{ type: "text", text: "What is the capital of Japan? One word." },
		];
		session.send(parts);
		for await (const _event of session.stream()) {
		}
		const result = await session.result;
		expect(result.output.toLowerCase()).toContain("tokyo");
	}, 60_000);
});

// ─── Subagents ──────────────────────────────────────────────────────────

describe("responses api: subagents", () => {
	test("parent delegates to child subagent", async () => {
		const mathChild = new Agent({
			name: "math_child",
			instructions:
				"You are a math expert. Use calculate to solve problems. Return only the numeric answer.",
			model,
			tools: [calculate],
		});

		const sa = subagent({
			agent: mathChild,
			toolName: "ask_math",
			toolDescription: "Ask the math expert to solve a math problem",
			inputSchema: z.object({
				problem: z.string().describe("The math problem to solve"),
			}),
			mapInput: (params) => params.problem,
		});

		const parentAgent = new Agent({
			name: "parent",
			instructions: "You are a helpful assistant. Use ask_math for any math questions. Be concise.",
			model,
			subagents: [sa],
		});

		const result = await run(parentAgent, "What is 15 * 17?");

		expect(result.output).toContain("255");
	}, 120_000);

	test("subagent with tracing creates subagent span", async () => {
		const childAgent = new Agent({
			name: "weather_child",
			instructions: "Use get_weather to answer. Be very concise.",
			model,
			tools: [getWeather],
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({
				city: z.string().describe("The city to check weather for"),
			}),
			mapInput: (params) => `What's the weather in ${params.city}?`,
		});

		const parentAgent = new Agent({
			name: "parent",
			instructions: "Use run_weather_child for weather questions. Be concise.",
			model,
			subagents: [sa],
		});

		const { result, trace } = await withTrace("responses-subagent-test", () =>
			run(parentAgent, "Weather in Paris?"),
		);

		expect(result.output).toContain("68");

		const allSpans = trace.spans.flatMap((s) => [s, ...s.children]);
		const subagentSpan = allSpans.find((s) => s.type === "subagent");
		expect(subagentSpan).toBeDefined();
		expect(subagentSpan!.name).toContain("weather_child");
	}, 120_000);
});
