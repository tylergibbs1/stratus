import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { AgentHooks } from "../../src/core/hooks";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";
import { withTrace } from "../../src/core/tracing";

function mockModel(
	responses: ModelResponse[],
): Model & { requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	return {
		requests,
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			requests.push(structuredClone(request));
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

describe("subagents", () => {
	test("basic subagent execution returns result as tool message", async () => {
		// Child model responds to the child's prompt
		const childModel = mockModel([
			{ content: "Child says hello", toolCalls: [] },
		]);

		const childAgent = new Agent({
			name: "child",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ question: z.string() }),
			mapInput: (params) => params.question,
		});

		// Parent model calls the subagent tool, then responds
		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "run_child", arguments: '{"question":"hello?"}' },
					},
				],
			},
			{ content: "Parent got child result", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const result = await run(parentAgent, "test");

		expect(result.output).toBe("Parent got child result");
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Child says hello",
		);
		expect(toolMsg).toBeDefined();
	});

	test("subagent with its own tools (multi-turn child)", async () => {
		const childModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } },
				],
			},
			{ content: "The sum is 5", toolCalls: [] },
		]);

		const addTool = tool({
			name: "add",
			description: "Add",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, p) => String(p.a + p.b),
		});

		const childAgent = new Agent({
			name: "math",
			model: childModel,
			tools: [addTool],
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ expr: z.string() }),
			mapInput: (params) => `Compute: ${params.expr}`,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "run_math", arguments: '{"expr":"2+3"}' } },
				],
			},
			{ content: "Answer is 5", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const result = await run(parentAgent, "What is 2+3?");

		expect(result.output).toBe("Answer is 5");
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "The sum is 5",
		);
		expect(toolMsg).toBeDefined();
	});

	test("mapInput and mapContext work correctly", async () => {
		const receivedInputs: string[] = [];
		const receivedContexts: any[] = [];

		const childModel: Model = {
			async getResponse(request) {
				const userMsg = request.messages.find((m) => m.role === "user");
				if (userMsg) receivedInputs.push(userMsg.content as string);
				return { content: "child result", toolCalls: [] };
			},
			async *getStreamedResponse() {
				yield { type: "done", response: { content: "child result", toolCalls: [] } };
			},
		};

		const childAgent = new Agent<{ childKey: string }>({
			name: "child",
			model: childModel,
			instructions: (ctx) => {
				receivedContexts.push(ctx);
				return "child instructions";
			},
		});

		const sa = subagent<{ parentKey: string }, { childKey: string }>({
			agent: childAgent,
			inputSchema: z.object({ data: z.string() }),
			mapInput: (params) => `Processed: ${params.data}`,
			mapContext: (parentCtx) => ({ childKey: parentCtx.parentKey + "_child" }),
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "run_child", arguments: '{"data":"test"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		await run(parentAgent, "test", { context: { parentKey: "parent" } });

		expect(receivedInputs[0]).toBe("Processed: test");
		expect(receivedContexts[0]).toEqual({ childKey: "parent_child" });
	});

	test("hooks fire for subagent tool calls", async () => {
		const beforeCalls: string[] = [];
		const afterCalls: string[] = [];

		const childModel = mockModel([
			{ content: "child result", toolCalls: [] },
		]);

		const childAgent = new Agent({
			name: "child",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const hooks: AgentHooks = {
			beforeToolCall: ({ toolCall }) => {
				beforeCalls.push(toolCall.function.name);
			},
			afterToolCall: ({ toolCall }) => {
				afterCalls.push(toolCall.function.name);
			},
		};

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "run_child", arguments: '{"q":"hello"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
			hooks,
		});

		await run(parentAgent, "test");

		expect(beforeCalls).toEqual(["run_child"]);
		expect(afterCalls).toEqual(["run_child"]);
	});

	test("error in child agent returns error as tool message", async () => {
		const childModel: Model = {
			async getResponse() {
				throw new Error("Child failed");
			},
			async *getStreamedResponse() {
				throw new Error("Child failed");
			},
		};

		const childAgent = new Agent({
			name: "child",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "run_child", arguments: '{"q":"hello"}' } },
				],
			},
			{ content: "Handled error", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const result = await run(parentAgent, "test");

		expect(result.output).toBe("Handled error");
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("Error in sub-agent"),
		);
		expect(toolMsg).toBeDefined();
	});

	test("multiple subagents, model calls the right one", async () => {
		const childModelA = mockModel([
			{ content: "A result", toolCalls: [] },
		]);
		const childModelB = mockModel([
			{ content: "B result", toolCalls: [] },
		]);

		const agentA = new Agent({ name: "agent_a", model: childModelA });
		const agentB = new Agent({ name: "agent_b", model: childModelB });

		const saA = subagent({
			agent: agentA,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (p) => p.q,
		});
		const saB = subagent({
			agent: agentB,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (p) => p.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "run_agent_b", arguments: '{"q":"query"}' },
					},
				],
			},
			{ content: "Got B's answer", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [saA, saB],
		});

		const result = await run(parentAgent, "test");

		expect(result.output).toBe("Got B's answer");
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "B result",
		);
		expect(toolMsg).toBeDefined();
		// agentA should NOT have been called
		expect(childModelA.requests.length).toBe(0);
	});

	test("tracing spans use 'subagent' type", async () => {
		const childModel = mockModel([
			{ content: "child result", toolCalls: [] },
		]);

		const childAgent = new Agent({
			name: "child",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "run_child", arguments: '{"q":"hi"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const { trace } = await withTrace("test_trace", async () => {
			return run(parentAgent, "test");
		});

		// Find the subagent span
		const allSpans = trace.spans.flatMap((s) => [s, ...s.children]);
		const subagentSpan = allSpans.find((s) => s.type === "subagent");
		expect(subagentSpan).toBeDefined();
		expect(subagentSpan!.name).toContain("child");
	});

	test("session with subagents", async () => {
		const childModel = mockModel([
			{ content: "child answer", toolCalls: [] },
		]);

		const childAgent = new Agent({
			name: "child",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "run_child", arguments: '{"q":"hello"}' } },
				],
			},
			{ content: "Session got child answer", toolCalls: [] },
		]);

		const session = createSession({
			model: parentModel,
			subagents: [sa],
		});

		session.send("test");
		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.output).toBe("Session got child answer");
	});

	test("custom toolName on subagent", async () => {
		const childModel = mockModel([
			{ content: "custom result", toolCalls: [] },
		]);

		const childAgent = new Agent({
			name: "child",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			toolName: "ask_child",
			toolDescription: "Ask the child agent a question",
			inputSchema: z.object({ question: z.string() }),
			mapInput: (params) => params.question,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "ask_child", arguments: '{"question":"hi"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const result = await run(parentAgent, "test");
		expect(result.output).toBe("Done");

		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "custom result",
		);
		expect(toolMsg).toBeDefined();
	});
});
