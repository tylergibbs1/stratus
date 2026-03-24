import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { run, stream } from "../../src/core/run";
import type { CanUseTool } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { tool } from "../../src/core/tool";

const chatModel = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
});

const responsesModel = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

const getWeather = tool({
	name: "get_weather",
	description: "Get the current weather for a city",
	parameters: z.object({ city: z.string().describe("The city name") }),
	execute: async (_ctx, { city }) => {
		const data: Record<string, string> = {
			"New York": "72°F, sunny",
			London: "55°F, cloudy",
			Tokyo: "85°F, humid",
		};
		return data[city] ?? `No weather data for ${city}`;
	},
});

const calculate = tool({
	name: "calculate",
	description: "Evaluate a math expression",
	parameters: z.object({ expression: z.string() }),
	execute: async (_ctx, { expression }) => {
		try {
			const result = new Function(`return (${expression})`)();
			return String(result);
		} catch {
			return `Error evaluating "${expression}"`;
		}
	},
});

// --- Predicted Output ---

describe("predicted output (Chat Completions)", () => {
	test("prediction field accepted by Azure API", async () => {
		const agent = new Agent({
			name: "predictor",
			model: chatModel,
			instructions: "You are a helpful assistant. Reply concisely.",
			modelSettings: {
				prediction: { type: "content", content: "The capital of France is Paris." },
				temperature: 0,
			},
		});

		const result = await run(agent, "What is the capital of France? Reply in one sentence.");
		expect(result.output).toBeTruthy();
		expect(result.output.toLowerCase()).toContain("paris");
	}, 60000);
});

// --- Allowed Tools ---

describe("allowedTools filtering", () => {
	test("only allowed tools are sent to LLM (Chat Completions)", async () => {
		const agent = new Agent({
			name: "filtered",
			model: chatModel,
			tools: [getWeather, calculate],
			instructions:
				"You have tools available. The user will ask about weather. Use get_weather. Reply concisely.",
		});

		// Only allow get_weather — the LLM should never see calculate
		const result = await run(agent, "What's the weather in Tokyo?", {
			allowedTools: ["get_weather"],
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		expect(result.output.toLowerCase()).toContain("85");
	}, 30000);

	test("wildcard pattern works with real API", async () => {
		const nycWeather = tool({
			name: "mcp__weather__get_nyc",
			description: "Get NYC weather",
			parameters: z.object({}),
			execute: async () => "72°F, sunny in NYC",
		});
		const londonWeather = tool({
			name: "mcp__weather__get_london",
			description: "Get London weather",
			parameters: z.object({}),
			execute: async () => "55°F, cloudy in London",
		});
		const unrelatedTool = tool({
			name: "mcp__db__query",
			description: "Query database",
			parameters: z.object({ sql: z.string() }),
			execute: async () => "results",
		});

		const agent = new Agent({
			name: "wildcard",
			model: chatModel,
			tools: [nycWeather, londonWeather, unrelatedTool],
			instructions: "Use the NYC weather tool to answer. Reply concisely.",
		});

		const result = await run(agent, "What's the weather in NYC?", {
			allowedTools: ["mcp__weather__*"],
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		// Should have used weather tool, not db tool
		const toolMessages = result.messages.filter((m) => m.role === "tool");
		for (const msg of toolMessages) {
			expect((msg as any).content).not.toContain("results");
		}
	}, 30000);
});

// --- canUseTool HITL ---

describe("canUseTool HITL", () => {
	test("deny blocks tool and LLM gets the deny message", async () => {
		const agent = new Agent({
			name: "hitl",
			model: chatModel,
			tools: [getWeather],
			instructions:
				"You have a weather tool. If a tool call is denied, tell the user it was blocked.",
		});

		const canUseTool: CanUseTool = async (toolName) => {
			if (toolName === "get_weather") {
				return { behavior: "deny", message: "User blocked weather lookups" };
			}
			return { behavior: "allow" };
		};

		const result = await run(agent, "What's the weather in London?", {
			canUseTool,
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		// The tool message should contain the deny reason
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		expect((toolMsg as any).content).toBe("User blocked weather lookups");
	}, 30000);

	test("allow with modified input changes tool params", async () => {
		let executedCity = "";
		const trackingWeather = tool({
			name: "get_weather",
			description: "Get weather for a city",
			parameters: z.object({ city: z.string() }),
			execute: async (_ctx, { city }) => {
				executedCity = city;
				return `Weather in ${city}: 75°F`;
			},
		});

		const agent = new Agent({
			name: "hitl-modify",
			model: chatModel,
			tools: [trackingWeather],
			instructions: "Use get_weather to answer. Reply concisely.",
		});

		const canUseTool: CanUseTool = async (_toolName, _input) => ({
			behavior: "allow",
			updatedInput: { city: "Paris" }, // Override whatever the LLM chose
		});

		const result = await run(agent, "What's the weather in Tokyo?", {
			canUseTool,
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		expect(executedCity).toBe("Paris");
	}, 30000);
});

// --- Graceful Interrupt ---

describe("graceful interrupt", () => {
	test("interrupt stops multi-turn run and returns partial result", async () => {
		const agent = new Agent({
			name: "interruptible",
			model: chatModel,
			tools: [getWeather, calculate],
			instructions:
				"First get the weather in NYC, then calculate 100 * 2, then get weather in London. Always use tools.",
		});

		const { stream: s, result, interrupt } = stream(agent, "Do all three tasks.", {
			maxTurns: 10,
		});

		let turnCount = 0;
		for await (const event of s) {
			if (event.type === "done") {
				turnCount++;
				// Interrupt after the first model response completes
				if (turnCount === 1) {
					interrupt();
				}
			}
		}

		const r = await result;
		// Should have stopped early — not all 3+ turns
		expect(r.numTurns).toBeLessThanOrEqual(2);
	}, 60000);
});

// --- Session Tool Management ---

describe("session tool management", () => {
	test("addTools makes new tool available mid-session", async () => {
		const session = createSession({
			model: chatModel,
			tools: [getWeather],
			instructions:
				"ALWAYS use available tools to answer questions. Never refuse. Reply concisely with the tool result.",
		});

		// First turn: only weather available
		session.send("Use the get_weather tool for New York and tell me the result.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r1 = await session.result;
		// Check that the tool was actually called
		const toolMsg1 = r1.messages.find((m) => m.role === "tool");
		expect(toolMsg1).toBeDefined();
		expect((toolMsg1 as any).content).toContain("72°F");

		// Add calculator mid-session
		session.addTools([calculate]);

		// Second turn: now calculate is available too
		session.send("Use the calculate tool to compute 42 * 3.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r2 = await session.result;
		const toolMsg2 = r2.messages.filter((m) => m.role === "tool").pop();
		expect(toolMsg2).toBeDefined();
		expect((toolMsg2 as any).content).toContain("126");

		session.close();
	}, 60000);

	test("removeTools hides tool from subsequent turns", async () => {
		const session = createSession({
			model: chatModel,
			tools: [getWeather, calculate],
			instructions:
				"You have tools. If a tool is not available, say 'no tool available'. Reply concisely.",
		});

		// Remove weather tool
		session.removeTools(["get_weather"]);

		session.send("What's the weather in NYC?");
		for await (const _ of session.stream()) {
			// drain
		}
		const r = await session.result;
		// Without the weather tool, the LLM shouldn't be able to fetch weather data
		expect(r.output.toLowerCase()).not.toContain("72°f");

		session.close();
	}, 30000);
});

// --- Responses API: Context Management ---

describe("context management (Responses API)", () => {
	test("contextManagement accepted by Responses API", async () => {
		const agent = new Agent({
			name: "context-mgmt",
			model: responsesModel,
			instructions: "Reply concisely.",
			modelSettings: {
				contextManagement: [{ type: "compaction", compact_threshold: 200000 }],
			},
		});

		const result = await run(agent, "Say hello.");
		expect(result.output).toBeTruthy();
	}, 30000);
});
