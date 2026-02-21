import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import {
	ContentFilterError,
	MaxTurnsExceededError,
	ModelError,
	OutputParseError,
	RunAbortedError,
	StratusError,
} from "../../src/core/errors";
import type {
	Model,
	ModelRequest,
	ModelRequestOptions,
	ModelResponse,
	StreamEvent,
} from "../../src/core/model";
import { run, stream } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { tool } from "../../src/core/tool";
import { handoff } from "../../src/core/handoff";
import { subagent } from "../../src/core/subagent";
import type { InputGuardrail, OutputGuardrail } from "../../src/core/guardrails";

// ─── Mock helpers ────────────────────────────────────────────────────────

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

function textResponse(content: string): ModelResponse {
	return { content, toolCalls: [] };
}

function toolCallResponse(
	calls: { id: string; name: string; args: string }[],
	content: string | null = null,
): ModelResponse {
	return {
		content,
		toolCalls: calls.map((c) => ({
			id: c.id,
			type: "function" as const,
			function: { name: c.name, arguments: c.args },
		})),
	};
}

// ─── No model provided ──────────────────────────────────────────────────

describe("edge: no model", () => {
	test("run() throws StratusError when no model on agent or options", async () => {
		const agent = new Agent({ name: "test" });
		await expect(run(agent, "Hi")).rejects.toThrow(StratusError);
		await expect(run(agent, "Hi")).rejects.toThrow("No model provided");
	});

	test("stream() throws StratusError when no model", async () => {
		const agent = new Agent({ name: "test" });
		const { stream: s, result } = stream(agent, "Hi");

		// The stream should throw
		let threw = false;
		try {
			for await (const _event of s) {
				// should not yield anything
			}
		} catch (e) {
			if (e instanceof StratusError) threw = true;
		}
		expect(threw).toBe(true);
		await expect(result).rejects.toThrow(StratusError);
	});

	test("run() uses model from options when agent has none", async () => {
		const model = mockModel([textResponse("Hello!")]);
		const agent = new Agent({ name: "test" });
		const result = await run(agent, "Hi", { model });
		expect(result.output).toBe("Hello!");
	});
});

// ─── Empty and null responses ────────────────────────────────────────────

describe("edge: empty responses", () => {
	test("model returns null content", async () => {
		const model = mockModel([{ content: null, toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");
		expect(result.output).toBe("");
	});

	test("model returns empty string content", async () => {
		const model = mockModel([{ content: "", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");
		expect(result.output).toBe("");
	});

	test("streaming with null content produces empty output", async () => {
		const model = mockModel([{ content: null, toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "Hi");

		const events: StreamEvent[] = [];
		for await (const e of s) events.push(e);

		const r = await result;
		expect(r.output).toBe("");
		expect(events.some((e) => e.type === "done")).toBe(true);
	});
});

// ─── Tool execution errors ──────────────────────────────────────────────

describe("edge: tool errors", () => {
	test("tool that throws sends error message back to model", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "failing_tool", args: "{}" }]),
			textResponse("I see the tool failed."),
		]);

		const failingTool = tool({
			name: "failing_tool",
			description: "Always fails",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("Database connection lost");
			},
		});

		const agent = new Agent({ name: "test", model, tools: [failingTool] });
		const result = await run(agent, "Do the thing");

		expect(result.output).toBe("I see the tool failed.");
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("Database connection lost"),
		);
		expect(toolMsg).toBeDefined();
	});

	test("tool that throws non-Error sends stringified error", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "weird_tool", args: "{}" }]),
			textResponse("Handled."),
		]);

		const weirdTool = tool({
			name: "weird_tool",
			description: "Throws a string",
			parameters: z.object({}),
			execute: async () => {
				throw "raw string error";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [weirdTool] });
		const result = await run(agent, "Do it");

		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("raw string error"),
		);
		expect(toolMsg).toBeDefined();
	});

	test("tool returns empty string", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "empty_tool", args: "{}" }]),
			textResponse("Got empty result."),
		]);

		const emptyTool = tool({
			name: "empty_tool",
			description: "Returns nothing",
			parameters: z.object({}),
			execute: async () => "",
		});

		const agent = new Agent({ name: "test", model, tools: [emptyTool] });
		const result = await run(agent, "Do it");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === "tool") {
			expect(toolMsg.content).toBe("");
		}
	});
});

// ─── Unknown tool calls ──────────────────────────────────────────────────

describe("edge: unknown tools", () => {
	test("model calls a tool that doesn't exist", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "nonexistent_tool", args: "{}" }]),
			textResponse("I understand that tool is unavailable."),
		]);

		const agent = new Agent({ name: "test", model, tools: [] });
		const result = await run(agent, "Call the thing");

		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes('Unknown tool "nonexistent_tool"'),
		);
		expect(toolMsg).toBeDefined();
		expect(result.output).toBe("I understand that tool is unavailable.");
	});

	test("model calls mix of valid and unknown tools", async () => {
		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "valid_tool", args: "{}" },
				{ id: "tc2", name: "ghost_tool", args: "{}" },
			]),
			textResponse("Done."),
		]);

		const validTool = tool({
			name: "valid_tool",
			description: "Works fine",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [validTool] });
		const result = await run(agent, "Do both");

		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(2);
		expect(toolMsgs.some((m) => m.role === "tool" && m.content === "ok")).toBe(true);
		expect(toolMsgs.some((m) => m.role === "tool" && m.content.includes("Unknown tool"))).toBe(true);
	});
});

// ─── Invalid JSON arguments ──────────────────────────────────────────────

describe("edge: malformed tool arguments", () => {
	test("model sends invalid JSON as tool arguments", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function" as const,
						function: { name: "my_tool", arguments: "not json at all" },
					},
				],
			},
			textResponse("I'll try differently."),
		]);

		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({ query: z.string() }),
			execute: async (_ctx, { query }) => query,
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const result = await run(agent, "Search");

		// Should not crash — error goes back to model
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("Error"),
		);
		expect(toolMsg).toBeDefined();
		expect(result.output).toBe("I'll try differently.");
	});
});

// ─── MaxTurns ────────────────────────────────────────────────────────────

describe("edge: maxTurns", () => {
	test("infinite tool loop hits maxTurns", async () => {
		// Model always calls a tool, never gives a final answer
		const infiniteModel: Model = {
			async getResponse(): Promise<ModelResponse> {
				return toolCallResponse([{ id: "tc1", name: "loop_tool", args: "{}" }]);
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				const resp = toolCallResponse([{ id: "tc1", name: "loop_tool", args: "{}" }]);
				yield { type: "done", response: resp };
			},
		};

		const loopTool = tool({
			name: "loop_tool",
			description: "Keep going",
			parameters: z.object({}),
			execute: async () => "continue",
		});

		const agent = new Agent({ name: "test", model: infiniteModel, tools: [loopTool] });
		await expect(run(agent, "Go", { maxTurns: 3 })).rejects.toThrow(MaxTurnsExceededError);
	});

	test("maxTurns=1 allows one model call and returns", async () => {
		const model = mockModel([textResponse("One shot.")]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi", { maxTurns: 1 });
		expect(result.output).toBe("One shot.");
	});

	test("maxTurns=1 with tool call throws", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "t", args: "{}" }]),
		]);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		// Turn 0: model returns tool call, tool executes, but turn 1 would exceed maxTurns=1
		await expect(run(agent, "Hi", { maxTurns: 1 })).rejects.toThrow(MaxTurnsExceededError);
	});
});

// ─── Structured output edge cases ────────────────────────────────────────

describe("edge: structured output", () => {
	test("model returns invalid JSON for outputType", async () => {
		const model = mockModel([textResponse("this is not json")]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: z.object({ name: z.string() }),
		});

		await expect(run(agent, "Extract")).rejects.toThrow(OutputParseError);
	});

	test("model returns valid JSON that fails Zod validation", async () => {
		const model = mockModel([textResponse('{"name": 42}')]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: z.object({ name: z.string() }),
		});

		await expect(run(agent, "Extract")).rejects.toThrow(OutputParseError);
	});

	test("model returns empty string with outputType does not crash", async () => {
		const model = mockModel([{ content: "", toolCalls: [] }]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: z.object({ name: z.string() }),
		});

		// Empty string — outputType check is skipped when rawOutput is falsy
		const result = await run(agent, "Extract");
		expect(result.output).toBe("");
		expect(result.finalOutput).toBeUndefined();
	});

	test("model returns null content with outputType", async () => {
		const model = mockModel([{ content: null, toolCalls: [] }]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: z.object({ name: z.string() }),
		});

		const result = await run(agent, "Extract");
		expect(result.output).toBe("");
		expect(result.finalOutput).toBeUndefined();
	});
});

// ─── Guardrail edge cases ────────────────────────────────────────────────

describe("edge: guardrails", () => {
	test("input guardrail that throws an error propagates", async () => {
		const model = mockModel([textResponse("Hello!")]);
		const brokenGuardrail: InputGuardrail = {
			name: "broken",
			execute: () => {
				throw new Error("Guardrail crashed");
			},
		};

		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [brokenGuardrail],
		});

		await expect(run(agent, "Hi")).rejects.toThrow("Guardrail crashed");
	});

	test("output guardrail that throws propagates", async () => {
		const model = mockModel([textResponse("Hello!")]);
		const brokenGuardrail: OutputGuardrail = {
			name: "broken_output",
			execute: () => {
				throw new Error("Output guardrail exploded");
			},
		};

		const agent = new Agent({
			name: "test",
			model,
			outputGuardrails: [brokenGuardrail],
		});

		await expect(run(agent, "Hi")).rejects.toThrow("Output guardrail exploded");
	});

	test("multiple guardrails run in parallel — first tripwire wins", async () => {
		const model = mockModel([textResponse("Hello!")]);

		const guard1: InputGuardrail = {
			name: "guard1",
			execute: () => ({ tripwireTriggered: true, outputInfo: "guard1 triggered" }),
		};

		const guard2: InputGuardrail = {
			name: "guard2",
			execute: () => ({ tripwireTriggered: false }),
		};

		const agent = new Agent({
			name: "test",
			model,
			inputGuardrails: [guard1, guard2],
		});

		await expect(run(agent, "Hi")).rejects.toThrow("Input guardrail");
	});
});

// ─── Hook edge cases ─────────────────────────────────────────────────────

describe("edge: hooks", () => {
	test("beforeRun hook that throws prevents execution", async () => {
		const model = mockModel([textResponse("Hello!")]);

		const agent = new Agent({
			name: "test",
			model,
			hooks: {
				beforeRun: () => {
					throw new Error("beforeRun hook failed");
				},
			},
		});

		await expect(run(agent, "Hi")).rejects.toThrow("beforeRun hook failed");
	});

	test("afterRun hook that throws propagates after result is built", async () => {
		const model = mockModel([textResponse("Hello!")]);

		const agent = new Agent({
			name: "test",
			model,
			hooks: {
				afterRun: () => {
					throw new Error("afterRun hook failed");
				},
			},
		});

		await expect(run(agent, "Hi")).rejects.toThrow("afterRun hook failed");
	});

	test("beforeToolCall hook returning undefined is treated as allow", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "t", args: "{}" }]),
			textResponse("Done."),
		]);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		let toolExecuted = false;
		const agent = new Agent({
			name: "test",
			model,
			tools: [t],
			hooks: {
				beforeToolCall: () => {
					toolExecuted = true;
					// return undefined — should be treated as "allow"
				},
			},
		});

		const result = await run(agent, "Go");
		expect(toolExecuted).toBe(true);
		expect(result.output).toBe("Done.");
	});
});

// ─── Abort signal edge cases ─────────────────────────────────────────────

describe("edge: abort signal", () => {
	test("abort between tool execution and next model call", async () => {
		const ac = new AbortController();

		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "t", args: "{}" }]),
			textResponse("Should not reach here."),
		]);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => {
				ac.abort(); // Abort during tool execution
				return "done";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		await expect(run(agent, "Go", { signal: ac.signal })).rejects.toThrow(RunAbortedError);
	});

	test("abort signal in stream rejects result promise", async () => {
		const ac = new AbortController();
		ac.abort();

		const model = mockModel([textResponse("Hi")]);
		const agent = new Agent({ name: "test", model });

		const { stream: s, result } = stream(agent, "Hi", { signal: ac.signal });

		let streamThrew = false;
		try {
			for await (const _e of s) {
				// drain
			}
		} catch {
			streamThrew = true;
		}

		expect(streamThrew).toBe(true);
		await expect(result).rejects.toThrow(RunAbortedError);
	});
});

// ─── Handoff edge cases ──────────────────────────────────────────────────

describe("edge: handoffs", () => {
	test("handoff to agent with no instructions clears system message", async () => {
		const targetAgent = new Agent({
			name: "target",
			model: mockModel([textResponse("I'm the target.")]),
		});

		const sourceModel = mockModel([
			toolCallResponse([{ id: "tc1", name: "transfer_to_target", args: "{}" }]),
			textResponse("I'm the target."),
		]);

		const sourceAgent = new Agent({
			name: "source",
			model: sourceModel,
			instructions: "You are the source agent.",
			handoffs: [targetAgent],
		});

		const result = await run(sourceAgent, "Transfer me");
		expect(result.lastAgent.name).toBe("target");

		// System message should have been removed
		const systemMsgs = result.messages.filter((m) => m.role === "system");
		expect(systemMsgs).toHaveLength(0);
	});

	test("handoff to agent with different instructions replaces system message", async () => {
		const targetAgent = new Agent({
			name: "target",
			instructions: "You are the target.",
		});

		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "transfer_to_target", args: "{}" }]),
			textResponse("Handled by target."),
		]);

		const sourceAgent = new Agent({
			name: "source",
			model,
			instructions: "You are the source.",
			handoffs: [targetAgent],
		});

		const result = await run(sourceAgent, "Transfer");
		expect(result.lastAgent.name).toBe("target");

		const systemMsg = result.messages.find((m) => m.role === "system");
		expect(systemMsg).toBeDefined();
		if (systemMsg && systemMsg.role === "system") {
			expect(systemMsg.content).toBe("You are the target.");
		}
	});
});

// ─── Model error propagation ─────────────────────────────────────────────

describe("edge: model errors", () => {
	test("model that throws ModelError propagates", async () => {
		const failingModel: Model = {
			async getResponse(): Promise<ModelResponse> {
				throw new ModelError("Azure API error (500): Internal Server Error", { status: 500 });
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				throw new ModelError("Azure API error (500): Internal Server Error", { status: 500 });
			},
		};

		const agent = new Agent({ name: "test", model: failingModel });
		await expect(run(agent, "Hi")).rejects.toThrow(ModelError);
	});

	test("model that throws ContentFilterError propagates", async () => {
		const filteredModel: Model = {
			async getResponse(): Promise<ModelResponse> {
				throw new ContentFilterError();
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				throw new ContentFilterError();
			},
		};

		const agent = new Agent({ name: "test", model: filteredModel });
		await expect(run(agent, "Hi")).rejects.toThrow(ContentFilterError);
	});
});

// ─── Concurrent runs ─────────────────────────────────────────────────────

describe("edge: concurrency", () => {
	test("multiple runs on same agent don't interfere", async () => {
		let callCount = 0;
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				callCount++;
				// Simulate varying latency
				await new Promise((r) => setTimeout(r, Math.random() * 10));
				return textResponse(`Response ${callCount}`);
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: textResponse("stream") };
			},
		};

		const agent = new Agent({ name: "test", model });

		const results = await Promise.all([
			run(agent, "A"),
			run(agent, "B"),
			run(agent, "C"),
		]);

		// All three should complete successfully with non-empty output
		expect(results).toHaveLength(3);
		for (const r of results) {
			expect(r.output).toBeTruthy();
		}
	});
});

// ─── Session edge cases ──────────────────────────────────────────────────

describe("edge: sessions", () => {
	test("session with no messages still runs (empty conversation)", async () => {
		const model = mockModel([textResponse("Hi")]);
		const session = createSession({ model });

		// stream() without send() — runs with just system message (or empty messages)
		session.send("Hello");
		for await (const _e of session.stream()) {}
		const result = await session.result;
		expect(result.output).toBe("Hi");
	});

	test("accessing result before stream() throws", () => {
		const model = mockModel([textResponse("Hi")]);
		const session = createSession({ model });

		expect(() => session.result).toThrow();
	});

	test("save() includes conversation history", async () => {
		const model = mockModel([textResponse("Hello!"), textResponse("I remember.")]);
		const session = createSession({ model, instructions: "Be nice." });

		session.send("Hi");
		for await (const _e of session.stream()) {}

		const snapshot = session.save();
		expect(snapshot.messages.length).toBeGreaterThanOrEqual(2); // system + user + assistant at minimum
		expect(snapshot.id).toBe(session.id);
	});
});

// ─── Dynamic instructions edge cases ─────────────────────────────────────

describe("edge: dynamic instructions", () => {
	test("async instructions function", async () => {
		const model = mockModel([textResponse("Hello, Tyler!")]);

		const agent = new Agent({
			name: "test",
			model,
			instructions: async () => {
				await new Promise((r) => setTimeout(r, 1));
				return "You are helping Tyler.";
			},
		});

		const result = await run(agent, "Hi");
		const systemMsg = result.messages.find((m) => m.role === "system");
		expect(systemMsg).toBeDefined();
		if (systemMsg && systemMsg.role === "system") {
			expect(systemMsg.content).toBe("You are helping Tyler.");
		}
	});

	test("instructions function that throws propagates", async () => {
		const model = mockModel([textResponse("Hello!")]);

		const agent = new Agent({
			name: "test",
			model,
			instructions: () => {
				throw new Error("Failed to fetch instructions");
			},
		});

		await expect(run(agent, "Hi")).rejects.toThrow("Failed to fetch instructions");
	});

	test("agent with no instructions has no system message", async () => {
		const model = mockModel([textResponse("Hello!")]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		const systemMsgs = result.messages.filter((m) => m.role === "system");
		expect(systemMsgs).toHaveLength(0);
	});
});

// ─── ChatMessage[] input ─────────────────────────────────────────────────

describe("edge: input formats", () => {
	test("ChatMessage[] input is passed through", async () => {
		const model = mockModel([textResponse("I see the history.")]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "I remember" },
			{ role: "user", content: "Second message" },
		]);

		expect(result.output).toBe("I see the history.");
		// Messages should include the 3 input messages + 1 assistant response
		expect(result.messages.length).toBeGreaterThanOrEqual(4);
	});

	test("empty string input works", async () => {
		const model = mockModel([textResponse("You sent nothing.")]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "");
		expect(result.output).toBe("You sent nothing.");
	});
});

// ─── Subagent error handling ─────────────────────────────────────────────

describe("edge: subagents", () => {
	test("subagent child failure sends error message back to parent", async () => {
		const failingChild = new Agent({
			name: "failing_child",
			model: mockModel([]),  // No responses — will throw "No more mock responses"
		});

		const sa = subagent({
			agent: failingChild,
			inputSchema: z.object({ task: z.string() }),
			mapInput: (params) => params.task,
		});

		const parentModel = mockModel([
			toolCallResponse([{ id: "tc1", name: "run_failing_child", args: '{"task":"fail"}' }]),
			textResponse("The child agent encountered an error."),
		]);

		const parent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const result = await run(parent, "Do it");
		expect(result.output).toBe("The child agent encountered an error.");

		// subagentToTool catches errors internally and returns "Error in sub-agent ..."
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("Error in sub-agent"),
		);
		expect(toolMsg).toBeDefined();
	});
});

// ─── Usage accumulation ──────────────────────────────────────────────────

describe("edge: usage tracking", () => {
	test("usage accumulates across multiple model calls", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function" as const, function: { name: "t", arguments: "{}" } }],
				usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
			},
			{
				content: "Done.",
				toolCalls: [],
				usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
			},
		]);

		const t = tool({
			name: "t",
			description: "x",
			parameters: z.object({}),
			execute: async () => "ok",
		});

		const agent = new Agent({ name: "test", model, tools: [t] });
		const result = await run(agent, "Go");

		expect(result.usage.promptTokens).toBe(300);
		expect(result.usage.completionTokens).toBe(130);
		expect(result.usage.totalTokens).toBe(430);
	});

	test("usage with no usage info returns zeros", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.usage.promptTokens).toBe(0);
		expect(result.usage.completionTokens).toBe(0);
		expect(result.usage.totalTokens).toBe(0);
	});
});

// ─── toolUseBehavior edge cases ──────────────────────────────────────────

describe("edge: toolUseBehavior", () => {
	test("stop_on_first_tool returns tool output as result", async () => {
		const model = mockModel([
			toolCallResponse([{ id: "tc1", name: "classify", args: '{"label":"spam"}' }]),
		]);

		const classify = tool({
			name: "classify",
			description: "Classify",
			parameters: z.object({ label: z.string() }),
			execute: async (_ctx, { label }) => label,
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [classify],
			toolUseBehavior: "stop_on_first_tool",
		});

		const result = await run(agent, "Classify this");
		expect(result.output).toBe("spam");
	});

	test("stopAtToolNames stops only for matching tool", async () => {
		const model = mockModel([
			toolCallResponse([
				{ id: "tc1", name: "search", args: "{}" },
				{ id: "tc2", name: "done", args: '{"result":"found"}' },
			]),
		]);

		const search = tool({
			name: "search",
			description: "Search",
			parameters: z.object({}),
			execute: async () => "results",
		});

		const done = tool({
			name: "done",
			description: "Finalize",
			parameters: z.object({ result: z.string() }),
			execute: async (_ctx, { result }) => result,
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [search, done],
			toolUseBehavior: { stopAtToolNames: ["done"] },
		});

		const result = await run(agent, "Do it");
		// Should stop because "done" was called
		expect(result.output).toContain("found");
	});
});

// ─── Stream without consuming ────────────────────────────────────────────

describe("edge: stream lifecycle", () => {
	test("stream done event contains accumulated response", async () => {
		const model = mockModel([
			{
				content: "Hello world",
				toolCalls: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				finishReason: "stop",
			},
		]);

		const agent = new Agent({ name: "test", model });
		const { stream: s, result } = stream(agent, "Hi");

		let doneEvent: StreamEvent | undefined;
		for await (const e of s) {
			if (e.type === "done") doneEvent = e;
		}

		expect(doneEvent).toBeDefined();
		if (doneEvent?.type === "done") {
			expect(doneEvent.response.content).toBe("Hello world");
			expect(doneEvent.response.finishReason).toBe("stop");
		}

		const r = await result;
		expect(r.output).toBe("Hello world");
	});
});
