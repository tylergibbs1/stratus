import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { webSearchTool } from "../../src/core/builtin-tools";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { stream, run } from "../../src/core/run";
import { tool } from "../../src/core/tool";

describe("hosted tools in run loop", () => {
	test("hosted tool definitions passed through to model request", async () => {
		let capturedRequest: ModelRequest | undefined;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequest = request;
				return { content: "Search result", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const agent = new Agent({
			name: "search-agent",
			model,
			tools: [webSearchTool()],
		});

		await run(agent, "What is the weather?");
		expect(capturedRequest?.tools).toEqual([{ type: "web_search_preview" }]);
	});

	test("mixed function and hosted tools in request", async () => {
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

		const greetTool = tool({
			name: "greet",
			description: "Greet someone",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => `Hello, ${params.name}`,
		});

		const agent = new Agent({
			name: "mixed-agent",
			model,
			tools: [webSearchTool(), greetTool],
		});

		await run(agent, "Hi");
		expect(capturedRequest?.tools).toHaveLength(2);
		// First tool is hosted (no function property)
		expect(capturedRequest?.tools?.[0]).toEqual({ type: "web_search_preview" });
		// Second tool is a function tool definition
		expect(capturedRequest?.tools?.[1]).toHaveProperty("function");
	});

	test("hosted tool calls are reported as unknown (server-side execution)", async () => {
		let callCount = 0;
		const model: Model = {
			async getResponse(_request: ModelRequest): Promise<ModelResponse> {
				callCount++;
				if (callCount === 1) {
					// Model tries to call a hosted tool — but we won't find it locally
					return {
						content: null,
						toolCalls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "web_search_preview", arguments: "{}" },
							},
						],
					};
				}
				return { content: "Final answer", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const agent = new Agent({
			name: "search-agent",
			model,
			tools: [webSearchTool()],
		});

		// Hosted tools won't be in toolsByName, so they'll get "Unknown tool" error
		const result = await run(agent, "Search something");
		expect(result.output).toBe("Final answer");
	});

	test("responseId tracked from model response", async () => {
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				return {
					content: "Done",
					toolCalls: [],
					responseId: "resp_abc123",
				};
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield {
					type: "done",
					response: { content: "Done", toolCalls: [], responseId: "resp_abc123" },
				};
			},
		};

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");
		expect(result.responseId).toBe("resp_abc123");
	});

	test("previousResponseId forwarded on subsequent turns", async () => {
		const capturedRequests: ModelRequest[] = [];
		let callCount = 0;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequests.push(request);
				callCount++;
				if (callCount === 1) {
					return {
						content: null,
						toolCalls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "greet", arguments: '{"name":"World"}' },
							},
						],
						responseId: "resp_turn1",
					};
				}
				return { content: "Final", toolCalls: [], responseId: "resp_turn2" };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => `Hello, ${params.name}`,
		});

		const agent = new Agent({ name: "test", model, tools: [greetTool] });
		const result = await run(agent, "Hi");

		expect(capturedRequests[0]!.previousResponseId).toBeUndefined();
		expect(capturedRequests[1]!.previousResponseId).toBe("resp_turn1");
		expect(result.responseId).toBe("resp_turn2");
	});

	test("previousResponseId forwarded in stream mode", async () => {
		const capturedRequests: ModelRequest[] = [];
		let callCount = 0;
		const model: Model = {
			async getResponse(): Promise<ModelResponse> {
				return { content: "Done", toolCalls: [] };
			},
			async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
				capturedRequests.push(request);
				callCount++;
				if (callCount === 1) {
					yield {
						type: "done",
						response: {
							content: null,
							toolCalls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "greet", arguments: '{"name":"World"}' },
								},
							],
							responseId: "resp_s1",
						},
					};
				} else {
					yield {
						type: "done",
						response: { content: "Final", toolCalls: [], responseId: "resp_s2" },
					};
				}
			},
		};

		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => `Hello, ${params.name}`,
		});

		const agent = new Agent({ name: "test", model, tools: [greetTool] });
		const { stream: s, result: resultPromise } = stream(agent, "Hi");
		for await (const _event of s) {
			// drain
		}
		const result = await resultPromise;

		expect(capturedRequests[0]!.previousResponseId).toBeUndefined();
		expect(capturedRequests[1]!.previousResponseId).toBe("resp_s1");
		expect(result.responseId).toBe("resp_s2");
	});
});
