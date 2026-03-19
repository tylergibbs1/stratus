import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream } from "../../src/core/run";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";

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

describe("subagent streaming relay", () => {
	test("parent stream emits subagent_start, subagent_delta, and subagent_end events", async () => {
		const childModel = mockModel([{ content: "Child response text", toolCalls: [] }]);

		const childAgent = new Agent({
			name: "researcher",
			model: childModel,
		});

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ question: z.string() }),
			mapInput: (params) => params.question,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "run_researcher", arguments: '{"question":"What is X?"}' },
					},
				],
			},
			{ content: "Final parent answer", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "orchestrator",
			model: parentModel,
			subagents: [sa],
		});

		const { stream: parentStream, result } = stream(parentAgent, "Ask the researcher");

		const events: StreamEvent[] = [];
		for await (const event of parentStream) {
			events.push(event);
		}

		const finalResult = await result;
		expect(finalResult.output).toBe("Final parent answer");

		// Verify subagent_start
		const startEvents = events.filter((e) => e.type === "subagent_start");
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]!.type === "subagent_start" && startEvents[0]!.agentName).toBe(
			"researcher",
		);

		// Verify subagent_delta
		const deltaEvents = events.filter((e) => e.type === "subagent_delta");
		expect(deltaEvents.length).toBeGreaterThan(0);
		expect(deltaEvents[0]!.type === "subagent_delta" && deltaEvents[0]!.agentName).toBe(
			"researcher",
		);
		expect(deltaEvents[0]!.type === "subagent_delta" && deltaEvents[0]!.content).toBe(
			"Child response text",
		);

		// Verify subagent_end
		const endEvents = events.filter((e) => e.type === "subagent_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]!.type === "subagent_end" && endEvents[0]!.agentName).toBe("researcher");
		expect(endEvents[0]!.type === "subagent_end" && endEvents[0]!.result).toBe(
			"Child response text",
		);

		// Verify ordering: subagent events come between first done and second done
		const eventTypes = events.map((e) => e.type);
		const firstDone = eventTypes.indexOf("done");
		const subagentStart = eventTypes.indexOf("subagent_start");
		const subagentEnd = eventTypes.indexOf("subagent_end");
		const secondDone = eventTypes.lastIndexOf("done");

		expect(firstDone).toBeLessThan(subagentStart);
		expect(subagentStart).toBeLessThan(subagentEnd);
		expect(subagentEnd).toBeLessThan(secondDone);
	});

	test("subagent with multi-turn child relays only content_delta as subagent_delta", async () => {
		const childModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "ctc1",
						type: "function",
						function: { name: "lookup", arguments: '{"term":"foo"}' },
					},
				],
			},
			{ content: "Found: foo is bar", toolCalls: [] },
		]);

		const lookupTool = tool({
			name: "lookup",
			description: "Lookup a term",
			parameters: z.object({ term: z.string() }),
			execute: async (_ctx, p) => `Definition of ${p.term}`,
		});

		const childAgent = new Agent({
			name: "lookup_agent",
			model: childModel,
			tools: [lookupTool],
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
					{
						id: "tc1",
						type: "function",
						function: { name: "run_lookup_agent", arguments: '{"q":"what is foo"}' },
					},
				],
			},
			{ content: "Answer from child", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const { stream: parentStream, result } = stream(parentAgent, "test");

		const events: StreamEvent[] = [];
		for await (const event of parentStream) {
			events.push(event);
		}

		await result;

		// Should have subagent events
		const subagentEvents = events.filter(
			(e) =>
				e.type === "subagent_start" || e.type === "subagent_delta" || e.type === "subagent_end",
		);
		expect(subagentEvents.length).toBeGreaterThanOrEqual(3);

		// subagent_delta should only forward content_delta, not tool_call events from child
		const deltas = events.filter((e) => e.type === "subagent_delta");
		// The child's first turn has no content (tool call only), second turn has "Found: foo is bar"
		expect(deltas).toHaveLength(1);
		expect(deltas[0]!.type === "subagent_delta" && deltas[0]!.content).toBe("Found: foo is bar");
	});

	test("non-streaming run() path still works without onStreamEvent", async () => {
		// Verify backward compatibility: run() doesn't break when subagents have no onStreamEvent
		const { run } = await import("../../src/core/run");

		const childModel = mockModel([{ content: "child result", toolCalls: [] }]);
		const childAgent = new Agent({ name: "child", model: childModel });

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "run_child", arguments: '{"q":"hi"}' },
					},
				],
			},
			{ content: "parent done", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const result = await run(parentAgent, "test");
		expect(result.output).toBe("parent done");
	});

	test("error in streaming subagent still returns error as tool message", async () => {
		const childModel: Model = {
			async getResponse() {
				throw new Error("Child streaming failed");
			},
			async *getStreamedResponse() {
				throw new Error("Child streaming failed");
			},
		};

		const childAgent = new Agent({ name: "failing_child", model: childModel });

		const sa = subagent({
			agent: childAgent,
			inputSchema: z.object({ q: z.string() }),
			mapInput: (params) => params.q,
		});

		const parentModel = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "run_failing_child", arguments: '{"q":"hi"}' },
					},
				],
			},
			{ content: "Handled gracefully", toolCalls: [] },
		]);

		const parentAgent = new Agent({
			name: "parent",
			model: parentModel,
			subagents: [sa],
		});

		const { stream: parentStream, result } = stream(parentAgent, "test");

		const events: StreamEvent[] = [];
		for await (const event of parentStream) {
			events.push(event);
		}

		const finalResult = await result;
		expect(finalResult.output).toBe("Handled gracefully");

		// The error message should be in the messages
		const toolMsg = finalResult.messages.find(
			(m) => m.role === "tool" && m.content.includes("Error in sub-agent"),
		);
		expect(toolMsg).toBeDefined();
	});
});
