import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { OutputParseError } from "../../src/core/errors";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";

function mockModel(responses: ModelResponse[]): Model {
	let callIndex = 0;
	return {
		async getResponse(_request: ModelRequest): Promise<ModelResponse> {
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(_request: ModelRequest): AsyncGenerator<StreamEvent> {
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			if (response.content) {
				yield { type: "content_delta", content: response.content };
			}
			yield { type: "done", response };
		},
	};
}

const personSchema = z.object({ name: z.string(), age: z.number() });

describe("structured output", () => {
	test("parses valid JSON into finalOutput", async () => {
		const model = mockModel([
			{ content: '{"name":"Alice","age":30}', toolCalls: [] },
		]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: personSchema,
		});

		const result = await run(agent, "Get person info");

		expect(result.output).toBe('{"name":"Alice","age":30}');
		expect(result.finalOutput).toEqual({ name: "Alice", age: 30 });
	});

	test("throws OutputParseError on invalid JSON", async () => {
		const model = mockModel([
			{ content: "not valid json", toolCalls: [] },
		]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: personSchema,
		});

		expect(run(agent, "Get person info")).rejects.toThrow(OutputParseError);
	});

	test("throws OutputParseError on schema validation failure", async () => {
		const model = mockModel([
			{ content: '{"name":"Alice","age":"not a number"}', toolCalls: [] },
		]);

		const agent = new Agent({
			name: "test",
			model,
			outputType: personSchema,
		});

		expect(run(agent, "Get person info")).rejects.toThrow(OutputParseError);
	});

	test("backward compat: no outputType means finalOutput is undefined", async () => {
		const model = mockModel([
			{ content: "Hello!", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model });
		const result = await run(agent, "Hi");

		expect(result.output).toBe("Hello!");
		expect(result.finalOutput).toBeUndefined();
	});

	test("sends json_schema response format to model", async () => {
		let capturedRequest: ModelRequest | undefined;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequest = request;
				return { content: '{"name":"Bob","age":25}', toolCalls: [] };
			},
			async *getStreamedResponse(_request: ModelRequest): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: '{"name":"Bob","age":25}', toolCalls: [] } };
			},
		};

		const agent = new Agent({
			name: "test",
			model,
			outputType: personSchema,
		});

		await run(agent, "Get person");

		expect(capturedRequest?.responseFormat).toEqual({
			type: "json_schema",
			json_schema: {
				name: "response",
				schema: {
					type: "object",
					properties: {
						name: { type: "string" },
						age: { type: "number" },
					},
					additionalProperties: false,
					required: ["name", "age"],
				},
				strict: true,
			},
		});
	});
});
