import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
import { tool } from "../../src/core/tool";

describe("tool_choice", () => {
	test("tool_choice passed through in model request", async () => {
		let capturedRequest: ModelRequest | undefined;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequest = request;
				return { content: "Done", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: { toolChoice: "required" },
			tools: [
				tool({
					name: "greet",
					description: "Greet",
					parameters: z.object({ name: z.string() }),
					execute: async () => "hi",
				}),
			],
		});

		await run(agent, "Hi");
		expect(capturedRequest?.modelSettings?.toolChoice).toBe("required");
	});

	test("specific function tool_choice", async () => {
		let capturedRequest: ModelRequest | undefined;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequest = request;
				return { content: "Done", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const agent = new Agent({
			name: "test",
			model,
			modelSettings: {
				toolChoice: { type: "function", function: { name: "greet" } },
			},
			tools: [
				tool({
					name: "greet",
					description: "Greet",
					parameters: z.object({ name: z.string() }),
					execute: async () => "hi",
				}),
			],
		});

		await run(agent, "Hi");
		expect(capturedRequest?.modelSettings?.toolChoice).toEqual({
			type: "function",
			function: { name: "greet" },
		});
	});
});

describe("toolUseBehavior", () => {
	test("stop_on_first_tool returns tool output directly", async () => {
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				return {
					content: null,
					toolCalls: [
						{
							id: "tc1",
							type: "function",
							function: { name: "extract", arguments: '{"data":"hello"}' },
						},
					],
				};
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield {
					type: "done",
					response: {
						content: null,
						toolCalls: [
							{
								id: "tc1",
								type: "function",
								function: { name: "extract", arguments: '{"data":"hello"}' },
							},
						],
					},
				};
			},
		};

		const extractTool = tool({
			name: "extract",
			description: "Extract data",
			parameters: z.object({ data: z.string() }),
			execute: async (_ctx, { data }) => `extracted: ${data}`,
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [extractTool],
			toolUseBehavior: "stop_on_first_tool",
		});

		const result = await run(agent, "Extract something");
		// Should return the tool output, not call the model again
		expect(result.output).toBe("extracted: hello");
	});

	test("stopAtToolNames stops only for specified tools", async () => {
		let modelCallCount = 0;
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				modelCallCount++;
				if (modelCallCount === 1) {
					return {
						content: null,
						toolCalls: [
							{
								id: "tc1",
								type: "function",
								function: { name: "save_data", arguments: '{"value":"test"}' },
							},
						],
					};
				}
				return { content: "Saved!", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Saved!", toolCalls: [] } };
			},
		};

		const saveTool = tool({
			name: "save_data",
			description: "Save data",
			parameters: z.object({ value: z.string() }),
			execute: async (_ctx, { value }) => `saved: ${value}`,
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [saveTool],
			toolUseBehavior: { stopAtToolNames: ["save_data"] },
		});

		const result = await run(agent, "Save this");
		expect(result.output).toBe("saved: test");
		expect(modelCallCount).toBe(1); // Model called once, then stopped
	});

	test("run_llm_again is default behavior", async () => {
		let modelCallCount = 0;
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				modelCallCount++;
				if (modelCallCount === 1) {
					return {
						content: null,
						toolCalls: [
							{
								id: "tc1",
								type: "function",
								function: { name: "fetch_data", arguments: "{}" },
							},
						],
					};
				}
				return { content: "Result from model", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "ok", toolCalls: [] } };
			},
		};

		const fetchTool = tool({
			name: "fetch_data",
			description: "Fetch",
			parameters: z.object({}),
			execute: async () => "data",
		});

		const agent = new Agent({
			name: "test",
			model,
			tools: [fetchTool],
		});

		const result = await run(agent, "Fetch");
		expect(result.output).toBe("Result from model");
		expect(modelCallCount).toBe(2); // Model called twice (tool call + final response)
	});
});

describe("stream returns result", () => {
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

	test("stream().result resolves to RunResult", async () => {
		const { stream } = await import("../../src/core/run");
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const agent = new Agent({ name: "test", model });

		const { stream: eventStream, result: resultPromise } = stream(agent, "Hi");

		// Must consume the stream for result to resolve
		const events: StreamEvent[] = [];
		for await (const event of eventStream) {
			events.push(event);
		}

		const result = await resultPromise;
		expect(result.output).toBe("Hello!");
		expect(result.lastAgent.name).toBe("test");
		expect(result.messages.length).toBeGreaterThan(0);
	});

	test("stream().result includes lastAgent after handoff", async () => {
		const { stream } = await import("../../src/core/run");
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{ id: "tc1", type: "function", function: { name: "transfer_to_agent_b", arguments: "{}" } },
				],
			},
			{ content: "From B", toolCalls: [] },
		]);

		const agentB = new Agent({ name: "agent_b", model });
		const agentA = new Agent({ name: "agent_a", model, handoffs: [agentB] });

		const { stream: eventStream, result: resultPromise } = stream(agentA, "Transfer");

		for await (const _event of eventStream) {
			// consume
		}

		const result = await resultPromise;
		expect(result.output).toBe("From B");
		expect(result.lastAgent.name).toBe("agent_b");
	});
});
