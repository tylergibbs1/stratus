import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
import type { CanUseTool } from "../../src/core/run";
import { createSession } from "../../src/core/session";
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
				yield {
					type: "tool_call_delta",
					toolCallId: tc.id,
					arguments: tc.function.arguments,
				};
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

/** A mock model that captures the requests it receives. */
function capturingModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	return {
		requests,
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
			if (response.content) {
				yield { type: "content_delta", content: response.content };
			}
			for (const tc of response.toolCalls) {
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield {
					type: "tool_call_delta",
					toolCallId: tc.id,
					arguments: tc.function.arguments,
				};
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

// --- Predicted Output ---

describe("predicted output", () => {
	test("prediction field is passed through ModelSettings", () => {
		const settings: ModelSettings = {
			prediction: { type: "content", content: "expected output" },
		};
		expect(settings.prediction).toEqual({ type: "content", content: "expected output" });
	});

	test("prediction is sent to chat completions model", async () => {
		const model = capturingModel([{ content: "result", toolCalls: [] }]);
		const agent = new Agent({
			name: "test",
			model,
			modelSettings: { prediction: { type: "content", content: "predicted" } },
		});
		await run(agent, "Hi");
		expect(model.requests[0]!.modelSettings?.prediction).toEqual({
			type: "content",
			content: "predicted",
		});
	});
});

// --- Audio Modalities ---

describe("audio modalities", () => {
	test("audio config fields in ModelSettings", () => {
		const settings: ModelSettings = {
			modalities: ["text", "audio"],
			audio: { voice: "alloy", format: "mp3" },
		};
		expect(settings.modalities).toEqual(["text", "audio"]);
		expect(settings.audio).toEqual({ voice: "alloy", format: "mp3" });
	});

	test("audio settings passed through to model request", async () => {
		const model = capturingModel([{ content: "audio response", toolCalls: [] }]);
		const agent = new Agent({
			name: "test",
			model,
			modelSettings: {
				modalities: ["text", "audio"],
				audio: { voice: "nova", format: "wav" },
			},
		});
		await run(agent, "Speak to me");
		const s = model.requests[0]!.modelSettings!;
		expect(s.modalities).toEqual(["text", "audio"]);
		expect(s.audio).toEqual({ voice: "nova", format: "wav" });
	});
});

// --- Data Sources ---

describe("data sources", () => {
	test("dataSources field in ModelSettings", () => {
		const settings: ModelSettings = {
			dataSources: [
				{
					type: "azure_search",
					parameters: {
						endpoint: "https://search.example.com",
						index_name: "my-index",
					},
				},
			],
		};
		expect(settings.dataSources).toHaveLength(1);
		expect(settings.dataSources![0]!.type).toBe("azure_search");
	});

	test("dataSources passed through to model request", async () => {
		const ds = {
			type: "azure_search",
			parameters: { endpoint: "https://x.com", index_name: "idx" },
		};
		const model = capturingModel([{ content: "rag result", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, modelSettings: { dataSources: [ds] } });
		await run(agent, "Search something");
		expect(model.requests[0]!.modelSettings?.dataSources).toEqual([ds]);
	});
});

// --- Context Management ---

describe("context management", () => {
	test("contextManagement field in ModelSettings", () => {
		const settings: ModelSettings = {
			contextManagement: [{ type: "truncation", truncation_strategy: "auto" }],
		};
		expect(settings.contextManagement![0]!.type).toBe("truncation");
	});

	test("contextManagement passed through to model request", async () => {
		const cm = [{ type: "truncation", truncation_strategy: "auto" }];
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, modelSettings: { contextManagement: cm } });
		await run(agent, "Long conversation");
		expect(model.requests[0]!.modelSettings?.contextManagement).toEqual(cm);
	});
});

// --- Allowed Tools ---

describe("allowedTools", () => {
	const weatherTool = tool({
		name: "get_weather",
		description: "Get weather",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, params) => `Sunny in ${params.city}`,
	});

	const searchTool = tool({
		name: "mcp__github__search",
		description: "Search GitHub",
		parameters: z.object({ query: z.string() }),
		execute: async (_ctx, params) => `Results for ${params.query}`,
	});

	const listTool = tool({
		name: "mcp__github__list_repos",
		description: "List repos",
		parameters: z.object({}),
		execute: async () => "repos",
	});

	test("exact match filters tools", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, tools: [weatherTool, searchTool, listTool] });
		await run(agent, "Hi", { allowedTools: ["get_weather"] });
		const tools = model.requests[0]!.tools!;
		expect(tools).toHaveLength(1);
		expect((tools[0] as any).function.name).toBe("get_weather");
	});

	test("wildcard pattern filters tools", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, tools: [weatherTool, searchTool, listTool] });
		await run(agent, "Hi", { allowedTools: ["mcp__github__*"] });
		const tools = model.requests[0]!.tools!;
		expect(tools).toHaveLength(2);
		const names = tools.map((t: any) => t.function.name);
		expect(names).toContain("mcp__github__search");
		expect(names).toContain("mcp__github__list_repos");
	});

	test("multiple patterns combine", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, tools: [weatherTool, searchTool, listTool] });
		await run(agent, "Hi", { allowedTools: ["get_weather", "mcp__github__search"] });
		const tools = model.requests[0]!.tools!;
		expect(tools).toHaveLength(2);
	});

	test("no matching patterns means no tools", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, tools: [weatherTool] });
		await run(agent, "Hi", { allowedTools: ["nonexistent"] });
		expect(model.requests[0]!.tools).toBeUndefined();
	});

	test("allowedTools works in streaming mode", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model, tools: [weatherTool, searchTool] });
		const { stream: s, result } = stream(agent, "Hi", { allowedTools: ["get_weather"] });
		for await (const _ of s) {
			// drain
		}
		await result;
		expect(model.requests[0]!.tools).toHaveLength(1);
	});
});

// --- canUseTool ---

describe("canUseTool", () => {
	const echoTool = tool({
		name: "echo",
		description: "Echo",
		parameters: z.object({ text: z.string() }),
		execute: async (_ctx, params) => params.text,
	});

	test("allows tool execution when behavior is allow", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "echo", arguments: '{"text":"hello"}' },
					},
				],
			},
			{ content: "echoed: hello", toolCalls: [] },
		]);

		const canUseTool: CanUseTool = async () => ({ behavior: "allow" });
		const agent = new Agent({ name: "test", model, tools: [echoTool] });
		const result = await run(agent, "echo hello", { canUseTool });
		expect(result.output).toBe("echoed: hello");
	});

	test("denies tool execution with message", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "echo", arguments: '{"text":"hello"}' },
					},
				],
			},
			{ content: "denied", toolCalls: [] },
		]);

		const canUseTool: CanUseTool = async (toolName) => {
			if (toolName === "echo") {
				return { behavior: "deny", message: "Not allowed" };
			}
			return { behavior: "allow" };
		};

		const agent = new Agent({ name: "test", model, tools: [echoTool] });
		const result = await run(agent, "echo hello", { canUseTool });
		// The deny message should have been sent back to the model
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		expect((toolMsg as any).content).toBe("Not allowed");
	});

	test("allows with updated input", async () => {
		let executedWith: unknown;
		const captureTool = tool({
			name: "echo",
			description: "Echo",
			parameters: z.object({ text: z.string() }),
			execute: async (_ctx, params) => {
				executedWith = params;
				return params.text;
			},
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "echo", arguments: '{"text":"original"}' },
					},
				],
			},
			{ content: "done", toolCalls: [] },
		]);

		const canUseTool: CanUseTool = async () => ({
			behavior: "allow",
			updatedInput: { text: "modified" },
		});

		const agent = new Agent({ name: "test", model, tools: [captureTool] });
		await run(agent, "test", { canUseTool });
		expect((executedWith as any).text).toBe("modified");
	});
});

// --- Graceful Interrupt ---

describe("graceful interrupt", () => {
	test("interrupt() stops the run and returns partial result", async () => {
		// Model will try two tool calls, but we interrupt after the first
		const model = mockModel([
			{
				content: null,
				toolCalls: [{ id: "tc1", type: "function", function: { name: "slow", arguments: "{}" } }],
			},
			// This second response would be the next turn, but interrupt should prevent it
			{ content: "continued", toolCalls: [] },
		]);

		const slowTool = tool({
			name: "slow",
			description: "Slow tool",
			parameters: z.object({}),
			execute: async () => "done",
		});

		const agent = new Agent({ name: "test", model, tools: [slowTool] });
		const { stream: s, result, interrupt } = stream(agent, "Do something");

		let eventCount = 0;
		for await (const event of s) {
			eventCount++;
			// Interrupt after the first done event (first turn completes)
			if (event.type === "done") {
				interrupt();
			}
		}

		const r = await result;
		// Should have resolved normally (not thrown)
		expect(r.interrupted).toBe(false);
		expect(r.numTurns).toBe(1);
	});

	test("interrupt before any model call returns empty partial result", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });
		const { stream: s, result, interrupt } = stream(agent, "Hi");

		// Interrupt before consuming — no model call has happened yet
		interrupt();

		for await (const _ of s) {
			// drain
		}
		const r = await result;
		// Since interrupt happened before any model call, output is empty
		expect(r.output).toBe("");
		expect(r.numTurns).toBe(0);
	});
});

// --- Session Tool Management ---

describe("session tool management", () => {
	test("addTools adds tools to session", () => {
		const model = mockModel([]);
		const t1 = tool({
			name: "tool1",
			description: "Tool 1",
			parameters: z.object({}),
			execute: async () => "1",
		});
		const t2 = tool({
			name: "tool2",
			description: "Tool 2",
			parameters: z.object({}),
			execute: async () => "2",
		});

		const session = createSession({ model, tools: [t1] });
		session.addTools([t2]);
		// We can't directly inspect _agent.tools, but we can verify no error was thrown
		// and that the session is still functional
		expect(() => session.addTools([])).not.toThrow();
	});

	test("removeTools removes tools by name", () => {
		const model = mockModel([]);
		const t1 = tool({
			name: "tool1",
			description: "Tool 1",
			parameters: z.object({}),
			execute: async () => "1",
		});
		const t2 = tool({
			name: "tool2",
			description: "Tool 2",
			parameters: z.object({}),
			execute: async () => "2",
		});

		const session = createSession({ model, tools: [t1, t2] });
		session.removeTools(["tool1"]);
		expect(() => session.removeTools([])).not.toThrow();
	});

	test("setTools replaces all tools", () => {
		const model = mockModel([]);
		const t1 = tool({
			name: "tool1",
			description: "Tool 1",
			parameters: z.object({}),
			execute: async () => "1",
		});
		const t2 = tool({
			name: "tool2",
			description: "Tool 2",
			parameters: z.object({}),
			execute: async () => "2",
		});

		const session = createSession({ model, tools: [t1] });
		session.setTools([t2]);
		expect(() => session.setTools([])).not.toThrow();
	});

	test("tool management throws when session is closed", () => {
		const model = mockModel([]);
		const session = createSession({ model });
		session.close();
		expect(() => session.addTools([])).toThrow("Session is closed");
		expect(() => session.removeTools([])).toThrow("Session is closed");
		expect(() => session.setTools([])).toThrow("Session is closed");
	});

	test("addTools includes new tools in model request", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const t1 = tool({
			name: "tool1",
			description: "Tool 1",
			parameters: z.object({}),
			execute: async () => "1",
		});
		const t2 = tool({
			name: "tool2",
			description: "Tool 2",
			parameters: z.object({}),
			execute: async () => "2",
		});

		const session = createSession({ model, tools: [t1] });
		session.addTools([t2]);
		session.send("Hello");
		for await (const _ of session.stream()) {
			// drain
		}
		await session.result;

		const tools = model.requests[0]!.tools!;
		expect(tools).toHaveLength(2);
	});

	test("removeTools excludes tools from model request", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const t1 = tool({
			name: "tool1",
			description: "Tool 1",
			parameters: z.object({}),
			execute: async () => "1",
		});
		const t2 = tool({
			name: "tool2",
			description: "Tool 2",
			parameters: z.object({}),
			execute: async () => "2",
		});

		const session = createSession({ model, tools: [t1, t2] });
		session.removeTools(["tool1"]);
		session.send("Hello");
		for await (const _ of session.stream()) {
			// drain
		}
		await session.result;

		const tools = model.requests[0]!.tools!;
		expect(tools).toHaveLength(1);
		expect((tools[0] as any).function.name).toBe("tool2");
	});
});

// --- Session with allowedTools ---

describe("session with allowedTools", () => {
	test("allowedTools filters tools in session", async () => {
		const model = capturingModel([{ content: "ok", toolCalls: [] }]);
		const t1 = tool({
			name: "tool1",
			description: "Tool 1",
			parameters: z.object({}),
			execute: async () => "1",
		});
		const t2 = tool({
			name: "tool2",
			description: "Tool 2",
			parameters: z.object({}),
			execute: async () => "2",
		});

		const session = createSession({ model, tools: [t1, t2], allowedTools: ["tool1"] });
		session.send("Hello");
		for await (const _ of session.stream()) {
			// drain
		}
		await session.result;

		const tools = model.requests[0]!.tools!;
		expect(tools).toHaveLength(1);
		expect((tools[0] as any).function.name).toBe("tool1");
	});
});
