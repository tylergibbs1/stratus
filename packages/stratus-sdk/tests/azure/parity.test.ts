import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import type { ModelResponse } from "../../src/core/model";

const originalFetch = globalThis.fetch;

const config = {
	endpoint: "https://test.openai.azure.com",
	apiKey: "test-key",
	deployment: "gpt-5",
};

let capturedBody: Record<string, unknown> | null = null;

function mockFetch(response: {
	ok?: boolean;
	status?: number;
	json?: unknown;
	headers?: Headers;
}) {
	capturedBody = null;
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock((url: string, init: RequestInit) => {
		if (init.body) {
			capturedBody = JSON.parse(init.body as string);
		}
		return Promise.resolve({
			ok: response.ok ?? true,
			status: response.status ?? 200,
			json: () => Promise.resolve(response.json),
			text: () => Promise.resolve(JSON.stringify(response.json ?? "")),
			body: null,
			headers: response.headers ?? new Headers({ "content-type": "application/json" }),
		} as Response);
	});
}

beforeEach(() => {
	capturedBody = null;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("logprobs NOT sent in Responses API", () => {
	test("logprobs and topLogprobs are excluded from Responses API requests", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			modelSettings: { logprobs: true, topLogprobs: 5 },
		});

		// logprobs is Chat Completions-only — Responses API rejects it
		expect(capturedBody).toBeTruthy();
		expect(capturedBody!.logprobs).toBeUndefined();
		expect(capturedBody!.top_logprobs).toBeUndefined();
	});
});

describe("incomplete_details parsing", () => {
	test("parses incomplete_details from incomplete response", async () => {
		mockFetch({
			json: {
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
				usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(result.finishReason).toBe("length");
		expect(result.incompleteDetails).toEqual({ reason: "max_output_tokens" });
	});

	test("incomplete_details is undefined for completed responses", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(result.incompleteDetails).toBeUndefined();
	});
});

describe("mcp_approval_request output", () => {
	test("surfaces mcp_approval_request in outputItems", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "mcp_approval_request",
						id: "mcpr_123",
						name: "fetch_docs",
						arguments: "{}",
						server_label: "github",
					},
				],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(result.outputItems).toBeDefined();
		expect(result.outputItems).toHaveLength(1);
		expect(result.outputItems![0]!.type).toBe("mcp_approval_request");
		expect(result.outputItems![0]!.id).toBe("mcpr_123");
		expect(result.outputItems![0]!.server_label).toBe("github");
	});

	test("outputItems is undefined when only standard items", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{ type: "message", content: [{ type: "output_text", text: "hello" }] },
					{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
				],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(result.outputItems).toBeUndefined();
	});
});

describe("file content part serialization", () => {
	test("sends input_file with file_id", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }],
				usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [
				{
					role: "user",
					content: [
						{ type: "file", file: { file_id: "file-abc123" }, filename: "report.pdf" },
						{ type: "text", text: "Summarize this PDF" },
					],
				},
			],
		});

		expect(capturedBody).toBeTruthy();
		const input = capturedBody!.input as unknown[];
		const userMsg = input[0] as { content: unknown[] };
		const filePart = userMsg.content[0] as Record<string, unknown>;
		expect(filePart.type).toBe("input_file");
		expect(filePart.file_id).toBe("file-abc123");
		expect(filePart.filename).toBe("report.pdf");
	});

	test("sends input_file with base64 data URL", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [
				{
					role: "user",
					content: [
						{ type: "file", file: { url: "data:application/pdf;base64,AAAA" } },
						{ type: "text", text: "What is this?" },
					],
				},
			],
		});

		expect(capturedBody).toBeTruthy();
		const input = capturedBody!.input as unknown[];
		const userMsg = input[0] as { content: unknown[] };
		const filePart = userMsg.content[0] as Record<string, unknown>;
		expect(filePart.type).toBe("input_file");
		expect(filePart.file_data).toBe("data:application/pdf;base64,AAAA");
	});
});

describe("code_interpreter file_ids", () => {
	test("file_ids passed through in container config", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const { codeInterpreterTool } = await import("../../src/core/builtin-tools");
		const ciTool = codeInterpreterTool({
			container: { type: "auto", file_ids: ["file-1", "file-2"] },
		});

		expect(ciTool.definition.container).toEqual({
			type: "auto",
			file_ids: ["file-1", "file-2"],
		});
	});
});
