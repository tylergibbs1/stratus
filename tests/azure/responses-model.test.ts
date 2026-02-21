import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AzureResponsesModel } from "../../src/azure/responses-model";
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
			body: response.body ?? null,
			headers: response.headers ?? new Headers(),
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

describe("AzureResponsesModel", () => {
	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const config = {
		endpoint: "https://test.openai.azure.com",
		apiKey: "test-key",
		deployment: "gpt-5-responses",
	};

	test("getResponse parses a simple text response", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Hello!" }],
					},
				],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(result.content).toBe("Hello!");
		expect(result.toolCalls).toHaveLength(0);
		expect(result.usage?.promptTokens).toBe(10);
		expect(result.usage?.completionTokens).toBe(5);
		expect(result.usage?.totalTokens).toBe(15);
		expect(result.finishReason).toBe("stop");
	});

	test("getResponse parses tool calls (function_call items)", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "function_call",
						call_id: "tc1",
						name: "get_weather",
						arguments: '{"city":"NYC"}',
					},
				],
				usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Weather?" }],
		});

		expect(result.content).toBeNull();
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]!.id).toBe("tc1");
		expect(result.toolCalls[0]!.function.name).toBe("get_weather");
		expect(result.toolCalls[0]!.function.arguments).toBe('{"city":"NYC"}');
		expect(result.finishReason).toBe("tool_calls");
	});

	test("getResponse parses mixed text + tool calls", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Let me check." }],
					},
					{
						type: "function_call",
						call_id: "tc1",
						name: "get_weather",
						arguments: '{"city":"NYC"}',
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Weather?" }],
		});

		expect(result.content).toBe("Let me check.");
		expect(result.toolCalls).toHaveLength(1);
		expect(result.finishReason).toBe("tool_calls");
	});

	test("getResponse throws ContentFilterError on content_filter error code", async () => {
		mockFetch({
			ok: false,
			status: 400,
			text: JSON.stringify({
				error: { code: "content_filter", message: "Content filtered" },
			}),
		});

		const model = new AzureResponsesModel(config);
		expect(
			model.getResponse({ messages: [{ role: "user", content: "test" }] }),
		).rejects.toThrow(ContentFilterError);
	});

	test("getResponse throws ModelError on HTTP error", async () => {
		mockFetch({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: "Something went wrong",
		});

		const model = new AzureResponsesModel(config);
		expect(
			model.getResponse({ messages: [{ role: "user", content: "test" }] }),
		).rejects.toThrow(ModelError);
	});

	test("incomplete status maps to finishReason length", async () => {
		mockFetch({
			json: {
				status: "incomplete",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Partial..." }],
					},
				],
				usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(result.finishReason).toBe("length");
		expect(result.content).toBe("Partial...");
	});

	test("getStreamedResponse yields text events", async () => {
		mockFetch({
			body: sseStream([
				JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }),
				JSON.stringify({ type: "response.output_text.delta", delta: " world" }),
				JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					},
				}),
			]),
		});

		const model = new AzureResponsesModel(config);
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

	test("getStreamedResponse handles tool call events", async () => {
		mockFetch({
			body: sseStream([
				JSON.stringify({
					type: "response.output_item.added",
					item: { id: "item_1", type: "function_call", call_id: "call_abc", name: "greet" },
				}),
				JSON.stringify({
					type: "response.function_call_arguments.delta",
					item_id: "item_1",
					delta: '{"name":',
				}),
				JSON.stringify({
					type: "response.function_call_arguments.delta",
					item_id: "item_1",
					delta: '"World"}',
				}),
				JSON.stringify({
					type: "response.output_item.done",
					item: { id: "item_1", type: "function_call", call_id: "call_abc", name: "greet", arguments: '{"name":"World"}' },
				}),
				JSON.stringify({
					type: "response.completed",
					response: { status: "completed" },
				}),
			]),
		});

		const model = new AzureResponsesModel(config);
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
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "ok" }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({ messages: [{ role: "user", content: "test" }] });

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [url, options] = fetchMock.mock.calls[0]!;

		expect(url).toBe("https://test.openai.azure.com/openai/responses?api-version=2025-04-01-preview");
		expect((options.headers as Record<string, string>)["api-key"]).toBe("test-key");
	});

	test("deployment sent as model in request body", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "ok" }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({ messages: [{ role: "user", content: "test" }] });

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [, options] = fetchMock.mock.calls[0]!;
		const body = JSON.parse(options.body as string);

		expect(body.model).toBe("gpt-5-responses");
		expect(body.store).toBe(false);
	});

	test("system message extracted to instructions field", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "ok" }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [
				{ role: "system", content: "You are helpful." },
				{ role: "user", content: "Hi" },
			],
		});

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [, options] = fetchMock.mock.calls[0]!;
		const body = JSON.parse(options.body as string);

		expect(body.instructions).toBe("You are helpful.");
		expect(body.input).toHaveLength(1);
		expect(body.input[0].type).toBe("message");
		expect(body.input[0].role).toBe("user");
	});

	test("tool messages converted to function_call_output items", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "It's sunny." }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [
				{ role: "user", content: "Weather?" },
				{
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
				{ role: "tool", tool_call_id: "tc1", content: "72F sunny" },
			],
		});

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [, options] = fetchMock.mock.calls[0]!;
		const body = JSON.parse(options.body as string);

		// user message, function_call (from assistant tool_calls), function_call_output (from tool message)
		expect(body.input).toHaveLength(3);
		expect(body.input[0].type).toBe("message");
		expect(body.input[1].type).toBe("function_call");
		expect(body.input[1].call_id).toBe("tc1");
		expect(body.input[1].name).toBe("get_weather");
		expect(body.input[2].type).toBe("function_call_output");
		expect(body.input[2].call_id).toBe("tc1");
		expect(body.input[2].output).toBe("72F sunny");
	});

	test("responseFormat json_schema maps to text.format", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: '{"name":"test"}' }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			responseFormat: {
				type: "json_schema",
				json_schema: {
					name: "test_schema",
					schema: { type: "object", properties: { name: { type: "string" } } },
					strict: true,
				},
			},
		});

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [, options] = fetchMock.mock.calls[0]!;
		const body = JSON.parse(options.body as string);

		expect(body.text).toEqual({
			format: {
				type: "json_schema",
				name: "test_schema",
				schema: { type: "object", properties: { name: { type: "string" } } },
				strict: true,
			},
		});
	});

	test("maxTokens mapped to max_output_tokens", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "ok" }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			modelSettings: { maxTokens: 100 },
		});

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [, options] = fetchMock.mock.calls[0]!;
		const body = JSON.parse(options.body as string);

		expect(body.max_output_tokens).toBe(100);
		expect(body.max_tokens).toBeUndefined();
	});

	test("tool definitions flattened (no function wrapper)", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "ok" }],
					},
				],
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get weather",
						parameters: { type: "object", properties: { city: { type: "string" } } },
					},
				},
			],
		});

		const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
		const [, options] = fetchMock.mock.calls[0]!;
		const body = JSON.parse(options.body as string);

		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].type).toBe("function");
		expect(body.tools[0].name).toBe("get_weather");
		expect(body.tools[0].description).toBe("Get weather");
		expect(body.tools[0].parameters).toBeDefined();
		expect(body.tools[0].function).toBeUndefined();
	});
});
