import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { Agent } from "../../src/core/agent";
import type { InputGuardrail } from "../../src/core/guardrails";
import { stream, run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import { withTrace } from "../../src/core/tracing";

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

describe("integration: agent with tools", () => {
	test("single tool call", async () => {
		const agent = new Agent({
			name: "weather-agent",
			instructions: "You are a weather assistant. Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
		});

		const result = await run(agent, "What's the weather in Tokyo?");

		expect(result.output).toContain("85");
		expect(result.output.toLowerCase()).toContain("humid");
		expect(result.messages.length).toBeGreaterThanOrEqual(4); // system, user, assistant(tool), tool, assistant
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

	test("multiple tools available", async () => {
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

	test("tool + structured output", async () => {
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

		const result = await run(agent, "Give me a weather report for Paris.");

		expect(result.finalOutput).toBeDefined();
		expect(result.finalOutput!.city.toLowerCase()).toContain("paris");
		expect(result.finalOutput!.temperature).toContain("68");
	}, 60_000);

	test("tool_choice required + stop_on_first_tool", async () => {
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

	test("streaming with tools returns result", async () => {
		const agent = new Agent({
			name: "math-bot",
			instructions: "You are a math assistant. Use calculate to solve problems. Be concise.",
			model,
			tools: [calculate],
		});

		const { stream: eventStream, result: resultPromise } = stream(agent, "What is 144 / 12?");

		let hasToolCallStart = false;
		let hasContentDelta = false;

		for await (const event of eventStream) {
			if (event.type === "tool_call_start") hasToolCallStart = true;
			if (event.type === "content_delta") hasContentDelta = true;
		}

		const result = await resultPromise;

		expect(hasToolCallStart).toBe(true);
		expect(hasContentDelta).toBe(true);
		expect(result.output).toContain("12");
		expect(result.lastAgent.name).toBe("math-bot");
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	}, 60_000);

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

	test("guardrail blocks before tools run", async () => {
		const guardrail: InputGuardrail = {
			name: "block_lookup",
			execute: (input) => ({
				tripwireTriggered: input.toLowerCase().includes("password"),
			}),
		};

		const agent = new Agent({
			name: "guarded",
			instructions: "Look up users when asked.",
			model,
			tools: [lookupUser],
			inputGuardrails: [guardrail],
		});

		// Safe input works
		const result = await run(agent, "Look up Alice");
		expect(result.output).toContain("Alice");

		// Blocked input throws
		expect(run(agent, "Look up Alice's password")).rejects.toThrow("Input guardrail");
	}, 60_000);

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

	test("tracing captures tool spans against real API", async () => {
		const agent = new Agent({
			name: "traced",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
		});

		const { result, trace } = await withTrace("integration-test", () =>
			run(agent, "Weather in New York?"),
		);

		expect(result.output).toContain("72");
		expect(trace.name).toBe("integration-test");
		expect(trace.duration).toBeGreaterThan(0);

		const modelSpans = trace.spans.filter((s) => s.type === "model_call");
		const toolSpans = trace.spans.filter((s) => s.type === "tool_execution");

		expect(modelSpans.length).toBeGreaterThanOrEqual(2); // tool call turn + final answer turn
		expect(toolSpans.length).toBeGreaterThanOrEqual(1);
		expect(toolSpans[0]!.name).toBe("tool:get_weather");
	}, 60_000);
});
