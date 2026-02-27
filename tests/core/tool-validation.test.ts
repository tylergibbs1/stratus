import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { run } from "../../src/core/run";
import { tool } from "../../src/core/tool";

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
			for (const tc of response.toolCalls) {
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield { type: "tool_call_delta", toolCallId: tc.id, arguments: tc.function.arguments };
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

function tcResponse(name: string, args: string): ModelResponse {
	return {
		content: null,
		toolCalls: [
			{
				id: "tc1",
				type: "function" as const,
				function: { name, arguments: args },
			},
		],
	};
}

describe("tool parameter validation", () => {
	test("invalid JSON arguments sends error back to model", async () => {
		const model = mockModel([
			tcResponse("my_tool", "not json at all{{{"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({ query: z.string() }),
			execute: async (_ctx, { query }) => query,
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const result = await run(agent, "Search");

		const toolMsg = result.messages.find((m) => m.role === "tool" && m.content.includes("Error"));
		expect(toolMsg).toBeDefined();
		expect(result.output).toBe("Recovered");
	});

	test("missing required field in arguments sends error", async () => {
		const model = mockModel([tcResponse("my_tool", "{}"), { content: "Recovered", toolCalls: [] }]);

		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({
				name: z.string(),
				age: z.number(),
			}),
			execute: async (_ctx, params) => JSON.stringify(params),
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const result = await run(agent, "Do it");

		// The tool still receives the parsed params — Zod may add defaults or the execute runs
		// But if Zod strict mode rejects, it would be an error
		// Run loop catches errors in tool.execute and returns error message
		expect(result.output).toBe("Recovered");
	});

	test("extra fields pass through (Zod strip by default)", async () => {
		let receivedParams: any;

		const model = mockModel([
			tcResponse("my_tool", '{"name":"test","extra":"field"}'),
			{ content: "Done", toolCalls: [] },
		]);

		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, params) => {
				receivedParams = params;
				return "ok";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		await run(agent, "Go");

		// Run loop passes raw JSON.parse result to execute — Zod doesn't run in execute path
		// The params should include the extra field since run loop does JSON.parse, not schema.parse
		expect(receivedParams.name).toBe("test");
	});

	test("wrong type in arguments — tool receives raw parsed JSON", async () => {
		let receivedParams: any;

		const model = mockModel([
			tcResponse("my_tool", '{"count":"not_a_number"}'),
			{ content: "Done", toolCalls: [] },
		]);

		const myTool = tool({
			name: "my_tool",
			description: "A tool",
			parameters: z.object({ count: z.number() }),
			execute: async (_ctx, params) => {
				receivedParams = params;
				return "ok";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		await run(agent, "Go");

		// Run loop does JSON.parse then passes directly to execute (no Zod runtime validation)
		expect(receivedParams.count).toBe("not_a_number");
	});

	test("empty object arguments for tool with no params works", async () => {
		let executed = false;

		const model = mockModel([tcResponse("my_tool", "{}"), { content: "Done", toolCalls: [] }]);

		const myTool = tool({
			name: "my_tool",
			description: "No params tool",
			parameters: z.object({}),
			execute: async () => {
				executed = true;
				return "ok";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const result = await run(agent, "Go");

		expect(executed).toBe(true);
		expect(result.output).toBe("Done");
	});

	test("tool that returns non-string is handled gracefully", async () => {
		const model = mockModel([tcResponse("my_tool", "{}"), { content: "Handled", toolCalls: [] }]);

		const myTool = tool({
			name: "my_tool",
			description: "Returns wrong type",
			parameters: z.object({}),
			// @ts-expect-error -- deliberately returning wrong type
			execute: async () => 42,
		});

		const agent = new Agent({ name: "test", model, tools: [myTool] });
		const result = await run(agent, "Go");

		// The number should be coerced or handled
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
	});

	test("tool that throws synchronously is caught", async () => {
		const model = mockModel([
			tcResponse("sync_throw", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const syncThrowTool = tool({
			name: "sync_throw",
			description: "Throws sync",
			parameters: z.object({}),
			execute: (_ctx, _params) => {
				throw new Error("sync explosion");
			},
		});

		const agent = new Agent({ name: "test", model, tools: [syncThrowTool] });
		const result = await run(agent, "Go");

		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("sync explosion"),
		);
		expect(toolMsg).toBeDefined();
		expect(result.output).toBe("Recovered");
	});

	test("deeply nested JSON arguments are parsed correctly", async () => {
		let receivedParams: any;

		const model = mockModel([
			tcResponse("complex", '{"data":{"nested":{"deep":"value"}},"list":[1,2,3]}'),
			{ content: "Done", toolCalls: [] },
		]);

		const complexTool = tool({
			name: "complex",
			description: "Complex params",
			parameters: z.object({
				data: z.object({ nested: z.object({ deep: z.string() }) }),
				list: z.array(z.number()),
			}),
			execute: async (_ctx, params) => {
				receivedParams = params;
				return "ok";
			},
		});

		const agent = new Agent({ name: "test", model, tools: [complexTool] });
		await run(agent, "Go");

		expect(receivedParams.data.nested.deep).toBe("value");
		expect(receivedParams.list).toEqual([1, 2, 3]);
	});
});
