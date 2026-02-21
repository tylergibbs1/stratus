import { describe, expect, test } from "bun:test";
import { parseSSE } from "../../src/azure/sse-parser";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

describe("parseSSE", () => {
	test("parses complete SSE messages", async () => {
		const stream = makeStream([
			'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"id":"2","choices":[{"delta":{"content":" world"}}]}\n\n',
			"data: [DONE]\n\n",
		]);

		const results: string[] = [];
		for await (const data of parseSSE(stream)) {
			results.push(data);
		}

		expect(results).toHaveLength(2);
		expect(JSON.parse(results[0]!).choices[0].delta.content).toBe("Hello");
		expect(JSON.parse(results[1]!).choices[0].delta.content).toBe(" world");
	});

	test("handles partial chunks", async () => {
		const stream = makeStream([
			'data: {"id":"1","cho',
			'ices":[{"delta":{"content":"Hi"}}]}\n\n',
			"data: [DONE]\n\n",
		]);

		const results: string[] = [];
		for await (const data of parseSSE(stream)) {
			results.push(data);
		}

		expect(results).toHaveLength(1);
		expect(JSON.parse(results[0]!).choices[0].delta.content).toBe("Hi");
	});

	test("handles multiple events in one chunk", async () => {
		const stream = makeStream([
			'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n',
		]);

		const results: string[] = [];
		for await (const data of parseSSE(stream)) {
			results.push(data);
		}

		expect(results).toHaveLength(2);
	});

	test("handles empty stream", async () => {
		const stream = makeStream([]);
		const results: string[] = [];
		for await (const data of parseSSE(stream)) {
			results.push(data);
		}
		expect(results).toHaveLength(0);
	});

	test("stops at [DONE]", async () => {
		const stream = makeStream([
			'data: {"first":true}\n\n',
			"data: [DONE]\n\n",
			'data: {"should_not_appear":true}\n\n',
		]);

		const results: string[] = [];
		for await (const data of parseSSE(stream)) {
			results.push(data);
		}

		expect(results).toHaveLength(1);
	});
});
