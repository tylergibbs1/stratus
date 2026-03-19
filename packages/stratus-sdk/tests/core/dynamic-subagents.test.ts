import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
import { subagent } from "../../src/core/subagent";

function mockModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
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

describe("dynamic subagents", () => {
	test("parent with no static subagents can use dynamic subagent via run()", async () => {
		const childModel = mockModel([{ content: "Dynamic child result", toolCalls: [] }]);

		const childAgent = new Agent({
			name: "dynamic_child",
			model: childModel,
		});

		const dynamicSa = subagent({
			agent: childAgent,
			inputSchema: z.object({ query: z.string() }),
			mapInput: (params) => params.query,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "run_dynamic_child", arguments: '{"query":"hello"}' },
					},
				],
			},
			{ content: "Got dynamic child answer", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
		});

		// No static subagents on the parent agent
		expect(parentAgent.subagents).toHaveLength(0);

		const result = await run(parentAgent, "test", {
			dynamicSubagents: [dynamicSa],
		});

		expect(result.output).toBe("Got dynamic child answer");
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "Dynamic child result",
		);
		expect(toolMsg).toBeDefined();
	});

	test("dynamic subagent tool definition is included in model request", async () => {
		const childModel = mockModel([{ content: "child result", toolCalls: [] }]);

		const childAgent = new Agent({
			name: "helper",
			model: childModel,
		});

		const dynamicSa = subagent({
			agent: childAgent,
			toolName: "ask_helper",
			toolDescription: "Ask the helper",
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const parentModel = mockModel([{ content: "No tool needed", toolCalls: [] }]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
		});

		await run(parentAgent, "test", { dynamicSubagents: [dynamicSa] });

		// Verify the tool definition was sent to the model
		const request = parentModel.requests[0]!;
		expect(request.tools).toBeDefined();
		const toolDef = request.tools!.find((t) => "function" in t && t.function.name === "ask_helper");
		expect(toolDef).toBeDefined();
	});

	test("dynamic subagents combine with static subagents", async () => {
		const staticChildModel = mockModel([{ content: "static result", toolCalls: [] }]);
		const dynamicChildModel = mockModel([{ content: "dynamic result", toolCalls: [] }]);

		const staticChild = new Agent({ name: "static_child", model: staticChildModel });
		const dynamicChild = new Agent({ name: "dynamic_child", model: dynamicChildModel });

		const staticSa = subagent({
			agent: staticChild,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (p) => p.q,
		});

		const dynamicSa = subagent({
			agent: dynamicChild,
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
						function: { name: "run_dynamic_child", arguments: '{"q":"hi"}' },
					},
				],
			},
			{ content: "Done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [staticSa],
		});

		const result = await run(parentAgent, "test", { dynamicSubagents: [dynamicSa] });

		expect(result.output).toBe("Done");

		// Both subagent tools should appear in the request
		const request = parentModel.requests[0]!;
		const toolNames = request.tools!.map((t) => ("function" in t ? t.function.name : ""));
		expect(toolNames).toContain("run_static_child");
		expect(toolNames).toContain("run_dynamic_child");

		// Only dynamic child model should have been called
		expect(dynamicChildModel.requests).toHaveLength(1);
		expect(staticChildModel.requests).toHaveLength(0);
	});

	test("dynamic subagents work with stream()", async () => {
		const childModel = mockModel([{ content: "streamed child result", toolCalls: [] }]);

		const childAgent = new Agent({
			name: "stream_child",
			model: childModel,
		});

		const dynamicSa = subagent({
			agent: childAgent,
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
						function: { name: "run_stream_child", arguments: '{"q":"hi"}' },
					},
				],
			},
			{ content: "Streamed done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
		});

		const { stream: s, result: resultPromise } = stream(parentAgent, "test", {
			dynamicSubagents: [dynamicSa],
		});

		for await (const _event of s) {
			// drain
		}

		const result = await resultPromise;
		expect(result.output).toBe("Streamed done");

		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content === "streamed child result",
		);
		expect(toolMsg).toBeDefined();
	});
});
