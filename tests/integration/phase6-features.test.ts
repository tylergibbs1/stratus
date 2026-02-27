import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { ToolTimeoutError } from "../../src/core/errors";
import type { ToolInputGuardrail } from "../../src/core/guardrails";
import { handoff } from "../../src/core/handoff";
import type { RunHooks } from "../../src/core/hooks";
import { stream, run } from "../../src/core/run";
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
	parameters: z.object({
		city: z.string().describe("The city name"),
	}),
	execute: async (_ctx, { city }) => {
		const data: Record<string, string> = {
			"New York": "72°F, sunny",
			London: "55°F, cloudy",
			Tokyo: "85°F, humid",
		};
		return data[city] ?? `No weather data for ${city}`;
	},
});

const slowTool = tool({
	name: "slow_operation",
	description: "A tool that takes a long time",
	parameters: z.object({}),
	execute: async () => {
		await new Promise((r) => setTimeout(r, 5000));
		return "done";
	},
	timeout: 100,
});

const enabledTool = tool({
	name: "enabled_tool",
	description: "A tool that is always enabled",
	parameters: z.object({ input: z.string() }),
	execute: async (_ctx, { input }) => `processed: ${input}`,
	isEnabled: true,
});

const disabledTool = tool({
	name: "disabled_tool",
	description: "A tool that is always disabled",
	parameters: z.object({ input: z.string() }),
	execute: async (_ctx, { input }) => `processed: ${input}`,
	isEnabled: false,
});

describe("Phase 6 Integration: Chat Completions", { timeout: 60000 }, () => {
	test("tool timeout produces error message and model recovers", { timeout: 60000 }, async () => {
		let timeoutDetected = false;
		const agent = new Agent({
			name: "timeout-test",
			model: chatModel,
			instructions: "Call the slow_operation tool. If it fails, explain what happened.",
			tools: [slowTool],
			modelSettings: {
				toolChoice: { type: "function", function: { name: "slow_operation" } },
			},
		});

		const result = await run(agent, "Do the slow operation now", {
			maxTurns: 3,
			toolErrorFormatter: (toolName, error) => {
				if (error instanceof ToolTimeoutError) {
					timeoutDetected = true;
					expect(error.toolName).toBe("slow_operation");
					expect(error.timeoutMs).toBe(100);
				}
				return `Tool "${toolName}" timed out`;
			},
			resetToolChoice: true,
		});
		expect(timeoutDetected).toBe(true);
		expect(result.output).toBeTruthy();
	});

	test("isEnabled=false excludes tool from API call", { timeout: 60000 }, async () => {
		let capturedToolNames: string[] = [];

		const agent = new Agent({
			name: "enabled-test",
			model: chatModel,
			instructions: "You are a helpful assistant. Answer the user's question.",
			tools: [enabledTool, disabledTool],
		});

		const result = await run(agent, "What is 2+2? Just answer directly.", {
			callModelInputFilter: ({ request }) => {
				capturedToolNames = (request.tools ?? []).map(
					(t: any) => t.function?.name ?? t.name ?? "unknown",
				);
				return request;
			},
		});
		expect(result.output).toBeTruthy();
		// callModelInputFilter sees the tools AFTER isEnabled filtering
		expect(capturedToolNames).toContain("enabled_tool");
		expect(capturedToolNames).not.toContain("disabled_tool");
	});

	test("RunHooks fire correctly", { timeout: 60000 }, async () => {
		const events: string[] = [];
		const hooks: RunHooks = {
			onAgentStart: async ({ agent }) => {
				events.push(`agent_start:${agent.name}`);
			},
			onAgentEnd: async ({ agent }) => {
				events.push(`agent_end:${agent.name}`);
			},
			onLlmStart: async ({ agent }) => {
				events.push(`llm_start:${agent.name}`);
			},
			onLlmEnd: async ({ agent }) => {
				events.push(`llm_end:${agent.name}`);
			},
		};

		const agent = new Agent({
			name: "hooks-agent",
			model: chatModel,
			instructions: "Say hello.",
		});

		const result = await run(agent, "Hi", { runHooks: hooks });
		expect(result.output).toBeTruthy();
		expect(events).toContain("agent_start:hooks-agent");
		expect(events).toContain("llm_start:hooks-agent");
		expect(events).toContain("llm_end:hooks-agent");
		expect(events).toContain("agent_end:hooks-agent");
	});

	test("RunHooks with tool calls", { timeout: 60000 }, async () => {
		const events: string[] = [];
		const hooks: RunHooks = {
			onToolStart: async ({ toolName }) => {
				events.push(`tool_start:${toolName}`);
			},
			onToolEnd: async ({ toolName }) => {
				events.push(`tool_end:${toolName}`);
			},
			onLlmStart: async () => {
				events.push("llm_start");
			},
			onLlmEnd: async () => {
				events.push("llm_end");
			},
		};

		const agent = new Agent({
			name: "tool-hooks",
			model: chatModel,
			instructions: "You MUST use the get_weather tool for New York. Always call the tool first.",
			tools: [getWeather],
		});

		const result = await run(agent, "What's the weather in New York?", { runHooks: hooks });
		expect(result.output).toBeTruthy();
		// Must have at least 2 LLM calls (tool call + final answer)
		expect(events.filter((e) => e === "llm_start").length).toBeGreaterThanOrEqual(2);
		expect(events).toContain("tool_start:get_weather");
		expect(events).toContain("tool_end:get_weather");
	});

	test("AgentHooks onLlmStart and onLlmEnd", { timeout: 60000 }, async () => {
		const events: string[] = [];
		const agent = new Agent({
			name: "llm-hooks",
			model: chatModel,
			instructions: "Say hello.",
			hooks: {
				onLlmStart: async () => {
					events.push("llm_start");
				},
				onLlmEnd: async ({ response }) => {
					events.push(`llm_end:${response.toolCallCount}`);
				},
			},
		});

		const result = await run(agent, "Hi");
		expect(result.output).toBeTruthy();
		expect(events).toContain("llm_start");
		expect(events.some((e) => e.startsWith("llm_end:"))).toBe(true);
	});

	test("guardrail results on RunResult", { timeout: 60000 }, async () => {
		const agent = new Agent({
			name: "guardrail-results",
			model: chatModel,
			instructions: "Say hello.",
			inputGuardrails: [
				{
					name: "test-guard",
					execute: async () => ({ tripwireTriggered: false, outputInfo: "safe" }),
				},
			],
			outputGuardrails: [
				{
					name: "output-guard",
					execute: async () => ({ tripwireTriggered: false, outputInfo: "clean" }),
				},
			],
		});

		const result = await run(agent, "Hello");
		expect(result.inputGuardrailResults.length).toBe(1);
		expect(result.inputGuardrailResults[0]!.guardrailName).toBe("test-guard");
		expect(result.outputGuardrailResults.length).toBe(1);
		expect(result.outputGuardrailResults[0]!.guardrailName).toBe("output-guard");
	});

	test("errorHandlers.maxTurns returns graceful result", { timeout: 60000 }, async () => {
		const loopingTool = tool({
			name: "loop_tool",
			description: "Call this tool every time",
			parameters: z.object({}),
			execute: async () => "keep going",
		});

		const agent = new Agent({
			name: "max-turns",
			model: chatModel,
			instructions:
				"You MUST call the loop_tool tool every single time. Never respond with text, always call the tool.",
			tools: [loopingTool],
			modelSettings: {
				toolChoice: "required",
			},
		});

		const result = await run(agent, "Go", {
			maxTurns: 2,
			errorHandlers: {
				maxTurns: async ({ messages }) => {
					const { RunResult } = await import("../../src/core/result");
					return new RunResult({
						output: "Reached max turns gracefully",
						messages,
						usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
						lastAgent: agent,
					});
				},
			},
		});

		expect(result.output).toBe("Reached max turns gracefully");
	});

	test("toInputList filters system messages", { timeout: 60000 }, async () => {
		const agent = new Agent({
			name: "input-list",
			model: chatModel,
			instructions: "Say hello.",
		});

		const result = await run(agent, "Hi");
		const inputList = result.toInputList();
		expect(inputList.every((m) => m.role !== "system")).toBe(true);
		expect(inputList.length).toBeGreaterThan(0);
	});

	test("new ModelSettings fields work with Chat Completions", { timeout: 60000 }, async () => {
		const agent = new Agent({
			name: "settings-test",
			model: chatModel,
			instructions: "Say hello briefly.",
			modelSettings: {
				temperature: 0.5,
				store: true,
				user: "test-user-123",
			},
		});

		const result = await run(agent, "Hi");
		expect(result.output).toBeTruthy();
	});

	test("streaming with RunHooks", { timeout: 60000 }, async () => {
		const events: string[] = [];
		const hooks: RunHooks = {
			onAgentStart: async () => {
				events.push("agent_start");
			},
			onAgentEnd: async () => {
				events.push("agent_end");
			},
			onLlmStart: async () => {
				events.push("llm_start");
			},
			onLlmEnd: async () => {
				events.push("llm_end");
			},
		};

		const agent = new Agent({
			name: "stream-hooks",
			model: chatModel,
			instructions: "Say hello.",
		});

		const { stream: s, result } = stream(agent, "Hi", { runHooks: hooks });
		const chunks: string[] = [];
		for await (const event of s) {
			if (event.type === "content_delta") chunks.push(event.content);
		}
		const r = await result;
		expect(r.output).toBeTruthy();
		expect(chunks.length).toBeGreaterThan(0);
		expect(events).toContain("agent_start");
		expect(events).toContain("llm_start");
		expect(events).toContain("llm_end");
		expect(events).toContain("agent_end");
	});
});

describe("Phase 6 Integration: Responses API", { timeout: 60000 }, () => {
	test("new ModelSettings fields work with Responses API", { timeout: 60000 }, async () => {
		const agent = new Agent({
			name: "responses-settings",
			model: responsesModel,
			instructions: "Say hello briefly.",
			modelSettings: {
				truncation: "auto",
				user: "test-user-456",
			},
		});

		const result = await run(agent, "Hi");
		expect(result.output).toBeTruthy();
	});

	test("RunHooks fire with Responses API", { timeout: 60000 }, async () => {
		const events: string[] = [];
		const hooks: RunHooks = {
			onAgentStart: async ({ agent }) => {
				events.push(`start:${agent.name}`);
			},
			onAgentEnd: async ({ agent }) => {
				events.push(`end:${agent.name}`);
			},
			onLlmStart: async () => {
				events.push("llm_start");
			},
			onLlmEnd: async () => {
				events.push("llm_end");
			},
		};

		const agent = new Agent({
			name: "responses-hooks",
			model: responsesModel,
			instructions: "Say hello briefly.",
		});

		const result = await run(agent, "Hi", { runHooks: hooks });
		expect(result.output).toBeTruthy();
		expect(events).toContain("start:responses-hooks");
		expect(events).toContain("llm_start");
		expect(events).toContain("llm_end");
		expect(events).toContain("end:responses-hooks");
	});

	test("tool guardrails with real API", { timeout: 60000 }, async () => {
		const blockedTools: string[] = [];
		const toolInputGuardrails: ToolInputGuardrail[] = [
			{
				name: "no-tokyo",
				execute: async ({ toolName, toolArgs }) => {
					if (toolName === "get_weather" && (toolArgs as any).city === "Tokyo") {
						blockedTools.push("get_weather:Tokyo");
						return { tripwireTriggered: true, outputInfo: "Tokyo blocked" };
					}
					return { tripwireTriggered: false };
				},
			},
		];

		const agent = new Agent({
			name: "guardrail-test",
			model: responsesModel,
			instructions:
				"You MUST use the get_weather tool for Tokyo when asked about weather. Always call the tool.",
			tools: [getWeather],
		});

		const result = await run(agent, "What's the weather in Tokyo?", {
			maxTurns: 3,
			toolInputGuardrails,
		});
		expect(result.output).toBeTruthy();
		// Guardrail must have actually intercepted the tool call
		expect(blockedTools).toContain("get_weather:Tokyo");
	});

	test("handoff with inputFilter", { timeout: 60000 }, async () => {
		let filterCalled = false;
		let filteredOutRoles: string[] = [];

		const specialistAgent = new Agent({
			name: "specialist",
			model: responsesModel,
			instructions:
				"You are a math specialist. Answer the user's question briefly with just the number.",
		});

		const mainAgent = new Agent({
			name: "router",
			model: responsesModel,
			instructions:
				"You are a router. You MUST immediately transfer to the specialist agent using the transfer_to_specialist tool. Do not answer yourself.",
			handoffs: [
				handoff({
					agent: specialistAgent,
					inputFilter: ({ history }) => {
						filterCalled = true;
						const filtered = history.filter((m) => m.role === "user" || m.role === "system");
						filteredOutRoles = history
							.filter((m) => m.role !== "user" && m.role !== "system")
							.map((m) => m.role);
						return filtered;
					},
				}),
			],
		});

		const result = await run(mainAgent, "What is 2+2?", { maxTurns: 5 });
		expect(result.output).toBeTruthy();
		// Handoff must have happened
		expect(result.lastAgent.name).toBe("specialist");
		expect(filterCalled).toBe(true);
		// Filter should have removed assistant/tool messages from the router's conversation
		expect(filteredOutRoles.length).toBeGreaterThan(0);
	});

	test("streaming with Responses API and RunHooks", { timeout: 60000 }, async () => {
		const events: string[] = [];
		const agent = new Agent({
			name: "responses-stream",
			model: responsesModel,
			instructions: "Say hello.",
		});

		const { stream: s, result } = stream(agent, "Hi", {
			runHooks: {
				onLlmStart: async () => {
					events.push("llm_start");
				},
				onLlmEnd: async () => {
					events.push("llm_end");
				},
			},
		});

		const chunks: string[] = [];
		for await (const event of s) {
			if (event.type === "content_delta") chunks.push(event.content);
		}
		const r = await result;
		expect(r.output).toBeTruthy();
		expect(chunks.length).toBeGreaterThan(0);
		expect(events).toContain("llm_start");
		expect(events).toContain("llm_end");
	});

	test("callModelInputFilter modifies request", { timeout: 60000 }, async () => {
		let capturedTruncation: string | undefined;

		const agent = new Agent({
			name: "filter-test",
			model: responsesModel,
			instructions: "Say hello.",
			modelSettings: {
				truncation: "disabled",
			},
		});

		const result = await run(agent, "Hi", {
			callModelInputFilter: ({ request }) => {
				capturedTruncation = request.modelSettings?.truncation;
				return {
					...request,
					modelSettings: {
						...request.modelSettings,
						truncation: "auto",
					},
				};
			},
		});

		expect(result.output).toBeTruthy();
		expect(capturedTruncation).toBe("disabled");
	});
});
