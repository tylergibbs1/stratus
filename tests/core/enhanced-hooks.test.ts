import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { AgentHooks, HandoffDecision, ToolCallDecision } from "../../src/core/hooks";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run, stream } from "../../src/core/run";
import { tool } from "../../src/core/tool";

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

const echoTool = tool({
	name: "echo",
	description: "Echo input",
	parameters: z.object({ message: z.string() }),
	execute: async (_ctx, params) => `Echo: ${params.message}`,
});

describe("enhanced hooks - tool call decisions", () => {
	test("deny blocks tool execution and returns reason as tool message", async () => {
		const executeSpy = mock(() => "should not run");
		const blockedTool = tool({
			name: "blocked",
			description: "Blocked tool",
			parameters: z.object({ x: z.string() }),
			execute: executeSpy as any,
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "blocked", arguments: '{"x":"test"}' } },
				],
			},
			{ content: "Ok", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () => ({ decision: "deny", reason: "Not allowed" }) as ToolCallDecision,
		};

		const agent = new Agent({ name: "test", model, tools: [blockedTool], hooks });
		const result = await run(agent, "test");

		expect(executeSpy).not.toHaveBeenCalled();
		// The denied tool message should contain the reason
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg!.content).toBe("Not allowed");
	});

	test("deny with no reason uses default message", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "echo", arguments: '{"message":"hi"}' } },
				],
			},
			{ content: "Ok", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () => ({ decision: "deny" }) as ToolCallDecision,
		};

		const agent = new Agent({ name: "test", model, tools: [echoTool], hooks });
		const result = await run(agent, "test");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg!.content).toContain("was denied");
	});

	test("modify changes params passed to execute", async () => {
		const receivedParams: any[] = [];
		const trackingTool = tool({
			name: "track",
			description: "Track params",
			parameters: z.object({ value: z.string() }),
			execute: async (_ctx, params) => {
				receivedParams.push(params);
				return `Got: ${params.value}`;
			},
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "track", arguments: '{"value":"original"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () =>
				({ decision: "modify", modifiedParams: { value: "modified" } }) as ToolCallDecision,
		};

		const agent = new Agent({ name: "test", model, tools: [trackingTool], hooks });
		await run(agent, "test");

		expect(receivedParams[0]).toEqual({ value: "modified" });
	});

	test("allow proceeds normally", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "echo", arguments: '{"message":"hi"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () => ({ decision: "allow" }) as ToolCallDecision,
		};

		const agent = new Agent({ name: "test", model, tools: [echoTool], hooks });
		const result = await run(agent, "test");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg!.content).toBe("Echo: hi");
	});

	test("void return proceeds normally (backward compat)", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "echo", arguments: '{"message":"hi"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () => {
				// void return
			},
		};

		const agent = new Agent({ name: "test", model, tools: [echoTool], hooks });
		const result = await run(agent, "test");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg!.content).toBe("Echo: hi");
	});

	test("deny skips afterToolCall hook", async () => {
		const afterFn = mock(() => {});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "echo", arguments: '{"message":"hi"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () => ({ decision: "deny", reason: "Nope" }) as ToolCallDecision,
			afterToolCall: afterFn,
		};

		const agent = new Agent({ name: "test", model, tools: [echoTool], hooks });
		await run(agent, "test");

		expect(afterFn).not.toHaveBeenCalled();
	});

	test("modify still fires afterToolCall", async () => {
		const afterFn = mock(() => {});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "echo", arguments: '{"message":"original"}' } },
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeToolCall: () =>
				({ decision: "modify", modifiedParams: { message: "changed" } }) as ToolCallDecision,
			afterToolCall: afterFn,
		};

		const agent = new Agent({ name: "test", model, tools: [echoTool], hooks });
		await run(agent, "test");

		expect(afterFn).toHaveBeenCalledTimes(1);
	});
});

describe("enhanced hooks - handoff decisions", () => {
	test("handoff deny blocks agent switch", async () => {
		const childAgent = new Agent({ name: "child", instructions: "I am child" });

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "transfer_to_child", arguments: "{}" } },
				],
			},
			{ content: "Stayed with parent", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeHandoff: () => ({ decision: "deny", reason: "Not allowed to transfer" }) as HandoffDecision,
		};

		const agent = new Agent({
			name: "parent",
			model,
			handoffs: [childAgent],
			hooks,
		});

		const result = await run(agent, "test");

		expect(result.lastAgent.name).toBe("parent");
		// The tool message should contain the denial reason
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Not allowed to transfer",
		);
		expect(toolMsg).toBeDefined();
	});

	test("handoff deny in stream mode", async () => {
		const childAgent = new Agent({ name: "child", instructions: "I am child" });

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "transfer_to_child", arguments: "{}" } },
				],
			},
			{ content: "Stayed with parent", toolCalls: [] },
		]);

		const hooks: AgentHooks = {
			beforeHandoff: () => ({ decision: "deny" }) as HandoffDecision,
		};

		const agent = new Agent({
			name: "parent",
			model,
			handoffs: [childAgent],
			hooks,
		});

		const { stream: s, result } = stream(agent, "test");
		for await (const _event of s) {
			// drain
		}

		const r = await result;
		expect(r.lastAgent.name).toBe("parent");
	});
});
