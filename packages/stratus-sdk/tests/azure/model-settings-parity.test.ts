import { describe, expect, mock, test } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";

// Helper to capture the fetch body
function mockFetchReturning(responseBody: unknown) {
	return mock(() =>
		Promise.resolve(
			new Response(JSON.stringify(responseBody), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
}

describe("AzureChatCompletionsModel new settings", () => {
	test("sends prediction field", async () => {
		const fetchFn = mockFetchReturning({
			choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		globalThis.fetch = fetchFn as any;

		const model = new AzureChatCompletionsModel({
			endpoint: "https://test.openai.azure.com",
			deployment: "gpt-4o",
			apiKey: "test-key",
			apiVersion: "2024-12-01-preview",
		});

		await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
			modelSettings: {
				prediction: { type: "content", content: "predicted output" },
			},
		});

		const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
		expect(body.prediction).toEqual({ type: "content", content: "predicted output" });
	});

	test("sends modalities and audio config", async () => {
		const fetchFn = mockFetchReturning({
			choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		globalThis.fetch = fetchFn as any;

		const model = new AzureChatCompletionsModel({
			endpoint: "https://test.openai.azure.com",
			deployment: "gpt-4o-audio",
			apiKey: "test-key",
			apiVersion: "2024-12-01-preview",
		});

		await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
			modelSettings: {
				modalities: ["text", "audio"],
				audio: { voice: "alloy", format: "mp3" },
			},
		});

		const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
		expect(body.modalities).toEqual(["text", "audio"]);
		expect(body.audio).toEqual({ voice: "alloy", format: "mp3" });
	});

	test("sends data_sources", async () => {
		const fetchFn = mockFetchReturning({
			choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		globalThis.fetch = fetchFn as any;

		const model = new AzureChatCompletionsModel({
			endpoint: "https://test.openai.azure.com",
			deployment: "gpt-4o",
			apiKey: "test-key",
			apiVersion: "2024-10-21",
		});

		const ds = {
			type: "azure_search",
			parameters: { endpoint: "https://search.example.com", index_name: "my-index" },
		};

		await model.getResponse({
			messages: [{ role: "user", content: "Search" }],
			modelSettings: { dataSources: [ds] },
		});

		const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
		expect(body.data_sources).toEqual([ds]);
	});

	test("does not send prediction when not set", async () => {
		const fetchFn = mockFetchReturning({
			choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		globalThis.fetch = fetchFn as any;

		const model = new AzureChatCompletionsModel({
			endpoint: "https://test.openai.azure.com",
			deployment: "gpt-4o",
			apiKey: "test-key",
			apiVersion: "2024-12-01-preview",
		});

		await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
			modelSettings: { temperature: 0.5 },
		});

		const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
		expect(body.prediction).toBeUndefined();
		expect(body.modalities).toBeUndefined();
		expect(body.audio).toBeUndefined();
		expect(body.data_sources).toBeUndefined();
	});
});

describe("AzureResponsesModel context management", () => {
	test("sends context_management field", async () => {
		const fetchFn = mockFetchReturning({
			id: "resp-1",
			status: "completed",
			output: [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		});
		globalThis.fetch = fetchFn as any;

		const model = new AzureResponsesModel({
			endpoint: "https://test.openai.azure.com",
			deployment: "gpt-4o",
			apiKey: "test-key",
		});

		await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
			modelSettings: {
				contextManagement: [{ type: "truncation", truncation_strategy: "auto" }],
			},
		});

		const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
		expect(body.context_management).toEqual([
			{ type: "truncation", truncation_strategy: "auto" },
		]);
	});

	test("does not send context_management when not set", async () => {
		const fetchFn = mockFetchReturning({
			id: "resp-1",
			status: "completed",
			output: [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		});
		globalThis.fetch = fetchFn as any;

		const model = new AzureResponsesModel({
			endpoint: "https://test.openai.azure.com",
			deployment: "gpt-4o",
			apiKey: "test-key",
		});

		await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
			modelSettings: { temperature: 0.5 },
		});

		const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
		expect(body.context_management).toBeUndefined();
	});
});
