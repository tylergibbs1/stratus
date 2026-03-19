import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { InterruptedRunResult } from "../../src/core/result";
import { resumeRun, run } from "../../src/core/run";
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

describe("human-in-the-loop", () => {
	const dangerousTool = tool({
		name: "delete_file",
		description: "Delete a file",
		parameters: z.object({ path: z.string() }),
		execute: async (_ctx, params) => `Deleted ${params.path}`,
		needsApproval: true,
	});

	const safeTool = tool({
		name: "read_file",
		description: "Read a file",
		parameters: z.object({ path: z.string() }),
		execute: async (_ctx, params) => `Contents of ${params.path}`,
	});

	test("tool with needsApproval: true returns InterruptedRunResult", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/test.txt"}' },
					},
				],
			},
		]);

		const agent = new Agent({ name: "test", model, tools: [dangerousTool] });
		const result = await run(agent, "Delete /tmp/test.txt");

		expect(result).toBeInstanceOf(InterruptedRunResult);
		if (!(result instanceof InterruptedRunResult)) throw new Error("Expected InterruptedRunResult");

		expect(result.interrupted).toBe(true);
		expect(result.pendingToolCalls).toHaveLength(1);
		expect(result.pendingToolCalls[0]!.toolCallId).toBe("tc1");
		expect(result.pendingToolCalls[0]!.toolName).toBe("delete_file");
		expect(result.pendingToolCalls[0]!.parsedArguments).toEqual({ path: "/tmp/test.txt" });
		expect(result.numTurns).toBe(1);
	});

	test("tool without needsApproval executes normally", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"/tmp/test.txt"}' },
					},
				],
			},
			{
				content: "The file contains hello world",
				toolCalls: [],
			},
		]);

		const agent = new Agent({ name: "test", model, tools: [safeTool] });
		const result = await run(agent, "Read /tmp/test.txt");

		expect(result).not.toBeInstanceOf(InterruptedRunResult);
		expect(result.output).toBe("The file contains hello world");
	});

	test("resumeRun with approve continues execution", async () => {
		const model = mockModel([
			// First call: model requests tool call
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/test.txt"}' },
					},
				],
			},
			// Second call (after resume): model produces final response
			{
				content: "File has been deleted successfully.",
				toolCalls: [],
			},
		]);

		const agent = new Agent({ name: "test", model, tools: [dangerousTool] });
		const interrupted = await run(agent, "Delete /tmp/test.txt");

		expect(interrupted).toBeInstanceOf(InterruptedRunResult);
		if (!(interrupted instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		const result = await resumeRun(interrupted, [{ toolCallId: "tc1", decision: "approve" }]);

		expect(result).not.toBeInstanceOf(InterruptedRunResult);
		expect(result.output).toBe("File has been deleted successfully.");

		// Check that the tool was actually executed (tool message in the messages)
		const toolMsg = result.messages.find((m) => m.role === "tool" && m.tool_call_id === "tc1");
		expect(toolMsg).toBeDefined();
		expect(toolMsg!.content).toBe("Deleted /tmp/test.txt");
	});

	test("resumeRun with deny sends denial message to model", async () => {
		const model = mockModel([
			// First call: model requests tool call
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/important.txt"}' },
					},
				],
			},
			// Second call (after resume with denial): model responds acknowledging denial
			{
				content: "OK, I won't delete that file.",
				toolCalls: [],
			},
		]);

		const agent = new Agent({ name: "test", model, tools: [dangerousTool] });
		const interrupted = await run(agent, "Delete /tmp/important.txt");

		expect(interrupted).toBeInstanceOf(InterruptedRunResult);
		if (!(interrupted instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		const result = await resumeRun(interrupted, [
			{
				toolCallId: "tc1",
				decision: "deny",
				denyMessage: "User refused to delete this file",
			},
		]);

		expect(result).not.toBeInstanceOf(InterruptedRunResult);
		expect(result.output).toBe("OK, I won't delete that file.");

		// Check the denial message was sent to the model
		const toolMsg = result.messages.find((m) => m.role === "tool" && m.tool_call_id === "tc1");
		expect(toolMsg).toBeDefined();
		expect(toolMsg!.content).toBe("User refused to delete this file");
	});

	test("resumeRun with deny uses default message when denyMessage not provided", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/test.txt"}' },
					},
				],
			},
			{
				content: "Understood.",
				toolCalls: [],
			},
		]);

		const agent = new Agent({ name: "test", model, tools: [dangerousTool] });
		const interrupted = await run(agent, "Delete /tmp/test.txt");

		if (!(interrupted instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		const result = await resumeRun(interrupted, [{ toolCallId: "tc1", decision: "deny" }]);

		const toolMsg = result.messages.find((m) => m.role === "tool" && m.tool_call_id === "tc1");
		expect(toolMsg!.content).toBe("Tool call denied by user");
	});

	test("needsApproval as predicate conditionally interrupts", async () => {
		const conditionalTool = tool({
			name: "write_file",
			description: "Write a file",
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async (_ctx, params) => `Wrote to ${params.path}`,
			needsApproval: (params) => params.path.startsWith("/etc/"),
		});

		// Case 1: /etc/ path should interrupt
		const model1 = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: {
							name: "write_file",
							arguments: '{"path":"/etc/config","content":"data"}',
						},
					},
				],
			},
		]);

		const agent1 = new Agent({ name: "test", model: model1, tools: [conditionalTool] });
		const result1 = await run(agent1, "Write to /etc/config");
		expect(result1).toBeInstanceOf(InterruptedRunResult);

		// Case 2: /tmp/ path should NOT interrupt
		const model2 = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc2",
						type: "function",
						function: {
							name: "write_file",
							arguments: '{"path":"/tmp/test","content":"data"}',
						},
					},
				],
			},
			{
				content: "Written.",
				toolCalls: [],
			},
		]);

		const agent2 = new Agent({ name: "test", model: model2, tools: [conditionalTool] });
		const result2 = await run(agent2, "Write to /tmp/test");
		expect(result2).not.toBeInstanceOf(InterruptedRunResult);
		expect(result2.output).toBe("Written.");
	});

	test("mixed tools: only needsApproval tools cause interrupt", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"/tmp/a.txt"}' },
					},
					{
						id: "tc2",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/b.txt"}' },
					},
				],
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [safeTool, dangerousTool],
		});

		const result = await run(agent, "Read a.txt and delete b.txt");

		// Should interrupt because delete_file needs approval
		expect(result).toBeInstanceOf(InterruptedRunResult);
		if (!(result instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		// Only the dangerous tool should be pending
		expect(result.pendingToolCalls).toHaveLength(1);
		expect(result.pendingToolCalls[0]!.toolName).toBe("delete_file");
	});

	test("resumeRun executes non-pending tools alongside approved ones", async () => {
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"/tmp/a.txt"}' },
					},
					{
						id: "tc2",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/b.txt"}' },
					},
				],
			},
			{
				content: "Done.",
				toolCalls: [],
			},
		]);

		const agent = new Agent({
			name: "test",
			model,
			tools: [safeTool, dangerousTool],
		});

		const interrupted = await run(agent, "Read a.txt and delete b.txt");
		if (!(interrupted instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		const result = await resumeRun(interrupted, [{ toolCallId: "tc2", decision: "approve" }]);

		expect(result).not.toBeInstanceOf(InterruptedRunResult);

		// Both tool messages should be present
		const readMsg = result.messages.find((m) => m.role === "tool" && m.tool_call_id === "tc1");
		const deleteMsg = result.messages.find((m) => m.role === "tool" && m.tool_call_id === "tc2");
		expect(readMsg!.content).toBe("Contents of /tmp/a.txt");
		expect(deleteMsg!.content).toBe("Deleted /tmp/b.txt");
	});

	test("InterruptedRunResult preserves context", async () => {
		type Ctx = { userId: string };
		const ctxTool = tool<{ path: string }, Ctx>({
			name: "delete_file",
			description: "Delete a file",
			parameters: z.object({ path: z.string() }),
			execute: async (ctx, params) => `${ctx.userId} deleted ${params.path}`,
			needsApproval: true,
		});

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/x"}' },
					},
				],
			},
		]);

		const agent = new Agent<Ctx>({ name: "test", model, tools: [ctxTool] });
		const result = await run(agent, "Delete /tmp/x", { context: { userId: "user-42" } });

		expect(result).toBeInstanceOf(InterruptedRunResult);
		if (!(result instanceof InterruptedRunResult)) throw new Error("Expected interrupt");

		expect(result.context).toEqual({ userId: "user-42" });
	});

	test("needsApproval predicate receives context", async () => {
		type Ctx = { isAdmin: boolean };
		const adminTool = tool<{ path: string }, Ctx>({
			name: "delete_file",
			description: "Delete a file",
			parameters: z.object({ path: z.string() }),
			execute: async (_ctx, params) => `Deleted ${params.path}`,
			needsApproval: (_params, ctx) => !ctx.isAdmin,
		});

		// Non-admin: should interrupt
		const model1 = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/x"}' },
					},
				],
			},
		]);
		const agent1 = new Agent<Ctx>({ name: "test", model: model1, tools: [adminTool] });
		const result1 = await run(agent1, "Delete", { context: { isAdmin: false } });
		expect(result1).toBeInstanceOf(InterruptedRunResult);

		// Admin: should NOT interrupt
		const model2 = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc2",
						type: "function",
						function: { name: "delete_file", arguments: '{"path":"/tmp/x"}' },
					},
				],
			},
			{
				content: "Deleted.",
				toolCalls: [],
			},
		]);
		const agent2 = new Agent<Ctx>({ name: "test", model: model2, tools: [adminTool] });
		const result2 = await run(agent2, "Delete", { context: { isAdmin: true } });
		expect(result2).not.toBeInstanceOf(InterruptedRunResult);
	});
});
