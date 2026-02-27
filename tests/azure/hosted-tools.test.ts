import { describe, expect, test } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { StratusError } from "../../src/core/errors";

describe("AzureChatCompletionsModel hosted tool rejection", () => {
	test("throws StratusError when hosted tool is provided", async () => {
		const model = new AzureChatCompletionsModel({
			endpoint: "https://example.openai.azure.com",
			apiKey: "test-key",
			deployment: "gpt-4o",
		});

		try {
			await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
				tools: [{ type: "web_search_preview" }],
			});
			expect(true).toBe(false); // should not reach
		} catch (error) {
			expect(error).toBeInstanceOf(StratusError);
			expect((error as StratusError).message).toContain("Hosted tools");
			expect((error as StratusError).message).toContain("AzureResponsesModel");
		}
	});

	test("throws on stream when hosted tool is provided", async () => {
		const model = new AzureChatCompletionsModel({
			endpoint: "https://example.openai.azure.com",
			apiKey: "test-key",
			deployment: "gpt-4o",
		});

		try {
			const gen = model.getStreamedResponse({
				messages: [{ role: "user", content: "Hello" }],
				tools: [{ type: "web_search_preview" }],
			});
			// Need to iterate to trigger the body execution
			for await (const _event of gen) {
				// should throw before yielding
			}
			expect(true).toBe(false);
		} catch (error) {
			expect(error).toBeInstanceOf(StratusError);
		}
	});
});

describe("AzureResponsesModel toolChoice conversion", () => {
	test("toolChoice string values pass through", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				}),
				{ status: 200 },
			);
		};

		try {
			const model = new AzureResponsesModel({
				endpoint: "https://example.openai.azure.com",
				apiKey: "test-key",
				deployment: "gpt-4o",
			});

			await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
				modelSettings: { toolChoice: "required" },
			});

			expect(capturedBody?.tool_choice).toBe("required");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("toolChoice object converted from Chat Completions to Responses format", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				}),
				{ status: 200 },
			);
		};

		try {
			const model = new AzureResponsesModel({
				endpoint: "https://example.openai.azure.com",
				apiKey: "test-key",
				deployment: "gpt-4o",
			});

			await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
				tools: [
					{
						type: "function",
						function: {
							name: "greet",
							description: "Greet",
							parameters: { type: "object", properties: {} },
						},
					},
				],
				modelSettings: {
					toolChoice: { type: "function", function: { name: "greet" } },
				},
			});

			// Responses API format: { type: "function", name: "greet" }
			expect(capturedBody?.tool_choice).toEqual({ type: "function", name: "greet" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("hosted tool definitions pass through without flattening", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				}),
				{ status: 200 },
			);
		};

		try {
			const model = new AzureResponsesModel({
				endpoint: "https://example.openai.azure.com",
				apiKey: "test-key",
				deployment: "gpt-4o",
			});

			await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
				tools: [
					{ type: "web_search_preview" },
					{
						type: "function",
						function: {
							name: "greet",
							description: "Greet",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			});

			const tools = capturedBody?.tools as Record<string, unknown>[];
			// Hosted tool passed through as-is
			expect(tools[0]).toEqual({ type: "web_search_preview" });
			// Function tool flattened (no .function wrapper)
			expect(tools[1]).toHaveProperty("name", "greet");
			expect(tools[1]).not.toHaveProperty("function");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("previous_response_id included in request body when store is true", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					id: "resp_xyz",
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				}),
				{ status: 200 },
			);
		};

		try {
			const model = new AzureResponsesModel({
				endpoint: "https://example.openai.azure.com",
				apiKey: "test-key",
				deployment: "gpt-4o",
				store: true,
			});

			await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
				previousResponseId: "resp_prev",
			});

			expect(capturedBody?.previous_response_id).toBe("resp_prev");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("previous_response_id NOT included when store is false", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					id: "resp_xyz",
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				}),
				{ status: 200 },
			);
		};

		try {
			const model = new AzureResponsesModel({
				endpoint: "https://example.openai.azure.com",
				apiKey: "test-key",
				deployment: "gpt-4o",
			});

			await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
				previousResponseId: "resp_prev",
			});

			expect(capturedBody?.previous_response_id).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("responseId extracted from non-streaming response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			return new Response(
				JSON.stringify({
					id: "resp_abc123",
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				}),
				{ status: 200 },
			);
		};

		try {
			const model = new AzureResponsesModel({
				endpoint: "https://example.openai.azure.com",
				apiKey: "test-key",
				deployment: "gpt-4o",
			});

			const response = await model.getResponse({
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(response.responseId).toBe("resp_abc123");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
