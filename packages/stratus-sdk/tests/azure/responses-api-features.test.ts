import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AzureResponsesModel } from "../../src/azure/responses-model";

const originalFetch = globalThis.fetch;

const config = {
	endpoint: "https://test.openai.azure.com",
	apiKey: "test-key",
	deployment: "gpt-4o",
};

let capturedUrl: string | null = null;
let capturedMethod: string | null = null;
let capturedBody: Record<string, unknown> | null = null;

function mockFetch(response: {
	ok?: boolean;
	status?: number;
	json?: unknown;
	headers?: Headers;
}) {
	capturedUrl = null;
	capturedMethod = null;
	capturedBody = null;
	// @ts-expect-error -- mock subset of fetch
	globalThis.fetch = mock((url: string, init: RequestInit) => {
		capturedUrl = url;
		capturedMethod = init.method ?? "GET";
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
	capturedUrl = null;
	capturedMethod = null;
	capturedBody = null;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// --- Feature 1: Compact endpoint ---

describe("compact()", () => {
	test("sends POST to /compact with input items", async () => {
		mockFetch({
			json: {
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "compacted" }],
					},
				],
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.compact({
			input: [
				{ role: "user", content: "Create a landing page" },
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "long response..." }],
				},
			],
		});

		expect(capturedUrl).toContain("/responses/compact");
		expect(capturedMethod).toBe("POST");
		expect(capturedBody!.model).toBe("gpt-4o");
		expect(capturedBody!.input).toHaveLength(2);
		expect(result.output).toHaveLength(1);
		expect(result.usage).toBeDefined();
		expect(result.usage!.input_tokens).toBe(100);
	});

	test("sends previous_response_id when provided", async () => {
		mockFetch({
			json: { output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
		});

		const model = new AzureResponsesModel(config);
		await model.compact({ previousResponseId: "resp_abc123" });

		expect(capturedBody!.previous_response_id).toBe("resp_abc123");
		expect(capturedBody!.input).toBeUndefined();
	});

	test("allows custom model override", async () => {
		mockFetch({
			json: { output: [], usage: null },
		});

		const model = new AzureResponsesModel(config);
		await model.compact({ model: "gpt-4.1" });

		expect(capturedBody!.model).toBe("gpt-4.1");
	});
});

// --- Feature 2: Background tasks ---

describe("createBackgroundResponse()", () => {
	test("sends background: true and returns raw response", async () => {
		mockFetch({
			json: {
				id: "resp_bg_123",
				status: "queued",
				output: [],
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.createBackgroundResponse({
			messages: [{ role: "user", content: "Write a long story" }],
		});

		expect(capturedBody!.background).toBe(true);
		expect(result.id).toBe("resp_bg_123");
		expect(result.status).toBe("queued");
	});

	test("sets stream: true when stream option is passed", async () => {
		mockFetch({
			json: { id: "resp_bg_456", status: "queued", output: [] },
		});

		const model = new AzureResponsesModel(config);
		await model.createBackgroundResponse(
			{ messages: [{ role: "user", content: "test" }] },
			{ stream: true },
		);

		expect(capturedBody!.stream).toBe(true);
		expect(capturedBody!.background).toBe(true);
	});
});

describe("retrieveResponse()", () => {
	test("sends GET to /responses/{id}", async () => {
		mockFetch({
			json: {
				id: "resp_abc",
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.retrieveResponse("resp_abc");

		expect(capturedUrl).toContain("/responses/resp_abc");
		expect(capturedMethod).toBe("GET");
		expect(result.id).toBe("resp_abc");
		expect(result.status).toBe("completed");
	});
});

describe("cancelResponse()", () => {
	test("sends POST to /responses/{id}/cancel", async () => {
		mockFetch({
			json: { id: "resp_cancel", status: "cancelled" },
		});

		const model = new AzureResponsesModel(config);
		const result = await model.cancelResponse("resp_cancel");

		expect(capturedUrl).toContain("/responses/resp_cancel/cancel");
		expect(capturedMethod).toBe("POST");
		expect(result.status).toBe("cancelled");
	});
});

// --- Feature 3: Encrypted reasoning items ---

describe("include parameter", () => {
	test("sends include in request body via modelSettings", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			modelSettings: { include: ["reasoning.encrypted_content"] },
		});

		expect(capturedBody!.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("omits include when not set", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(capturedBody!.include).toBeUndefined();
	});
});

describe("background parameter via modelSettings", () => {
	test("sends background in request body", async () => {
		mockFetch({
			json: {
				id: "resp_bg",
				status: "queued",
				output: [],
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			modelSettings: { background: true },
		});

		expect(capturedBody!.background).toBe(true);
	});
});

// --- Feature 4: CRUD ---

describe("deleteResponse()", () => {
	test("sends DELETE to /responses/{id}", async () => {
		mockFetch({ json: {} });

		const model = new AzureResponsesModel(config);
		await model.deleteResponse("resp_del_123");

		expect(capturedUrl).toContain("/responses/resp_del_123");
		expect(capturedMethod).toBe("DELETE");
	});
});

describe("listInputItems()", () => {
	test("sends GET to /responses/{id}/input_items and parses response", async () => {
		mockFetch({
			json: {
				data: [
					{
						id: "msg_123",
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "This is a test." }],
						status: "completed",
					},
				],
				has_more: false,
				first_id: "msg_123",
				last_id: "msg_123",
				object: "list",
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.listInputItems("resp_list_123");

		expect(capturedUrl).toContain("/responses/resp_list_123/input_items");
		expect(capturedMethod).toBe("GET");
		expect(result.data).toHaveLength(1);
		expect(result.hasMore).toBe(false);
		expect(result.firstId).toBe("msg_123");
		expect(result.lastId).toBe("msg_123");
	});
});

// --- Feature 5: Server-side compaction items ---

describe("compaction output items", () => {
	test("compaction items are preserved in outputItems", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{ type: "message", content: [{ type: "output_text", text: "response" }] },
					{ type: "compaction", data: "encrypted_compaction_data_here" },
				],
				usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "test" }],
		});

		expect(result.content).toBe("response");
		expect(result.outputItems).toBeDefined();
		expect(result.outputItems).toHaveLength(1);
		expect(result.outputItems![0]!.type).toBe("compaction");
		expect(result.outputItems![0]!.data).toBe("encrypted_compaction_data_here");
	});

	test("compaction items can be passed back via rawInputItems", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "continued" }] }],
				usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "Continue" }],
			rawInputItems: [{ type: "compaction", data: "encrypted_compaction_data_here" }],
		});

		const inputArray = capturedBody!.input as unknown[];
		expect(inputArray).toHaveLength(2); // user message + compaction item
		const compaction = inputArray[1] as Record<string, unknown>;
		expect(compaction.type).toBe("compaction");
		expect(compaction.data).toBe("encrypted_compaction_data_here");
	});
});

// --- Feature 6: MCP approval flow ---

describe("MCP approval response", () => {
	test("mcp_approval_response is sent via rawInputItems", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "tool result" }] }],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(config);
		await model.getResponse({
			messages: [{ role: "user", content: "test" }],
			previousResponseId: "resp_previous",
			modelSettings: { store: true },
			rawInputItems: [
				{
					type: "mcp_approval_response",
					approve: true,
					approval_request_id: "mcpr_123",
				},
			],
		});

		const inputArray = capturedBody!.input as unknown[];
		const approvalItem = inputArray.find(
			(item: any) => item.type === "mcp_approval_response",
		) as Record<string, unknown>;
		expect(approvalItem).toBeDefined();
		expect(approvalItem.approve).toBe(true);
		expect(approvalItem.approval_request_id).toBe("mcpr_123");
		expect(capturedBody!.previous_response_id).toBe("resp_previous");
	});

	test("mcp_approval_request in output is accessible via outputItems", async () => {
		mockFetch({
			json: {
				status: "completed",
				output: [
					{
						type: "mcp_approval_request",
						id: "mcpr_456",
						name: "search_docs",
						arguments: '{"query": "test"}',
						server_label: "github",
					},
				],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result = await model.getResponse({
			messages: [{ role: "user", content: "search" }],
		});

		expect(result.outputItems).toHaveLength(1);
		const item = result.outputItems![0]!;
		expect(item.type).toBe("mcp_approval_request");
		expect(item.id).toBe("mcpr_456");
		expect(item.server_label).toBe("github");
	});
});

// --- URL resolution for sub-endpoints ---

describe("sub-endpoint URL resolution", () => {
	test("standard endpoint builds correct compact URL", async () => {
		mockFetch({ json: { output: [] } });
		const model = new AzureResponsesModel(config);
		await model.compact({});
		expect(capturedUrl).toBe("https://test.openai.azure.com/openai/v1/responses/compact");
	});

	test("standard endpoint builds correct retrieve URL", async () => {
		mockFetch({ json: { id: "resp_1", status: "completed" } });
		const model = new AzureResponsesModel(config);
		await model.retrieveResponse("resp_1");
		expect(capturedUrl).toBe("https://test.openai.azure.com/openai/v1/responses/resp_1");
	});

	test("standard endpoint builds correct delete URL", async () => {
		mockFetch({ json: {} });
		const model = new AzureResponsesModel(config);
		await model.deleteResponse("resp_1");
		expect(capturedUrl).toBe("https://test.openai.azure.com/openai/v1/responses/resp_1");
	});

	test("standard endpoint builds correct cancel URL", async () => {
		mockFetch({ json: { id: "resp_1", status: "cancelled" } });
		const model = new AzureResponsesModel(config);
		await model.cancelResponse("resp_1");
		expect(capturedUrl).toBe("https://test.openai.azure.com/openai/v1/responses/resp_1/cancel");
	});

	test("standard endpoint builds correct list input items URL", async () => {
		mockFetch({ json: { data: [], has_more: false } });
		const model = new AzureResponsesModel(config);
		await model.listInputItems("resp_1");
		expect(capturedUrl).toBe(
			"https://test.openai.azure.com/openai/v1/responses/resp_1/input_items",
		);
	});

	test("foundry endpoint includes api-version in sub-endpoint URLs", async () => {
		mockFetch({ json: { output: [] } });
		const model = new AzureResponsesModel({
			endpoint: "https://test.services.ai.azure.com",
			apiKey: "test-key",
			deployment: "gpt-4o",
		});
		await model.compact({});
		expect(capturedUrl).toContain("api-version=");
		expect(capturedUrl).toContain("/responses/compact");
	});
});

// --- Encrypted reasoning items round-trip ---

describe("encrypted reasoning items round-trip", () => {
	test("reasoning items returned in outputItems can be passed back via rawInputItems", async () => {
		// First call returns encrypted reasoning
		mockFetch({
			json: {
				id: "resp_1",
				status: "completed",
				output: [
					{ type: "message", content: [{ type: "output_text", text: "thought about it" }] },
					{ type: "reasoning", id: "rs_1", encrypted_content: "enc_data_abc" },
				],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});

		const model = new AzureResponsesModel(config);
		const result1 = await model.getResponse({
			messages: [{ role: "user", content: "think about this" }],
			modelSettings: { include: ["reasoning.encrypted_content"] },
		});

		// The reasoning item should be in outputItems
		expect(result1.outputItems).toBeDefined();
		const reasoningItem = result1.outputItems!.find((i) => i.type === "reasoning");
		expect(reasoningItem).toBeDefined();
		expect(reasoningItem!.encrypted_content).toBe("enc_data_abc");

		// Second call passes reasoning back
		mockFetch({
			json: {
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "continued" }] }],
				usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
			},
		});

		await model.getResponse({
			messages: [{ role: "user", content: "continue" }],
			rawInputItems: [reasoningItem!],
			modelSettings: { include: ["reasoning.encrypted_content"] },
		});

		const inputArray = capturedBody!.input as unknown[];
		const passedReasoning = inputArray.find((i: any) => i.type === "reasoning");
		expect(passedReasoning).toBeDefined();
	});
});
