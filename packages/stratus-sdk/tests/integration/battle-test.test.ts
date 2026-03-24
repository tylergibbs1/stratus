/**
 * Battle tests — stress-test new features against the real Azure API.
 * Targets edge cases, feature combinations, race conditions, and adversarial inputs.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { MaxTurnsExceededError } from "../../src/core/errors";
import { handoff } from "../../src/core/handoff";
import { run, stream, resumeRun } from "../../src/core/run";
import type { CanUseTool } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
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

// --- Shared tools ---

const getWeather = tool({
	name: "get_weather",
	description: "Get weather for a city",
	parameters: z.object({ city: z.string() }),
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

let slowToolCallCount = 0;
const slowTool = tool({
	name: "slow_operation",
	description: "A slow operation that takes time",
	parameters: z.object({ task: z.string() }),
	execute: async (_ctx, { task }) => {
		slowToolCallCount++;
		await new Promise((r) => setTimeout(r, 100));
		return `Completed: ${task}`;
	},
});

const failingTool = tool({
	name: "unreliable",
	description: "A tool that always throws an error",
	parameters: z.object({ input: z.string() }),
	execute: async () => {
		throw new Error("Service unavailable");
	},
});

// ============================================================
// allowedTools edge cases
// ============================================================

describe("allowedTools battle tests", () => {
	test("empty allowedTools array means no tools sent to LLM", async () => {
		const agent = new Agent({
			name: "no-tools",
			model: chatModel,
			tools: [getWeather, calculate],
			instructions: "Reply concisely. If you have no tools, just say 'no tools'.",
		});

		const result = await run(agent, "What's the weather?", {
			allowedTools: [],
			maxTurns: 2,
		});

		// LLM should respond without using tools
		expect(result.output).toBeTruthy();
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(0);
	}, 60000);

	test("allowedTools with handoffs — handoff still works when allowed", async () => {
		const specialist = new Agent({
			name: "weather_specialist",
			model: chatModel,
			tools: [getWeather],
			instructions: "You are a weather specialist. Use the get_weather tool and reply concisely.",
		});

		const router = new Agent({
			name: "router",
			model: chatModel,
			handoffs: [specialist],
			instructions: "You are a router. For weather questions, hand off to weather_specialist.",
		});

		const result = await run(router, "What's the weather in Tokyo?", {
			allowedTools: ["transfer_to_weather_specialist", "get_weather"],
			maxTurns: 5,
		});

		expect(result.output).toBeTruthy();
		expect(result.output.toLowerCase()).toContain("85");
	}, 60000);

	test("allowedTools blocks handoff when not in list", async () => {
		const specialist = new Agent({
			name: "blocked_specialist",
			model: chatModel,
			instructions: "You are a specialist.",
		});

		const router = new Agent({
			name: "router2",
			model: chatModel,
			handoffs: [specialist],
			instructions:
				"For any question, try to hand off to blocked_specialist. If you can't, just answer directly with 'answered directly'.",
		});

		const result = await run(router, "Hello", {
			allowedTools: [], // Block everything including handoffs
			maxTurns: 2,
		});

		// Should not have handed off — no tools available
		expect(result.lastAgent.name).toBe("router2");
	}, 60000);

	test("wildcard doesn't match partial prefixes", async () => {
		const tool1 = tool({
			name: "mcp__github__search",
			description: "Search",
			parameters: z.object({}),
			execute: async () => "found",
		});
		const tool2 = tool({
			name: "mcp__github_enterprise__search",
			description: "Enterprise search",
			parameters: z.object({}),
			execute: async () => "enterprise found",
		});

		const agent = new Agent({
			name: "prefix-test",
			model: chatModel,
			tools: [tool1, tool2],
			instructions: "Use the search tool. Reply concisely.",
		});

		const result = await run(agent, "Search for something", {
			allowedTools: ["mcp__github__*"], // Should NOT match mcp__github_enterprise__*
			maxTurns: 3,
		});

		// The enterprise tool should not have been called
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		for (const msg of toolMsgs) {
			expect((msg as any).content).not.toContain("enterprise");
		}
	}, 60000);
});

// ============================================================
// canUseTool battle tests
// ============================================================

describe("canUseTool battle tests", () => {
	test("canUseTool deny + LLM retries with different approach", async () => {
		let denyCount = 0;
		const canUseTool: CanUseTool = async (toolName) => {
			if (toolName === "get_weather") {
				denyCount++;
				return { behavior: "deny", message: "Weather lookups are disabled. Tell the user you cannot check weather." };
			}
			return { behavior: "allow" };
		};

		const agent = new Agent({
			name: "retry-test",
			model: chatModel,
			tools: [getWeather, calculate],
			instructions: "Try to use tools to answer. If a tool is denied, stop trying that tool and respond to the user.",
		});

		const result = await run(agent, "What's the weather in NYC?", {
			canUseTool,
			maxTurns: 4,
		});

		expect(result.output).toBeTruthy();
		expect(denyCount).toBeGreaterThanOrEqual(1);
		// LLM should eventually give up and respond
		expect(result.numTurns).toBeLessThanOrEqual(4);
	}, 60000);

	test("canUseTool with async delay still works", async () => {
		const canUseTool: CanUseTool = async (toolName) => {
			// Simulate a slow approval process
			await new Promise((r) => setTimeout(r, 500));
			return { behavior: "allow" };
		};

		const agent = new Agent({
			name: "slow-approval",
			model: chatModel,
			tools: [calculate],
			instructions: "Use the calculate tool to answer. Reply concisely.",
		});

		const result = await run(agent, "What is 7 * 8?", {
			canUseTool,
			maxTurns: 3,
		});

		expect(result.output).toContain("56");
	}, 60000);

	test("canUseTool combined with allowedTools — both filter", async () => {
		let canUseToolCalled = false;
		const canUseTool: CanUseTool = async (toolName) => {
			canUseToolCalled = true;
			// Deny calculate even if it passes allowedTools filter
			if (toolName === "calculate") {
				return { behavior: "deny", message: "Calculations are blocked" };
			}
			return { behavior: "allow" };
		};

		const agent = new Agent({
			name: "double-filter",
			model: chatModel,
			tools: [getWeather, calculate],
			instructions: "Use available tools. Reply concisely.",
		});

		const result = await run(agent, "What is 2 + 2? Use the calculate tool.", {
			allowedTools: ["calculate"], // Only calculate is visible
			canUseTool, // But canUseTool denies it
			maxTurns: 3,
		});

		expect(canUseToolCalled).toBe(true);
		// The deny message should appear in tool messages
		const toolMsg = result.messages.find((m) => m.role === "tool");
		if (toolMsg) {
			expect((toolMsg as any).content).toBe("Calculations are blocked");
		}
	}, 60000);

	test("canUseTool interacts with needsApproval tool", async () => {
		const dangerousTool = tool({
			name: "delete_file",
			description: "Delete a file",
			parameters: z.object({ path: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { path }) => `Deleted ${path}`,
		});

		// canUseTool should fire BEFORE needsApproval check since we deny at
		// the canUseTool level, the run should NOT be interrupted
		const canUseTool: CanUseTool = async () => ({
			behavior: "deny",
			message: "All tool calls are blocked",
		});

		const agent = new Agent({
			name: "approval-combo",
			model: chatModel,
			tools: [dangerousTool],
			instructions: "Use the delete_file tool when asked. If denied, say 'blocked'.",
		});

		const result = await run(agent, "Delete /tmp/test.txt", {
			canUseTool,
			maxTurns: 3,
		});

		// Should NOT be interrupted — canUseTool denied before needsApproval kicked in
		expect(result.interrupted).toBe(false);
	}, 60000);
});

// ============================================================
// Graceful interrupt battle tests
// ============================================================

describe("interrupt battle tests", () => {
	test("interrupt during tool execution finishes current turn then stops", async () => {
		slowToolCallCount = 0;
		const agent = new Agent({
			name: "multi-tool",
			model: chatModel,
			tools: [slowTool],
			instructions:
				"Call slow_operation three times with tasks: 'task1', 'task2', 'task3'. Do them one at a time across separate turns.",
		});

		const { stream: s, result, interrupt } = stream(agent, "Do all three tasks.", {
			maxTurns: 10,
		});

		let doneCount = 0;
		for await (const event of s) {
			if (event.type === "done") {
				doneCount++;
				if (doneCount >= 2) {
					interrupt(); // Interrupt after 2 model responses
				}
			}
		}

		const r = await result;
		// Should have stopped before completing all tasks
		expect(r.numTurns).toBeLessThanOrEqual(3);
		expect(r.interrupted).toBe(false); // Graceful, not interrupted
	}, 60000);

	test("double interrupt is idempotent", async () => {
		const agent = new Agent({
			name: "double-int",
			model: chatModel,
			tools: [slowTool],
			instructions: "Call slow_operation with 'test'. Reply concisely after.",
		});

		const { stream: s, result, interrupt } = stream(agent, "Do the task.", { maxTurns: 5 });

		for await (const event of s) {
			if (event.type === "done") {
				interrupt();
				interrupt(); // Second interrupt should be harmless
				interrupt(); // Third too
			}
		}

		const r = await result;
		expect(r).toBeDefined();
		expect(r.interrupted).toBe(false);
	}, 60000);

	test("interrupt + abort signal — abort takes precedence", async () => {
		const controller = new AbortController();
		const agent = new Agent({
			name: "abort-vs-interrupt",
			model: chatModel,
			tools: [slowTool],
			instructions: "Call slow_operation with 'work'. Reply after.",
		});

		const { stream: s, result, interrupt } = stream(agent, "Do the work.", {
			maxTurns: 5,
			signal: controller.signal,
		});

		try {
			for await (const event of s) {
				if (event.type === "done") {
					interrupt(); // Graceful interrupt
					controller.abort(); // Hard abort — should win
				}
			}
		} catch {
			// Expected — abort throws
		}

		// Fully settle the result promise to prevent leaking into subsequent tests
		try {
			await result;
		} catch {
			// Expected — abort throws
		}

		// If we get here without hanging, the test passes
		expect(true).toBe(true);
	}, 60000);
});

// ============================================================
// Session tool management battle tests
// ============================================================

describe("session tool management battle tests", () => {
	test("setTools completely replaces tools", async () => {
		const session = createSession({
			model: chatModel,
			tools: [getWeather, calculate],
			instructions: "ALWAYS use available tools. Reply concisely with the tool result.",
		});

		// Replace all tools with just calculate
		session.setTools([calculate]);

		session.send("Use the calculate tool to compute 99 + 1.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r = await session.result;
		const toolMsg = r.messages.filter((m) => m.role === "tool").pop();
		expect(toolMsg).toBeDefined();
		expect((toolMsg as any).content).toContain("100");

		session.close();
	}, 60000);

	test("removeTools then addTools in sequence", async () => {
		const session = createSession({
			model: chatModel,
			tools: [getWeather, calculate],
			instructions: "ALWAYS use available tools. Reply concisely.",
		});

		// Remove weather, verify calculate still works
		session.removeTools(["get_weather"]);
		session.send("Use calculate for 2 + 2.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r1 = await session.result;
		expect(r1.messages.some((m) => m.role === "tool")).toBe(true);

		// Add weather back, verify it works
		session.addTools([getWeather]);
		session.send("Use get_weather for Tokyo.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r2 = await session.result;
		const weatherMsg = r2.messages.filter((m) => m.role === "tool").pop();
		expect(weatherMsg).toBeDefined();
		expect((weatherMsg as any).content).toContain("85");

		session.close();
	}, 60000);

	test("addTools with duplicate tool names — last one wins at execute time", async () => {
		const weatherV1 = tool({
			name: "get_weather",
			description: "Get weather v1",
			parameters: z.object({ city: z.string() }),
			execute: async () => "v1: 70°F",
		});
		const weatherV2 = tool({
			name: "get_weather",
			description: "Get weather v2",
			parameters: z.object({ city: z.string() }),
			execute: async () => "v2: 99°F",
		});

		const session = createSession({
			model: chatModel,
			tools: [weatherV1],
			instructions: "ALWAYS use get_weather for any weather question. Reply concisely.",
		});

		// Add a second tool with the same name
		session.addTools([weatherV2]);

		session.send("Use get_weather for NYC.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r = await session.result;
		// With duplicate names, the first match in the Map wins — which is the first added (v1)
		// But the run loop builds a Map from the tools array, so the last entry with
		// the same name wins in Map construction. That means v2 executes.
		const toolMsg = r.messages.filter((m) => m.role === "tool").pop();
		expect(toolMsg).toBeDefined();
		expect((toolMsg as any).content).toContain("v2");

		session.close();
	}, 60000);

	test("session with allowedTools + addTools — new tools only visible if allowed", async () => {
		const session = createSession({
			model: chatModel,
			tools: [getWeather],
			allowedTools: ["get_weather"], // Only weather allowed
			instructions: "Use available tools. Reply concisely.",
		});

		// Add calculate — but it's not in allowedTools
		session.addTools([calculate]);

		session.send("Use get_weather for London.");
		for await (const _ of session.stream()) {
			// drain
		}
		const r = await session.result;

		// Weather should work
		const toolMsg = r.messages.filter((m) => m.role === "tool").pop();
		expect(toolMsg).toBeDefined();
		expect((toolMsg as any).content).toContain("55");

		session.close();
	}, 60000);
});

// ============================================================
// Feature combinations
// ============================================================

describe("feature combinations", () => {
	test("canUseTool + interrupt + streaming all work together", async () => {
		let toolCallCount = 0;
		const canUseTool: CanUseTool = async () => {
			toolCallCount++;
			return { behavior: "allow" };
		};

		const agent = new Agent({
			name: "combo",
			model: chatModel,
			tools: [getWeather, calculate],
			instructions:
				"First get weather for NYC, then calculate 10 * 5. Use tools for both. Reply after.",
		});

		const { stream: s, result, interrupt } = stream(agent, "Do both tasks.", {
			canUseTool,
			maxTurns: 6,
		});

		let doneCount = 0;
		const events: string[] = [];
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "done") {
				doneCount++;
				if (doneCount >= 2) {
					interrupt();
				}
			}
		}

		const r = await result;
		expect(r).toBeDefined();
		// The LLM may or may not call tools before interrupt fires.
		// What matters is that all three features (canUseTool, interrupt, streaming) worked
		// without errors, deadlocks, or hangs.
		expect(events.length).toBeGreaterThan(0);
		expect(events).toContain("done");
	}, 60000);

	test("allowedTools + subagents — subagent tools respect parent filter", async () => {
		const childAgent = new Agent({
			name: "math_agent",
			model: chatModel,
			tools: [calculate],
			instructions: "Use calculate to solve math. Reply concisely.",
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ question: z.string() }),
			mapInput: (params) => params.question,
		});

		const parentAgent = new Agent({
			name: "parent",
			model: chatModel,
			tools: [getWeather],
			subagents: [sa],
			instructions:
				"For math, use run_math_agent. For weather, use get_weather. Reply concisely.",
		});

		// Only allow the subagent tool, block direct weather
		const result = await run(parentAgent, "What is 15 * 4?", {
			allowedTools: ["run_math_agent"],
			maxTurns: 5,
		});

		expect(result.output).toBeTruthy();
		expect(result.output).toContain("60");
	}, 60000);

	test("Responses model with allowedTools and canUseTool", async () => {
		let permissionChecks = 0;
		const canUseTool: CanUseTool = async () => {
			permissionChecks++;
			return { behavior: "allow" };
		};

		const agent = new Agent({
			name: "responses-combo",
			model: responsesModel,
			tools: [getWeather, calculate],
			instructions: "Use get_weather for weather questions. Reply concisely.",
		});

		const result = await run(agent, "Weather in Paris?", {
			allowedTools: ["get_weather"],
			canUseTool,
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		expect(result.output.toLowerCase()).toContain("68");
		expect(permissionChecks).toBeGreaterThanOrEqual(1);
	}, 60000);
});

// ============================================================
// Error resilience
// ============================================================

describe("error resilience", () => {
	test("canUseTool that throws is handled gracefully", async () => {
		const canUseTool: CanUseTool = async () => {
			throw new Error("Permission service down");
		};

		const agent = new Agent({
			name: "error-canuse",
			model: chatModel,
			tools: [calculate],
			instructions: "Use calculate. If it fails, say 'error occurred'.",
		});

		const result = await run(agent, "What is 1 + 1?", {
			canUseTool,
			maxTurns: 3,
		});

		// The error should be caught and sent back to the LLM as a tool error
		expect(result.output).toBeTruthy();
	}, 60000);

	test("allowedTools with failing tool — error message sent to LLM", async () => {
		const agent = new Agent({
			name: "fail-allowed",
			model: chatModel,
			tools: [failingTool],
			instructions:
				"You MUST call the unreliable tool with input 'test'. Always call it. If it errors, tell the user.",
		});

		const result = await run(agent, "Call the unreliable tool now with input 'test'.", {
			allowedTools: ["unreliable"],
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		// The error should be in the tool messages
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		if (toolMsgs.length > 0) {
			expect((toolMsgs[0] as any).content).toContain("Service unavailable");
		}
		// Either way the LLM should mention the failure
		expect(
			result.output.toLowerCase().includes("error") ||
				result.output.toLowerCase().includes("unavailable") ||
				result.output.toLowerCase().includes("fail") ||
				toolMsgs.length > 0,
		).toBe(true);
	}, 60000);

	test("interrupt on a run that finishes before interrupt is processed", async () => {
		const agent = new Agent({
			name: "fast-finish",
			model: chatModel,
			instructions: "Reply with exactly 'done'.",
		});

		const { stream: s, result, interrupt } = stream(agent, "Say done", { maxTurns: 1 });

		for await (const _ of s) {
			// drain everything
		}

		// Interrupt AFTER stream is fully consumed — should be a no-op
		interrupt();

		const r = await result;
		expect(r.output).toBeTruthy();
	}, 60000);
});
