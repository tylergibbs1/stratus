import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { StratusError } from "../../src/core/errors";

const originalFetch = globalThis.fetch;

const minimalChatResponse = {
	choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const minimalResponsesResponse = {
	id: "resp_1",
	status: "completed",
	output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
	usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

function captureHeaders(): { getHeaders: () => Headers | undefined } {
	let captured: Headers | undefined;
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock((_url: string, init: RequestInit) => {
		captured = new Headers(init.headers as HeadersInit);
		return Promise.resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve(minimalChatResponse),
			text: () => Promise.resolve(""),
			body: null,
			headers: new Headers(),
		} as Response);
	});
	return { getHeaders: () => captured };
}

function captureHeadersResponses(): { getHeaders: () => Headers | undefined } {
	let captured: Headers | undefined;
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock((_url: string, init: RequestInit) => {
		captured = new Headers(init.headers as HeadersInit);
		return Promise.resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: () => Promise.resolve(minimalResponsesResponse),
			text: () => Promise.resolve(""),
			body: null,
			headers: new Headers(),
		} as Response);
	});
	return { getHeaders: () => captured };
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("AzureChatCompletionsModel auth", () => {
	const baseConfig = { endpoint: "https://test.openai.azure.com", deployment: "gpt-4" };

	test("sends api-key header when apiKey is provided", async () => {
		const { getHeaders } = captureHeaders();
		const model = new AzureChatCompletionsModel({ ...baseConfig, apiKey: "test-key" });

		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });

		const headers = getHeaders()!;
		expect(headers.get("api-key")).toBe("test-key");
		expect(headers.get("authorization")).toBeNull();
	});

	test("sends Authorization bearer header when tokenProvider is provided", async () => {
		const { getHeaders } = captureHeaders();
		const provider = mock(() => Promise.resolve("entra-token-123"));
		const model = new AzureChatCompletionsModel({
			...baseConfig,
			azureAdTokenProvider: provider,
		});

		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });

		const headers = getHeaders()!;
		expect(headers.get("authorization")).toBe("Bearer entra-token-123");
		expect(headers.get("api-key")).toBeNull();
	});

	test("calls token provider on each request", async () => {
		let callCount = 0;
		const provider = mock(async () => {
			callCount++;
			return `token-${callCount}`;
		});
		const model = new AzureChatCompletionsModel({
			...baseConfig,
			azureAdTokenProvider: provider,
		});

		const { getHeaders: _getHeaders1 } = captureHeaders();
		// Override to use responses model response for second call
		// @ts-expect-error -- mock
		globalThis.fetch = mock((_url: string, _init: RequestInit) => {
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve(minimalChatResponse),
				text: () => Promise.resolve(""),
				body: null,
				headers: new Headers(),
			} as Response);
		});

		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });
		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });

		expect(provider).toHaveBeenCalledTimes(2);
	});

	test("throws if neither apiKey nor azureAdTokenProvider is provided", () => {
		expect(() => new AzureChatCompletionsModel(baseConfig as any)).toThrow(StratusError);
		expect(() => new AzureChatCompletionsModel(baseConfig as any)).toThrow(
			"Provide either apiKey or azureAdTokenProvider",
		);
	});

	test("throws if both apiKey and azureAdTokenProvider are provided", () => {
		expect(
			() =>
				new AzureChatCompletionsModel({
					...baseConfig,
					apiKey: "key",
					azureAdTokenProvider: async () => "token",
				}),
		).toThrow(StratusError);
		expect(
			() =>
				new AzureChatCompletionsModel({
					...baseConfig,
					apiKey: "key",
					azureAdTokenProvider: async () => "token",
				}),
		).toThrow("not both");
	});
});

describe("AzureResponsesModel auth", () => {
	const baseConfig = { endpoint: "https://test.openai.azure.com", deployment: "gpt-4" };

	test("sends api-key header when apiKey is provided", async () => {
		const { getHeaders } = captureHeadersResponses();
		const model = new AzureResponsesModel({ ...baseConfig, apiKey: "test-key" });

		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });

		const headers = getHeaders()!;
		expect(headers.get("api-key")).toBe("test-key");
		expect(headers.get("authorization")).toBeNull();
	});

	test("sends Authorization bearer header when tokenProvider is provided", async () => {
		const { getHeaders } = captureHeadersResponses();
		const provider = mock(() => Promise.resolve("entra-token-456"));
		const model = new AzureResponsesModel({
			...baseConfig,
			azureAdTokenProvider: provider,
		});

		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });

		const headers = getHeaders()!;
		expect(headers.get("authorization")).toBe("Bearer entra-token-456");
		expect(headers.get("api-key")).toBeNull();
	});

	test("calls token provider on each request", async () => {
		const provider = mock(async () => "token");
		const model = new AzureResponsesModel({
			...baseConfig,
			azureAdTokenProvider: provider,
		});

		// @ts-expect-error -- mock
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve(minimalResponsesResponse),
				text: () => Promise.resolve(""),
				body: null,
				headers: new Headers(),
			} as Response),
		);

		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });
		await model.getResponse({ messages: [{ role: "user", content: "hi" }] });

		expect(provider).toHaveBeenCalledTimes(2);
	});

	test("throws if neither apiKey nor azureAdTokenProvider is provided", () => {
		expect(() => new AzureResponsesModel(baseConfig as any)).toThrow(StratusError);
		expect(() => new AzureResponsesModel(baseConfig as any)).toThrow(
			"Provide either apiKey or azureAdTokenProvider",
		);
	});

	test("throws if both apiKey and azureAdTokenProvider are provided", () => {
		expect(
			() =>
				new AzureResponsesModel({
					...baseConfig,
					apiKey: "key",
					azureAdTokenProvider: async () => "token",
				}),
		).toThrow(StratusError);
		expect(
			() =>
				new AzureResponsesModel({
					...baseConfig,
					apiKey: "key",
					azureAdTokenProvider: async () => "token",
				}),
		).toThrow("not both");
	});
});
