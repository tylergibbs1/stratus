import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { ContentFilterError, ModelError } from "../../src/core/errors";
import type { StreamEvent } from "../../src/core/model";

const originalFetch = globalThis.fetch;

function mockFetch(response: {
	ok?: boolean;
	status?: number;
	statusText?: string;
	json?: unknown;
	body?: ReadableStream<Uint8Array>;
	text?: string;
}) {
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock(() =>
		Promise.resolve({
			ok: response.ok ?? true,
			status: response.status ?? 200,
			statusText: response.statusText ?? "OK",
			json: () => Promise.resolve(response.json),
			text: () => Promise.resolve(response.text ?? ""),
			body: response.body ?? null,
			headers: new Headers(),
		} as Response),
	);
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${event}\n\n`));
			}
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
}

describe("AzureChatCompletionsModel", () => {
	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const config = {
		endpoint: "https://test.openai.azure.com",
		apiKey: "test-key",
		deployment: "gpt-5-chat",
	};

	test("getResponse parses a simple response", async () => {
		mockFetch({
			json: {
				choices: [
					{
						message: { role: "assistant", content: "Hello!" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureChatCompletionsModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.content).toBe("Hello!");
		expect(result.toolCalls).toHaveLength(0);
		expect(result.usage?.totalTokens).toBe(15);
	});

	test("getResponse parses tool calls", async () => {
		mockFetch({
			json: {
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "tc1",
									type: "function",
									function: { name: "get_weather", arguments: '{"city":"NYC"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		});

		const model = new AzureChatCompletionsModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Weather?" }],
		});

		expect(result.content).toBeNull();
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]!.function.name).toBe("get_weather");
	});

	test("getResponse throws on content filter", async () => {
		mockFetch({
			json: {
				choices: [
					{
						message: { role: "assistant", content: null },
						finish_reason: "content_filter",
					},
				],
			},
		});

		const model = new AzureChatCompletionsModel(config);
		expect(model.getResponse({ messages: [{ role: "user", content: "test" }] })).rejects.toThrow(
			ContentFilterError,
		);
	});

	test("getResponse throws ModelError on HTTP error", async () => {
		mockFetch({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: "Something went wrong",
		});

		const model = new AzureChatCompletionsModel(config);
		expect(model.getResponse({ messages: [{ role: "user", content: "test" }] })).rejects.toThrow(
			ModelError,
		);
	});

	test("getStreamedResponse yields events", async () => {
		mockFetch({
			body: sseStream([
				JSON.stringify({
					choices: [{ delta: { role: "assistant" }, index: 0 }],
				}),
				JSON.stringify({
					choices: [{ delta: { content: "Hello" }, index: 0 }],
				}),
				JSON.stringify({
					choices: [{ delta: { content: " world" }, index: 0 }],
				}),
				JSON.stringify({
					choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				}),
			]),
		});

		const model = new AzureChatCompletionsModel(config);
		const events: StreamEvent[] = [];
		for await (const event of model.getStreamedResponse({
			messages: [{ role: "user", content: "Hi" }],
		})) {
			events.push(event);
		}

		const contentDeltas = events.filter((e) => e.type === "content_delta");
		expect(contentDeltas).toHaveLength(2);

		const done = events.find((e) => e.type === "done");
		expect(done).toBeDefined();
		if (done?.type === "done") {
			expect(done.response.content).toBe("Hello world");
			expect(done.response.usage?.totalTokens).toBe(15);
		}
	});

	test("getStreamedResponse handles tool calls", async () => {
		mockFetch({
			body: sseStream([
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "tc1",
										type: "function",
										function: { name: "greet", arguments: "" },
									},
								],
							},
							index: 0,
						},
					],
				}),
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '{"name":' } }],
							},
							index: 0,
						},
					],
				}),
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '"World"}' } }],
							},
							index: 0,
						},
					],
				}),
				JSON.stringify({
					choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
				}),
			]),
		});

		const model = new AzureChatCompletionsModel(config);
		const events: StreamEvent[] = [];
		for await (const event of model.getStreamedResponse({
			messages: [{ role: "user", content: "Hi" }],
		})) {
			events.push(event);
		}

		expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
		expect(events.some((e) => e.type === "tool_call_delta")).toBe(true);
		expect(events.some((e) => e.type === "tool_call_done")).toBe(true);

		const done = events.find((e) => e.type === "done");
		if (done?.type === "done") {
			expect(done.response.toolCalls).toHaveLength(1);
			expect(done.response.toolCalls[0]!.function.arguments).toBe('{"name":"World"}');
		}
	});

	test("sends correct URL and headers", async () => {
		mockFetch({
			json: {
				choices: [
					{
						message: { role: "assistant", content: "ok" },
						finish_reason: "stop",
					},
				],
			},
		});

		const model = new AzureChatCompletionsModel(config);
		await model.getResponse({ messages: [{ role: "user", content: "test" }] });

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [url, options] = fetchMock.mock.calls[0]!;

		expect(url).toContain("test.openai.azure.com");
		expect(url).toContain("deployments/gpt-5-chat");
		expect(url).toContain("api-version=");
		expect((options.headers as Record<string, string>)["api-key"]).toBe("test-key");
	});
});
