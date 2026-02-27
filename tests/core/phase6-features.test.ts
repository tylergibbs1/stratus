import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { fileSearchTool, computerUseTool } from "../../src/core/builtin-tools";
import { ToolTimeoutError } from "../../src/core/errors";
import type { ToolInputGuardrail, ToolOutputGuardrail } from "../../src/core/guardrails";
import { handoff, handoffToDefinition } from "../../src/core/handoff";
import type { RunHooks } from "../../src/core/hooks";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { RunResult } from "../../src/core/result";
import { run, stream } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import type { ModelSettings } from "../../src/core/types";

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

function mockModelCapture(responses: ModelResponse[]): { model: Model; requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	const model: Model = {
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			requests.push(request);
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			requests.push(request);
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			if (response.content) yield { type: "content_delta", content: response.content };
			for (const tc of response.toolCalls) {
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield { type: "tool_call_delta", toolCallId: tc.id, arguments: tc.function.arguments };
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
	return { model, requests };
}

// Helper for simple text response
function textResponse(content: string): ModelResponse {
	return { content, toolCalls: [], finishReason: "stop" };
}

// Helper for tool call response
function toolCallResponse(toolName: string, args: Record<string, unknown>, id = "tc_1"): ModelResponse {
	return {
		content: null,
		toolCalls: [
			{
				id,
				type: "function",
				function: { name: toolName, arguments: JSON.stringify(args) },
			},
		],
		finishReason: "tool_calls",
	};
}

// =====================================================================
// 1. Tool timeout
// =====================================================================
describe("Tool timeout", () => {
	test("ToolTimeoutError is thrown when tool exceeds timeout", async () => {
		const slowTool = tool({
			name: "slow_tool",
			description: "A slow tool",
			parameters: z.object({}),
			timeout: 50,
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return "done";
			},
		});

		const model = mockModel([
			toolCallResponse("slow_tool", {}),
			textResponse("ok"),
		]);

		const agent = new Agent({ name: "test", model, tools: [slowTool] });
		const result = await run(agent, "go");

		// The timeout error gets caught and formatted as tool error message
		expect(result.output).toBe("ok");
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toContain("timed out");
			expect(toolMsg.content).toContain("50ms");
		}
	});

	test("tool completes within timeout", async () => {
		const fastTool = tool({
			name: "fast_tool",
			description: "A fast tool",
			parameters: z.object({}),
			timeout: 500,
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "fast result";
			},
		});

		const model = mockModel([
			toolCallResponse("fast_tool", {}),
			textResponse("done"),
		]);

		const agent = new Agent({ name: "test", model, tools: [fastTool] });
		const result = await run(agent, "go");
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toBe("fast result");
		}
	});
});

// =====================================================================
// 2. Tool isEnabled
// =====================================================================
describe("Tool isEnabled", () => {
	test("isEnabled=false excludes tool from tool definitions sent to model", async () => {
		const enabledTool = tool({
			name: "enabled_tool",
			description: "Enabled",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const disabledTool = tool({
			name: "disabled_tool",
			description: "Disabled",
			parameters: z.object({}),
			isEnabled: false,
			execute: async () => "nope",
		});

		const { model, requests } = mockModelCapture([textResponse("hello")]);
		const agent = new Agent({ name: "test", model, tools: [enabledTool, disabledTool] });
		await run(agent, "go");

		const toolDefs = requests[0]!.tools;
		expect(toolDefs).toBeDefined();
		const names = toolDefs!.map((t) => ("function" in t ? (t as any).function.name : t.type));
		expect(names).toContain("enabled_tool");
		expect(names).not.toContain("disabled_tool");
	});

	test("isEnabled as function excludes tool when returning false", async () => {
		const conditionalTool = tool<{}, { featureEnabled: boolean }>({
			name: "conditional_tool",
			description: "Conditional",
			parameters: z.object({}),
			isEnabled: (ctx) => ctx.featureEnabled,
			execute: async () => "ok",
		});

		const { model, requests } = mockModelCapture([textResponse("hello")]);
		const agent = new Agent<{ featureEnabled: boolean }>({
			name: "test",
			model,
			tools: [conditionalTool],
		});

		await run(agent, "go", { context: { featureEnabled: false } });
		// When context says disabled, no tools should be sent
		expect(requests[0]!.tools).toBeUndefined();
	});

	test("isEnabled function includes tool when returning true", async () => {
		const conditionalTool = tool<{}, { featureEnabled: boolean }>({
			name: "conditional_tool",
			description: "Conditional",
			parameters: z.object({}),
			isEnabled: (ctx) => ctx.featureEnabled,
			execute: async () => "ok",
		});

		const { model, requests } = mockModelCapture([textResponse("hello")]);
		const agent = new Agent<{ featureEnabled: boolean }>({
			name: "test",
			model,
			tools: [conditionalTool],
		});

		await run(agent, "go", { context: { featureEnabled: true } });
		const toolDefs = requests[0]!.tools;
		expect(toolDefs).toBeDefined();
		expect(toolDefs!.length).toBe(1);
	});
});

// =====================================================================
// 3. Handoff isEnabled
// =====================================================================
describe("Handoff isEnabled", () => {
	test("isEnabled=false excludes handoff from tool definitions", async () => {
		const targetAgent = new Agent({ name: "target" });
		const h = handoff({ agent: targetAgent, isEnabled: false });

		const { model, requests } = mockModelCapture([textResponse("hello")]);
		const agent = new Agent({ name: "test", model, handoffs: [h] });
		await run(agent, "go");

		// No tools should be sent because the only handoff is disabled
		expect(requests[0]!.tools).toBeUndefined();
	});

	test("isEnabled as function excludes handoff dynamically", async () => {
		const targetAgent = new Agent({ name: "target" });
		const h = handoff<{ allowHandoff: boolean }>({
			agent: targetAgent,
			isEnabled: (ctx) => ctx.allowHandoff,
		});

		const { model, requests } = mockModelCapture([textResponse("hello")]);
		const agent = new Agent<{ allowHandoff: boolean }>({
			name: "test",
			model,
			handoffs: [h],
		});

		await run(agent, "go", { context: { allowHandoff: false } });
		expect(requests[0]!.tools).toBeUndefined();
	});
});

// =====================================================================
// 4. Handoff inputType
// =====================================================================
describe("Handoff inputType", () => {
	test("generates tool definition with parameters from Zod schema", () => {
		const targetAgent = new Agent({ name: "specialist" });
		const h = handoff({
			agent: targetAgent,
			inputType: z.object({
				reason: z.string(),
				priority: z.number(),
			}),
		});

		const def = handoffToDefinition(h);
		expect(def.function.name).toBe("transfer_to_specialist");
		expect(def.function.parameters).toBeDefined();
		const params = def.function.parameters as Record<string, unknown>;
		expect(params.type).toBe("object");
		expect(params.properties).toBeDefined();
		const props = params.properties as Record<string, unknown>;
		expect(props.reason).toBeDefined();
		expect(props.priority).toBeDefined();
	});

	test("handoff without inputType has empty parameters", () => {
		const targetAgent = new Agent({ name: "basic" });
		const h = handoff(targetAgent);
		const def = handoffToDefinition(h);
		expect(def.function.parameters).toEqual({ type: "object", properties: {} });
	});
});

// =====================================================================
// 5. Handoff inputFilter
// =====================================================================
describe("Handoff inputFilter", () => {
	test("transforms messages on handoff", async () => {
		const targetAgent = new Agent({ name: "target" });
		const h = handoff({
			agent: targetAgent,
			inputFilter: ({ history }) => {
				// Only keep user messages
				return history.filter((m) => m.role === "user");
			},
		});

		const model = mockModel([
			// First agent calls transfer_to_target
			toolCallResponse("transfer_to_target", {}),
			// Target agent responds
			textResponse("filtered response"),
		]);

		const agent = new Agent({
			name: "main",
			model,
			instructions: "You are the main agent",
			handoffs: [h],
		});

		const result = await run(agent, "hello");
		expect(result.output).toBe("filtered response");
		expect(result.lastAgent.name).toBe("target");
		// After filtering, system messages should have been removed by the filter,
		// then a new system prompt may be added by the target agent
		const userMsgs = result.messages.filter((m) => m.role === "user");
		expect(userMsgs.length).toBeGreaterThanOrEqual(1);
	});
});

// =====================================================================
// 6. RunHooks
// =====================================================================
describe("RunHooks", () => {
	test("onAgentStart and onAgentEnd fire", async () => {
		const events: string[] = [];
		const runHooks: RunHooks = {
			onAgentStart: ({ agent }) => {
				events.push(`start:${agent.name}`);
			},
			onAgentEnd: ({ agent, output }) => {
				events.push(`end:${agent.name}:${output}`);
			},
		};

		const model = mockModel([textResponse("hello world")]);
		const agent = new Agent({ name: "alpha", model });
		await run(agent, "go", { runHooks });

		expect(events).toEqual(["start:alpha", "end:alpha:hello world"]);
	});

	test("onHandoff fires on handoff", async () => {
		const events: string[] = [];
		const runHooks: RunHooks = {
			onAgentStart: ({ agent }) => events.push(`start:${agent.name}`),
			onAgentEnd: ({ agent }) => events.push(`end:${agent.name}`),
			onHandoff: ({ fromAgent, toAgent }) => {
				events.push(`handoff:${fromAgent.name}->${toAgent.name}`);
			},
		};

		const targetAgent = new Agent({ name: "beta" });
		const model = mockModel([
			toolCallResponse("transfer_to_beta", {}),
			textResponse("from beta"),
		]);

		const agent = new Agent({
			name: "alpha",
			model,
			handoffs: [handoff(targetAgent)],
		});

		await run(agent, "go", { runHooks });

		expect(events).toContain("start:alpha");
		expect(events).toContain("end:alpha");
		expect(events).toContain("handoff:alpha->beta");
		expect(events).toContain("start:beta");
		expect(events).toContain("end:beta");
	});

	test("onToolStart and onToolEnd fire on tool execution", async () => {
		const events: string[] = [];
		const runHooks: RunHooks = {
			onToolStart: ({ toolName }) => events.push(`tool_start:${toolName}`),
			onToolEnd: ({ toolName, result }) => events.push(`tool_end:${toolName}:${result}`),
		};

		const myTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => `Hello, ${params.name}!`,
		});

		const model = mockModel([
			toolCallResponse("greet", { name: "World" }),
			textResponse("done"),
		]);

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		await run(agent, "go", { runHooks });

		expect(events).toEqual(["tool_start:greet", "tool_end:greet:Hello, World!"]);
	});

	test("onLlmStart and onLlmEnd fire on LLM calls via RunHooks", async () => {
		const events: string[] = [];
		const runHooks: RunHooks = {
			onLlmStart: ({ agent }) => events.push(`llm_start:${agent.name}`),
			onLlmEnd: ({ response }) => events.push(`llm_end:${response.content}`),
		};

		const model = mockModel([textResponse("result")]);
		const agent = new Agent({ name: "test", model });
		await run(agent, "go", { runHooks });

		expect(events).toEqual(["llm_start:test", "llm_end:result"]);
	});
});

// =====================================================================
// 7. AgentHooks onLlmStart/onLlmEnd
// =====================================================================
describe("AgentHooks onLlmStart/onLlmEnd", () => {
	test("fires before and after each LLM call", async () => {
		const events: string[] = [];

		const myTool = tool({
			name: "calc",
			description: "Calculate",
			parameters: z.object({}),
			execute: async () => "42",
		});

		const model = mockModel([
			toolCallResponse("calc", {}),
			textResponse("answer is 42"),
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [myTool],
			hooks: {
				onLlmStart: ({ messages }) => {
					events.push(`llm_start:${messages.length}`);
				},
				onLlmEnd: ({ response }) => {
					events.push(`llm_end:tc=${response.toolCallCount}`);
				},
			},
		});

		await run(agent, "go");

		// Two LLM calls: first has 1 message (user only, no instructions),
		// second has 3 messages (user + assistant w/ tool_call + tool result)
		expect(events).toEqual([
			"llm_start:1",
			"llm_end:tc=1",
			"llm_start:3",
			"llm_end:tc=0",
		]);
	});
});

// =====================================================================
// 8. Tool guardrails
// =====================================================================
describe("Tool guardrails", () => {
	test("ToolInputGuardrail blocks tool execution", async () => {
		const dangerousGuardrail: ToolInputGuardrail = {
			name: "block_dangerous",
			execute: ({ toolName }) => ({
				tripwireTriggered: toolName === "dangerous_tool",
			}),
		};

		const dangerousTool = tool({
			name: "dangerous_tool",
			description: "Dangerous",
			parameters: z.object({}),
			execute: async () => "should not run",
		});

		const model = mockModel([
			toolCallResponse("dangerous_tool", {}),
			textResponse("blocked"),
		]);

		const agent = new Agent({ name: "test", model, tools: [dangerousTool] });
		const result = await run(agent, "go", {
			toolInputGuardrails: [dangerousGuardrail],
		});

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toContain("block_dangerous");
			expect(toolMsg.content).toContain("blocked execution");
		}
	});

	test("ToolOutputGuardrail replaces tool output", async () => {
		const piiGuardrail: ToolOutputGuardrail = {
			name: "pii_filter",
			execute: ({ toolResult }) => ({
				tripwireTriggered: toolResult.includes("secret"),
			}),
		};

		const leakyTool = tool({
			name: "leaky_tool",
			description: "Leaky",
			parameters: z.object({}),
			execute: async () => "secret data here",
		});

		const model = mockModel([
			toolCallResponse("leaky_tool", {}),
			textResponse("done"),
		]);

		const agent = new Agent({ name: "test", model, tools: [leakyTool] });
		const result = await run(agent, "go", {
			toolOutputGuardrails: [piiGuardrail],
		});

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toContain("pii_filter");
			expect(toolMsg.content).toContain("flagged");
			expect(toolMsg.content).not.toContain("secret data here");
		}
	});

	test("ToolInputGuardrail allows tool when not triggered", async () => {
		const safeGuardrail: ToolInputGuardrail = {
			name: "safe_check",
			execute: () => ({ tripwireTriggered: false }),
		};

		const safeTool = tool({
			name: "safe_tool",
			description: "Safe",
			parameters: z.object({}),
			execute: async () => "safe result",
		});

		const model = mockModel([
			toolCallResponse("safe_tool", {}),
			textResponse("done"),
		]);

		const agent = new Agent({ name: "test", model, tools: [safeTool] });
		const result = await run(agent, "go", {
			toolInputGuardrails: [safeGuardrail],
		});

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toBe("safe result");
		}
	});
});

// =====================================================================
// 9. Guardrail results on RunResult
// =====================================================================
describe("Guardrail results on RunResult", () => {
	test("inputGuardrailResults populated on RunResult", async () => {
		const model = mockModel([textResponse("ok")]);
		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [
				{
					name: "input_check",
					execute: () => ({ tripwireTriggered: false, outputInfo: "all good" }),
				},
			],
		});

		const result = await run(agent, "hello");
		expect(result.inputGuardrailResults.length).toBe(1);
		expect(result.inputGuardrailResults[0]!.guardrailName).toBe("input_check");
		expect(result.inputGuardrailResults[0]!.result.tripwireTriggered).toBe(false);
		expect(result.inputGuardrailResults[0]!.result.outputInfo).toBe("all good");
	});

	test("outputGuardrailResults populated on RunResult", async () => {
		const model = mockModel([textResponse("output text")]);
		const agent = new Agent({
			name: "test",
			model,
			outputGuardrails: [
				{
					name: "output_check",
					execute: () => ({ tripwireTriggered: false, outputInfo: { safe: true } }),
				},
			],
		});

		const result = await run(agent, "hello");
		expect(result.outputGuardrailResults.length).toBe(1);
		expect(result.outputGuardrailResults[0]!.guardrailName).toBe("output_check");
		expect(result.outputGuardrailResults[0]!.result.outputInfo).toEqual({ safe: true });
	});
});

// =====================================================================
// 10. Error handlers
// =====================================================================
describe("Error handlers", () => {
	test("errorHandlers.maxTurns returns graceful result instead of throwing", async () => {
		const model = mockModel([
			toolCallResponse("loop_tool", {}),
			toolCallResponse("loop_tool", {}),
			toolCallResponse("loop_tool", {}),
		]);

		const loopTool = tool({
			name: "loop_tool",
			description: "Loop",
			parameters: z.object({}),
			execute: async () => "looping",
		});

		const agent = new Agent({ name: "test", model, tools: [loopTool] });
		const result = await run(agent, "go", {
			maxTurns: 2,
			errorHandlers: {
				maxTurns: ({ maxTurns, messages }) => {
					return new RunResult({
						output: `Stopped after ${maxTurns} turns`,
						messages,
						usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
						lastAgent: agent,
					});
				},
			},
		});

		expect(result.output).toBe("Stopped after 2 turns");
	});
});

// =====================================================================
// 11. Custom toolUseBehavior function
// =====================================================================
describe("Custom toolUseBehavior function", () => {
	test("function variant decides whether to stop after tool calls", async () => {
		const myTool = tool({
			name: "final_answer",
			description: "Final answer",
			parameters: z.object({ answer: z.string() }),
			execute: async (_ctx, params) => params.answer,
		});

		const model = mockModel([
			toolCallResponse("final_answer", { answer: "42" }),
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [myTool],
			toolUseBehavior: (results) => {
				// Stop if any tool result is "42"
				return results.some((r) => r.result === "42");
			},
		});

		const result = await run(agent, "answer");
		expect(result.output).toBe("42");
	});

	test("function variant returns false to continue LLM loop", async () => {
		const myTool = tool({
			name: "intermediate",
			description: "Intermediate step",
			parameters: z.object({}),
			execute: async () => "step done",
		});

		const model = mockModel([
			toolCallResponse("intermediate", {}),
			textResponse("final answer"),
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [myTool],
			toolUseBehavior: () => false, // never stop on tools
		});

		const result = await run(agent, "go");
		expect(result.output).toBe("final answer");
	});
});

// =====================================================================
// 12. resetToolChoice
// =====================================================================
describe("resetToolChoice", () => {
	test("after first turn, tool_choice resets to 'auto'", async () => {
		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({}),
			execute: async () => "result",
		});

		const { model, requests } = mockModelCapture([
			toolCallResponse("my_tool", {}),
			textResponse("done"),
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [myTool],
			modelSettings: { toolChoice: "required" },
		});

		await run(agent, "go", { resetToolChoice: true });

		// First request should have toolChoice as "required"
		expect(requests[0]!.modelSettings?.toolChoice).toBe("required");
		// Second request should reset to "auto"
		expect(requests[1]!.modelSettings?.toolChoice).toBe("auto");
	});

	test("without resetToolChoice, tool_choice persists", async () => {
		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({}),
			execute: async () => "result",
		});

		const { model, requests } = mockModelCapture([
			toolCallResponse("my_tool", {}),
			textResponse("done"),
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [myTool],
			modelSettings: { toolChoice: "required" },
		});

		await run(agent, "go");

		expect(requests[0]!.modelSettings?.toolChoice).toBe("required");
		expect(requests[1]!.modelSettings?.toolChoice).toBe("required");
	});
});

// =====================================================================
// 13. toolErrorFormatter
// =====================================================================
describe("toolErrorFormatter", () => {
	test("custom error messages for failed tools", async () => {
		const failTool = tool({
			name: "fail_tool",
			description: "Fails",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("something broke");
			},
		});

		const model = mockModel([
			toolCallResponse("fail_tool", {}),
			textResponse("handled"),
		]);

		const agent = new Agent({ name: "test", model, tools: [failTool] });
		const result = await run(agent, "go", {
			toolErrorFormatter: (toolName, error) =>
				`CUSTOM ERROR in ${toolName}: ${(error as Error).message}`,
		});

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toBe("CUSTOM ERROR in fail_tool: something broke");
		}
	});

	test("default error formatter when no custom formatter is provided", async () => {
		const failTool = tool({
			name: "fail_tool",
			description: "Fails",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("default break");
			},
		});

		const model = mockModel([
			toolCallResponse("fail_tool", {}),
			textResponse("handled"),
		]);

		const agent = new Agent({ name: "test", model, tools: [failTool] });
		const result = await run(agent, "go");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toContain('Error executing tool "fail_tool"');
			expect(toolMsg.content).toContain("default break");
		}
	});
});

// =====================================================================
// 14. callModelInputFilter
// =====================================================================
describe("callModelInputFilter", () => {
	test("transforms request before sending to model", async () => {
		const { model, requests } = mockModelCapture([textResponse("done")]);

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: { temperature: 0.5 },
		});

		await run(agent, "go", {
			callModelInputFilter: ({ request }) => ({
				...request,
				modelSettings: {
					...request.modelSettings,
					temperature: 0.0,
				},
			}),
		});

		expect(requests[0]!.modelSettings?.temperature).toBe(0.0);
	});

	test("can strip messages in callModelInputFilter", async () => {
		const { model, requests } = mockModelCapture([textResponse("done")]);

		const agent = new Agent({
			name: "test",
			model,
			instructions: "You are helpful",
		});

		await run(agent, "go", {
			callModelInputFilter: ({ request }) => ({
				...request,
				messages: request.messages.filter((m) => m.role !== "system"),
			}),
		});

		// System message should have been removed by the filter
		const systemMsgs = requests[0]!.messages.filter((m) => m.role === "system");
		expect(systemMsgs.length).toBe(0);
	});
});

// =====================================================================
// 15. toInputList() on RunResult
// =====================================================================
describe("toInputList() on RunResult", () => {
	test("filters system messages from result messages", async () => {
		const model = mockModel([textResponse("output")]);
		const agent = new Agent({
			name: "test",
			model,
			instructions: "Be helpful",
		});

		const result = await run(agent, "hello");
		const inputList = result.toInputList();

		// Should not contain system messages
		const systemMsgs = inputList.filter((m) => m.role === "system");
		expect(systemMsgs.length).toBe(0);

		// Should contain user and assistant messages
		const userMsgs = inputList.filter((m) => m.role === "user");
		expect(userMsgs.length).toBe(1);
		const assistantMsgs = inputList.filter((m) => m.role === "assistant");
		expect(assistantMsgs.length).toBe(1);
	});

	test("preserves tool messages in toInputList", async () => {
		const myTool = tool({
			name: "calc",
			description: "Calculate",
			parameters: z.object({}),
			execute: async () => "42",
		});

		const model = mockModel([
			toolCallResponse("calc", {}),
			textResponse("done"),
		]);

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const result = await run(agent, "go");
		const inputList = result.toInputList();

		const toolMsgs = inputList.filter((m) => m.role === "tool");
		expect(toolMsgs.length).toBe(1);
	});
});

// =====================================================================
// 16. fileSearchTool()
// =====================================================================
describe("fileSearchTool()", () => {
	test("creates proper HostedTool definition", () => {
		const t = fileSearchTool({ vectorStoreIds: ["vs_abc123"] });
		expect(t.type).toBe("hosted");
		expect(t.name).toBe("file_search");
		expect(t.definition).toEqual({
			type: "file_search",
			vector_store_ids: ["vs_abc123"],
		});
	});

	test("accepts maxNumResults", () => {
		const t = fileSearchTool({ vectorStoreIds: ["vs_1", "vs_2"], maxNumResults: 5 });
		expect(t.definition).toEqual({
			type: "file_search",
			vector_store_ids: ["vs_1", "vs_2"],
			max_num_results: 5,
		});
	});

	test("supports multiple vector store IDs", () => {
		const t = fileSearchTool({ vectorStoreIds: ["vs_a", "vs_b", "vs_c"] });
		expect(t.definition.vector_store_ids).toEqual(["vs_a", "vs_b", "vs_c"]);
	});
});

// =====================================================================
// 17. computerUseTool()
// =====================================================================
describe("computerUseTool()", () => {
	test("creates proper HostedTool definition with defaults", () => {
		const t = computerUseTool({ displayWidth: 1920, displayHeight: 1080 });
		expect(t.type).toBe("hosted");
		expect(t.name).toBe("computer_use_preview");
		expect(t.definition).toEqual({
			type: "computer_use_preview",
			display_width: 1920,
			display_height: 1080,
			environment: "linux",
		});
	});

	test("accepts custom environment", () => {
		const t = computerUseTool({
			displayWidth: 2560,
			displayHeight: 1440,
			environment: "mac",
		});
		expect(t.definition).toEqual({
			type: "computer_use_preview",
			display_width: 2560,
			display_height: 1440,
			environment: "mac",
		});
	});

	test("accepts windows environment", () => {
		const t = computerUseTool({
			displayWidth: 1024,
			displayHeight: 768,
			environment: "windows",
		});
		expect(t.definition.environment).toBe("windows");
	});
});

// =====================================================================
// 18. ToolTimeoutError
// =====================================================================
describe("ToolTimeoutError", () => {
	test("has correct properties", () => {
		const err = new ToolTimeoutError("my_tool", 5000);
		expect(err.toolName).toBe("my_tool");
		expect(err.timeoutMs).toBe(5000);
		expect(err.name).toBe("ToolTimeoutError");
		expect(err.message).toContain("my_tool");
		expect(err.message).toContain("5000ms");
	});

	test("is an instance of Error", () => {
		const err = new ToolTimeoutError("test", 100);
		expect(err instanceof Error).toBe(true);
	});

	test("has descriptive message format", () => {
		const err = new ToolTimeoutError("slow_api", 3000);
		expect(err.message).toBe('Tool "slow_api" timed out after 3000ms');
	});
});

// =====================================================================
// 19. ModelSettings new fields
// =====================================================================
describe("ModelSettings new fields", () => {
	test("truncation, store, metadata, user, logprobs, topLogprobs, reasoningSummary are type-valid", () => {
		const settings: ModelSettings = {
			truncation: "auto",
			store: true,
			metadata: { session_id: "abc123", user_type: "premium" },
			user: "user_42",
			logprobs: true,
			topLogprobs: 5,
			reasoningSummary: "concise",
		};

		expect(settings.truncation).toBe("auto");
		expect(settings.store).toBe(true);
		expect(settings.metadata).toEqual({ session_id: "abc123", user_type: "premium" });
		expect(settings.user).toBe("user_42");
		expect(settings.logprobs).toBe(true);
		expect(settings.topLogprobs).toBe(5);
		expect(settings.reasoningSummary).toBe("concise");
	});

	test("truncation disabled value", () => {
		const settings: ModelSettings = { truncation: "disabled" };
		expect(settings.truncation).toBe("disabled");
	});

	test("reasoningSummary values", () => {
		const auto: ModelSettings = { reasoningSummary: "auto" };
		const detailed: ModelSettings = { reasoningSummary: "detailed" };
		expect(auto.reasoningSummary).toBe("auto");
		expect(detailed.reasoningSummary).toBe("detailed");
	});

	test("agent passes modelSettings through to requests", async () => {
		const { model, requests } = mockModelCapture([textResponse("ok")]);

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: {
				truncation: "auto",
				store: true,
				metadata: { key: "val" },
				user: "u123",
				logprobs: true,
				topLogprobs: 3,
				reasoningSummary: "detailed",
			},
		});

		await run(agent, "go");

		const sentSettings = requests[0]!.modelSettings;
		expect(sentSettings).toBeDefined();
		expect(sentSettings!.truncation).toBe("auto");
		expect(sentSettings!.store).toBe(true);
		expect(sentSettings!.metadata).toEqual({ key: "val" });
		expect(sentSettings!.user).toBe("u123");
		expect(sentSettings!.logprobs).toBe(true);
		expect(sentSettings!.topLogprobs).toBe(3);
		expect(sentSettings!.reasoningSummary).toBe("detailed");
	});
});

// =====================================================================
// 20. Streaming with new features
// =====================================================================
describe("Streaming with new features", () => {
	test("stream() supports RunHooks onAgentStart/onAgentEnd", async () => {
		const events: string[] = [];
		const runHooks: RunHooks = {
			onAgentStart: ({ agent }) => events.push(`start:${agent.name}`),
			onAgentEnd: ({ agent }) => events.push(`end:${agent.name}`),
		};

		const model = mockModel([textResponse("streamed result")]);
		const agent = new Agent({ name: "streamer", model });
		const { stream: s, result } = stream(agent, "go", { runHooks });

		// Consume the stream
		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.output).toBe("streamed result");
		expect(events).toEqual(["start:streamer", "end:streamer"]);
	});

	test("stream() supports onLlmStart/onLlmEnd via RunHooks", async () => {
		const events: string[] = [];
		const runHooks: RunHooks = {
			onLlmStart: ({ agent }) => events.push(`llm_start:${agent.name}`),
			onLlmEnd: ({ response }) => events.push(`llm_end:${response.content}`),
		};

		const model = mockModel([textResponse("done")]);
		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "go", { runHooks });

		for await (const _event of s) {
			// drain
		}

		await result;
		expect(events).toEqual(["llm_start:test", "llm_end:done"]);
	});

	test("stream() supports tool timeout", async () => {
		const slowTool = tool({
			name: "slow_stream_tool",
			description: "Slow",
			parameters: z.object({}),
			timeout: 50,
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return "should not appear";
			},
		});

		const model = mockModel([
			toolCallResponse("slow_stream_tool", {}),
			textResponse("recovered"),
		]);

		const agent = new Agent({ name: "test", model, tools: [slowTool] });
		const { stream: s, result } = stream(agent, "go");

		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.output).toBe("recovered");
		const toolMsg = r.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toContain("timed out");
		}
	});

	test("stream() supports resetToolChoice", async () => {
		const myTool = tool({
			name: "my_tool",
			description: "Tool",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const { model, requests } = mockModelCapture([
			toolCallResponse("my_tool", {}),
			textResponse("done"),
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [myTool],
			modelSettings: { toolChoice: "required" },
		});

		const { stream: s, result } = stream(agent, "go", { resetToolChoice: true });
		for await (const _event of s) {}
		await result;

		expect(requests[0]!.modelSettings?.toolChoice).toBe("required");
		expect(requests[1]!.modelSettings?.toolChoice).toBe("auto");
	});

	test("stream() supports errorHandlers.maxTurns", async () => {
		const myTool = tool({
			name: "loop",
			description: "Loop",
			parameters: z.object({}),
			execute: async () => "looping",
		});

		const model = mockModel([
			toolCallResponse("loop", {}),
			toolCallResponse("loop", {}),
			toolCallResponse("loop", {}),
		]);

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const { stream: s, result } = stream(agent, "go", {
			maxTurns: 2,
			errorHandlers: {
				maxTurns: ({ maxTurns }) =>
					new RunResult({
						output: `Gracefully stopped at ${maxTurns}`,
						messages: [],
						usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
						lastAgent: agent,
					}),
			},
		});

		for await (const _event of s) {}
		const r = await result;
		expect(r.output).toBe("Gracefully stopped at 2");
	});

	test("stream() supports callModelInputFilter", async () => {
		const { model, requests } = mockModelCapture([textResponse("filtered")]);

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: { temperature: 0.9 },
		});

		const { stream: s, result } = stream(agent, "go", {
			callModelInputFilter: ({ request }) => ({
				...request,
				modelSettings: { ...request.modelSettings, temperature: 0.1 },
			}),
		});

		for await (const _event of s) {}
		await result;

		expect(requests[0]!.modelSettings?.temperature).toBe(0.1);
	});

	test("stream() supports toolErrorFormatter", async () => {
		const failTool = tool({
			name: "fail",
			description: "Fails",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("oops");
			},
		});

		const model = mockModel([
			toolCallResponse("fail", {}),
			textResponse("ok"),
		]);

		const agent = new Agent({ name: "test", model, tools: [failTool] });
		const { stream: s, result } = stream(agent, "go", {
			toolErrorFormatter: (name, err) => `STREAM_ERR:${name}:${(err as Error).message}`,
		});

		for await (const _event of s) {}
		const r = await result;
		const toolMsg = r.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toBe("STREAM_ERR:fail:oops");
		}
	});

	test("stream() supports AgentHooks onLlmStart/onLlmEnd", async () => {
		const events: string[] = [];

		const model = mockModel([textResponse("done")]);
		const agent = new Agent({
			name: "test",
			model,
			hooks: {
				onLlmStart: () => events.push("agent_llm_start"),
				onLlmEnd: ({ response }) => events.push(`agent_llm_end:${response.content}`),
			},
		});

		const { stream: s, result } = stream(agent, "go");
		for await (const _event of s) {}
		await result;

		expect(events).toEqual(["agent_llm_start", "agent_llm_end:done"]);
	});
});
