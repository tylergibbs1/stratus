import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { RunAbortedError } from "../../src/core/errors";
import type { ToolCallDecision, HandoffDecision } from "../../src/core/hooks";
import { run, stream } from "../../src/core/run";
import {
	createSession,
	forkSession,
	prompt,
	resumeSession,
} from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";
import { withTrace } from "../../src/core/tracing";
import type { ContentPart } from "../../src/core/types";

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

// ─── Sessions: Basic Multi-Turn ─────────────────────────────────────────

describe("integration: sessions multi-turn", () => {
	test("multi-turn session preserves context across send/stream cycles", async () => {
		const session = createSession({
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});

		// Turn 1
		session.send("My favorite color is blue. Just acknowledge.");
		for await (const _event of session.stream()) {}

		const r1 = await session.result;
		expect(r1.output.length).toBeGreaterThan(0);

		// Turn 2 — model should remember from turn 1
		session.send("What is my favorite color? One word.");
		for await (const _event of session.stream()) {}

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
		for await (const _event of session.stream()) {}
		const r1 = await session.result;
		expect(r1.output).toContain("85");

		session.send("And New York?");
		for await (const _event of session.stream()) {}
		const r2 = await session.result;
		expect(r2.output).toContain("72");
	}, 120_000);
});

// ─── Multimodal with image ─────────────────────────────────────────────

describe("integration: multimodal image", () => {
	test("image_url ContentPart is accepted by Azure API", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Describe what you see. Be very concise, one sentence max.",
			model,
		});

		// Use a tiny 1x1 transparent PNG as a data URL — tests the wire format
		const tinyPng =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

		const result = await run(agent, [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is this image?" },
					{ type: "image_url", image_url: { url: tinyPng, detail: "low" } },
				],
			},
		]);

		// The model should respond with something — we don't care exactly what, just that Azure accepted the multimodal payload
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.finishReason).toBe("stop");
	}, 60_000);
});

// ─── Output Guardrails ─────────────────────────────────────────────────

describe("integration: output guardrails", () => {
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

// ─── Phase 3A: Quick Wins ──────────────────────────────────────────────

describe("integration: finishReason", () => {
	test("finishReason is 'stop' on normal completion", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Say hello in one word.",
			model,
		});

		const result = await run(agent, "Hi");
		expect(result.finishReason).toBe("stop");
	}, 60_000);

	test("finishReason on stream result", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Say hello in one word.",
			model,
		});

		const { stream: s, result } = stream(agent, "Hi");
		for await (const _event of s) {
			// drain
		}
		const r = await result;
		expect(r.finishReason).toBe("stop");
	}, 60_000);

	test("finishReason tracks through tool loop", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
		});

		const result = await run(agent, "Weather in Tokyo?");
		// After tool loop, final model call should finish with "stop"
		expect(result.finishReason).toBe("stop");
		expect(result.output).toContain("85");
	}, 60_000);
});

describe("integration: cache tokens", () => {
	test("usage has standard token fields", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Be very concise.",
			model,
		});

		const result = await run(agent, "What is 2+2?");
		expect(result.usage.promptTokens).toBeGreaterThan(0);
		expect(result.usage.completionTokens).toBeGreaterThan(0);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
		// cacheReadTokens may or may not be present depending on Azure deployment
	}, 60_000);
});

describe("integration: multimodal", () => {
	test("text-only ContentPart works in run()", async () => {
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

	test("text-only ContentPart works in session.send()", async () => {
		const session = createSession({
			model,
			instructions: "Be very concise. One word answers.",
		});

		const parts: ContentPart[] = [
			{ type: "text", text: "What is 2+2?" },
		];
		session.send(parts);

		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.output).toContain("4");
	}, 60_000);

	test("text-only ContentPart works in prompt()", async () => {
		const parts: ContentPart[] = [
			{ type: "text", text: "What is the capital of Japan? One word." },
		];

		const result = await prompt(parts, {
			model,
			instructions: "Be very concise.",
		});

		expect(result.output.toLowerCase()).toContain("tokyo");
	}, 60_000);
});

// ─── Phase 3B: Enhanced Hooks ──────────────────────────────────────────

describe("integration: enhanced hooks - tool permission control", () => {
	test("deny blocks tool execution, model sees denial message", async () => {
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
		// The model should have received the denial message and responded accordingly
		expect(result.output.length).toBeGreaterThan(0);
		// The tool message should contain our denial reason
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Weather lookups are disabled",
		);
		expect(toolMsg).toBeDefined();
	}, 60_000);

	test("modify changes params before execution", async () => {
		const agent = new Agent({
			name: "test",
			instructions: "Use get_weather to answer. Be concise.",
			model,
			tools: [getWeather],
			hooks: {
				beforeToolCall: () => {
					// Always redirect to London
					return {
						decision: "modify",
						modifiedParams: { city: "London" },
					} as ToolCallDecision;
				},
			},
		});

		const result = await run(agent, "What's the weather in Tokyo?");

		// Should get London's weather instead
		expect(result.output).toContain("55");
	}, 60_000);

	test("handoff deny blocks agent switch", async () => {
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
		// The denial message should be in the messages
		const denialMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Math expert is offline",
		);
		expect(denialMsg).toBeDefined();
	}, 60_000);
});

// ─── Phase 3C: AbortSignal ──────────────────────────────────────────────

describe("integration: abort signal", () => {
	test("pre-aborted signal throws RunAbortedError", async () => {
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
	}, 60_000);

	test("abort during tool execution cancels run", async () => {
		const ac = new AbortController();

		const slowTool = tool({
			name: "slow_task",
			description: "A slow task",
			parameters: z.object({}),
			execute: async (_ctx, _params, options) => {
				// Abort immediately inside the tool
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

	test("session.stream({ signal }) with pre-aborted signal throws", async () => {
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
				// drain
			}
		} catch (e) {
			if (e instanceof RunAbortedError) threw = true;
		}
		expect(threw).toBe(true);
	}, 60_000);
});

// ─── Phase 3D: Session Resume/Fork ──────────────────────────────────────

describe("integration: session resume/fork", () => {
	test("save and resume preserves conversation context", async () => {
		// First session turn
		const session1 = createSession({
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});
		session1.send("My name is Tyler. Remember it.");

		for await (const _event of session1.stream()) {
			// drain
		}

		const snapshot = session1.save();

		// Resume and check context is preserved
		const session2 = resumeSession(snapshot, {
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});
		expect(session2.id).toBe(session1.id);

		session2.send("What is my name?");
		for await (const _event of session2.stream()) {
			// drain
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
			// drain
		}

		const snapshot = session1.save();

		const forked = forkSession(snapshot, {
			model,
			instructions: "You are a helpful assistant. Be very concise.",
		});

		expect(forked.id).not.toBe(session1.id);

		forked.send("What is the secret number?");
		for await (const _event of forked.stream()) {
			// drain
		}

		const result = await forked.result;
		expect(result.output).toContain("42");
	}, 120_000);
});

// ─── Phase 3E: Subagents ──────────────────────────────────────────────

describe("integration: subagents", () => {
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
			instructions:
				"You are a helpful assistant. Use ask_math for any math questions. Be concise.",
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
			instructions:
				"Use run_weather_child for weather questions. Be concise.",
			model,
			subagents: [sa],
		});

		const { result, trace } = await withTrace("subagent-test", () =>
			run(parentAgent, "Weather in Paris?"),
		);

		expect(result.output).toContain("68");

		// Check for subagent span
		const allSpans = trace.spans.flatMap((s) => [s, ...s.children]);
		const subagentSpan = allSpans.find((s) => s.type === "subagent");
		expect(subagentSpan).toBeDefined();
		expect(subagentSpan!.name).toContain("weather_child");
	}, 120_000);

	test("session with subagent", async () => {
		const mathChild = new Agent({
			name: "math_child",
			instructions: "Use calculate to solve. Return only the number.",
			model,
			tools: [calculate],
		});

		const sa = subagent({
			agent: mathChild,
			inputSchema: z.object({
				expr: z.string().describe("Math expression"),
			}),
			mapInput: (params) => `Compute: ${params.expr}`,
		});

		const session = createSession({
			model,
			instructions:
				"Use run_math_child for math. Be concise.",
			subagents: [sa],
		});

		session.send("What is 100 / 4?");
		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.output).toContain("25");
	}, 120_000);
});
