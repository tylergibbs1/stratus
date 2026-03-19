import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { ContentFilterError, ModelError } from "../../src/core/errors";

const originalFetch = globalThis.fetch;

function mockFetch(response: {
	ok?: boolean;
	status?: number;
	statusText?: string;
	json?: unknown;
	text?: string;
	headers?: Headers;
}) {
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock(() =>
		Promise.resolve({
			ok: response.ok ?? true,
			status: response.status ?? 200,
			statusText: response.statusText ?? "OK",
			json: () => Promise.resolve(response.json),
			text: () => Promise.resolve(response.text ?? ""),
			body: null,
			headers: response.headers ?? new Headers(),
		} as Response),
	);
}

function mockFetchSequence(
	responses: Array<{
		ok?: boolean;
		status?: number;
		statusText?: string;
		json?: unknown;
		text?: string;
		headers?: Headers;
	}>,
) {
	let callIndex = 0;
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock(() => {
		const response = responses[callIndex++] ?? responses[responses.length - 1]!;
		return Promise.resolve({
			ok: response.ok ?? true,
			status: response.status ?? 200,
			statusText: response.statusText ?? "OK",
			json: () => Promise.resolve(response.json),
			text: () => Promise.resolve(response.text ?? ""),
			body: null,
			headers: response.headers ?? new Headers(),
		} as Response);
	});
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const chatConfig = {
	endpoint: "https://test.openai.azure.com",
	apiKey: "test-key",
	deployment: "gpt-5-chat",
};

const responsesConfig = {
	endpoint: "https://test.openai.azure.com",
	apiKey: "test-key",
	deployment: "gpt-5-chat",
};

describe("AzureChatCompletionsModel error handling", () => {
	test("429 triggers retry and succeeds on subsequent attempt", async () => {
		mockFetchSequence([
			{
				ok: false,
				status: 429,
				text: "Rate limited",
				headers: new Headers({ "retry-after-ms": "1" }),
			},
			{
				ok: true,
				json: {
					choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				},
			},
		]);

		const model = new AzureChatCompletionsModel(chatConfig);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.content).toBe("Hello!");
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	test("401 throws ModelError with status", async () => {
		mockFetch({
			ok: false,
			status: 401,
			text: '{"error":{"code":"Unauthorized","message":"Invalid API key"}}',
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		try {
			await model.getResponse({ messages: [{ role: "user", content: "Hi" }] });
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelError);
			expect((error as ModelError).status).toBe(401);
		}
	});

	test("503 exhausts retries and throws ModelError", async () => {
		mockFetch({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			text: "",
			headers: new Headers({ "retry-after-ms": "1" }),
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		try {
			await model.getResponse({ messages: [{ role: "user", content: "Hi" }] });
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelError);
			expect((error as ModelError).status).toBe(503);
			expect((error as ModelError).message).toContain("503");
		}
	});

	test("400 with content_filter code throws ContentFilterError", async () => {
		mockFetch({
			ok: false,
			status: 400,
			text: JSON.stringify({
				error: { code: "content_filter", message: "Content was filtered" },
			}),
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		await expect(
			model.getResponse({ messages: [{ role: "user", content: "Hi" }] }),
		).rejects.toThrow(ContentFilterError);
	});

	test("400 with non-filter code throws ModelError", async () => {
		mockFetch({
			ok: false,
			status: 400,
			text: JSON.stringify({
				error: { code: "invalid_request", message: "Bad request" },
			}),
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		try {
			await model.getResponse({ messages: [{ role: "user", content: "Hi" }] });
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelError);
			expect(error).not.toBeInstanceOf(ContentFilterError);
			expect((error as ModelError).status).toBe(400);
		}
	});

	test("malformed JSON error body still throws ModelError", async () => {
		mockFetch({
			ok: false,
			status: 400,
			text: "This is not JSON",
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		try {
			await model.getResponse({ messages: [{ role: "user", content: "Hi" }] });
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelError);
			expect((error as ModelError).message).toContain("400");
		}
	});

	test("response with no choices throws ModelError", async () => {
		mockFetch({
			json: { choices: [] },
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		await expect(
			model.getResponse({ messages: [{ role: "user", content: "Hi" }] }),
		).rejects.toThrow(ModelError);
	});

	test("429 exhausts all retries and throws", async () => {
		mockFetchSequence([
			{
				ok: false,
				status: 429,
				text: "Rate limited",
				headers: new Headers({ "retry-after-ms": "1" }),
			},
			{
				ok: false,
				status: 429,
				text: "Rate limited",
				headers: new Headers({ "retry-after-ms": "1" }),
			},
			{
				ok: false,
				status: 429,
				text: "Rate limited",
				headers: new Headers({ "retry-after-ms": "1" }),
			},
			{
				ok: false,
				status: 429,
				text: "Rate limited",
				headers: new Headers({ "retry-after-ms": "1" }),
			},
		]);

		const model = new AzureChatCompletionsModel(chatConfig);
		await expect(
			model.getResponse({ messages: [{ role: "user", content: "Hi" }] }),
		).rejects.toThrow(ModelError);
	});

	test("missing usage field returns undefined usage", async () => {
		mockFetch({
			json: {
				choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
				// No usage field
			},
		});

		const model = new AzureChatCompletionsModel(chatConfig);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.content).toBe("Hello!");
		expect(result.usage).toBeUndefined();
	});
});

describe("AzureResponsesModel error handling", () => {
	test("429 triggers retry and succeeds", async () => {
		mockFetchSequence([
			{
				ok: false,
				status: 429,
				text: "Rate limited",
				headers: new Headers({ "retry-after-ms": "1" }),
			},
			{
				ok: true,
				json: {
					id: "resp_1",
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "Hello!" }] }],
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				},
			},
		]);

		const model = new AzureResponsesModel(responsesConfig);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.content).toBe("Hello!");
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	test("401 throws ModelError", async () => {
		mockFetch({
			ok: false,
			status: 401,
			text: '{"error":{"code":"Unauthorized","message":"Invalid key"}}',
		});

		const model = new AzureResponsesModel(responsesConfig);
		try {
			await model.getResponse({ messages: [{ role: "user", content: "Hi" }] });
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelError);
			expect((error as ModelError).status).toBe(401);
		}
	});

	test("400 with content_filter throws ContentFilterError", async () => {
		mockFetch({
			ok: false,
			status: 400,
			text: JSON.stringify({
				error: { code: "content_filter", message: "Filtered" },
			}),
		});

		const model = new AzureResponsesModel(responsesConfig);
		await expect(
			model.getResponse({ messages: [{ role: "user", content: "Hi" }] }),
		).rejects.toThrow(ContentFilterError);
	});

	test("incomplete response returns length finishReason", async () => {
		mockFetch({
			json: {
				id: "resp_1",
				status: "incomplete",
				output: [{ type: "message", content: [{ type: "output_text", text: "Partial..." }] }],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(responsesConfig);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.content).toBe("Partial...");
		expect(result.finishReason).toBe("length");
	});

	test("responseId is returned in response", async () => {
		mockFetch({
			json: {
				id: "resp_abc123",
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "Hello!" }] }],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(responsesConfig);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.responseId).toBe("resp_abc123");
	});
});
