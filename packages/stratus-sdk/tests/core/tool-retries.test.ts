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

describe("tool retries", () => {
	test("tool with no retries throws on first failure", async () => {
		const model = mockModel([
			tcResponse("fail_tool", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const failTool = tool({
			name: "fail_tool",
			description: "Always fails",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("boom");
			},
		});

		const agent = new Agent({ name: "test", model, tools: [failTool] });
		const result = await run(agent, "Go");

		// The error is caught by the run loop and sent as a tool message
		const toolMsg = result.messages.find((m) => m.role === "tool" && m.content.includes("boom"));
		expect(toolMsg).toBeDefined();
		expect(result.output).toBe("Recovered");
	});

	test("tool with retries retries up to limit then throws", async () => {
		let callCount = 0;

		const model = mockModel([
			tcResponse("retry_tool", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const retryTool = tool({
			name: "retry_tool",
			description: "Fails every time",
			parameters: z.object({}),
			execute: async () => {
				callCount++;
				throw new Error("transient failure");
			},
			retries: { limit: 3, delay: 10, backoff: "fixed" },
		});

		const agent = new Agent({ name: "test", model, tools: [retryTool] });
		const result = await run(agent, "Go");

		// 1 initial + 3 retries = 4 total attempts
		expect(callCount).toBe(4);
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("transient failure"),
		);
		expect(toolMsg).toBeDefined();
	});

	test("tool with retries succeeds on Nth attempt", async () => {
		let callCount = 0;

		const model = mockModel([tcResponse("retry_tool", "{}"), { content: "Done", toolCalls: [] }]);

		const retryTool = tool({
			name: "retry_tool",
			description: "Fails twice then succeeds",
			parameters: z.object({}),
			execute: async () => {
				callCount++;
				if (callCount < 3) {
					throw new Error("transient failure");
				}
				return "success";
			},
			retries: { limit: 3, delay: 10, backoff: "fixed" },
		});

		const agent = new Agent({ name: "test", model, tools: [retryTool] });
		const result = await run(agent, "Go");

		expect(callCount).toBe(3);
		const toolMsg = result.messages.find((m) => m.role === "tool" && m.content === "success");
		expect(toolMsg).toBeDefined();
	});

	test("shouldRetry predicate skips retry for specific errors", async () => {
		let callCount = 0;

		const model = mockModel([
			tcResponse("retry_tool", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const retryTool = tool({
			name: "retry_tool",
			description: "Fails with non-retryable error",
			parameters: z.object({}),
			execute: async () => {
				callCount++;
				throw new Error("permanent failure");
			},
			retries: {
				limit: 5,
				delay: 10,
				shouldRetry: (error) => {
					if (error instanceof Error && error.message === "permanent failure") {
						return false;
					}
					return true;
				},
			},
		});

		const agent = new Agent({ name: "test", model, tools: [retryTool] });
		const result = await run(agent, "Go");

		// shouldRetry returned false, so only 1 attempt (no retries)
		expect(callCount).toBe(1);
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("permanent failure"),
		);
		expect(toolMsg).toBeDefined();
	});

	test("timeout errors are not retried", async () => {
		let callCount = 0;

		const model = mockModel([
			tcResponse("slow_tool", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const slowTool = tool({
			name: "slow_tool",
			description: "Times out",
			parameters: z.object({}),
			execute: async () => {
				callCount++;
				// Wait longer than the timeout
				await new Promise((r) => setTimeout(r, 200));
				return "should not reach";
			},
			timeout: 50,
			retries: { limit: 3, delay: 10 },
		});

		const agent = new Agent({ name: "test", model, tools: [slowTool] });
		const result = await run(agent, "Go");

		// ToolTimeoutError should not be retried, so only 1 attempt
		expect(callCount).toBe(1);
		const toolMsg = result.messages.find(
			(m) => m.role === "tool" && m.content.includes("timed out"),
		);
		expect(toolMsg).toBeDefined();
	});

	test("exponential backoff increases delay between retries", async () => {
		const timestamps: number[] = [];
		let callCount = 0;

		const model = mockModel([
			tcResponse("exp_tool", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const expTool = tool({
			name: "exp_tool",
			description: "Tracks timing",
			parameters: z.object({}),
			execute: async () => {
				timestamps.push(Date.now());
				callCount++;
				throw new Error("fail");
			},
			retries: { limit: 3, delay: 50, backoff: "exponential" },
		});

		const agent = new Agent({ name: "test", model, tools: [expTool] });
		await run(agent, "Go");

		expect(callCount).toBe(4);
		expect(timestamps.length).toBe(4);

		// Exponential: delays should be ~50, ~100, ~200
		const delay1 = timestamps[1]! - timestamps[0]!;
		const delay2 = timestamps[2]! - timestamps[1]!;
		const delay3 = timestamps[3]! - timestamps[2]!;

		// Allow 30ms tolerance for timer imprecision
		expect(delay1).toBeGreaterThanOrEqual(40);
		expect(delay1).toBeLessThan(120);

		expect(delay2).toBeGreaterThanOrEqual(80);
		expect(delay2).toBeLessThan(200);

		expect(delay3).toBeGreaterThanOrEqual(160);
		expect(delay3).toBeLessThan(350);
	});

	test("fixed backoff uses constant delay between retries", async () => {
		const timestamps: number[] = [];
		let callCount = 0;

		const model = mockModel([
			tcResponse("fixed_tool", "{}"),
			{ content: "Recovered", toolCalls: [] },
		]);

		const fixedTool = tool({
			name: "fixed_tool",
			description: "Tracks timing",
			parameters: z.object({}),
			execute: async () => {
				timestamps.push(Date.now());
				callCount++;
				throw new Error("fail");
			},
			retries: { limit: 3, delay: 50, backoff: "fixed" },
		});

		const agent = new Agent({ name: "test", model, tools: [fixedTool] });
		await run(agent, "Go");

		expect(callCount).toBe(4);
		expect(timestamps.length).toBe(4);

		// Fixed: all delays should be ~50ms
		const delay1 = timestamps[1]! - timestamps[0]!;
		const delay2 = timestamps[2]! - timestamps[1]!;
		const delay3 = timestamps[3]! - timestamps[2]!;

		// All delays should be roughly the same (~50ms)
		expect(delay1).toBeGreaterThanOrEqual(40);
		expect(delay1).toBeLessThan(120);

		expect(delay2).toBeGreaterThanOrEqual(40);
		expect(delay2).toBeLessThan(120);

		expect(delay3).toBeGreaterThanOrEqual(40);
		expect(delay3).toBeLessThan(120);

		// The delays should be similar (fixed, not growing)
		// Delay3 should NOT be much larger than delay1 (unlike exponential)
		expect(Math.abs(delay3 - delay1)).toBeLessThan(50);
	});
});

describe("tool needsApproval", () => {
	test("needsApproval field is set on tool", () => {
		const t = tool({
			name: "my_tool",
			description: "test",
			parameters: z.object({}),
			execute: async () => "ok",
			needsApproval: true,
		});

		expect(t.needsApproval).toBe(true);
		expect(t.type).toBe("function");
	});

	test("needsApproval accepts a function", () => {
		const t = tool({
			name: "my_tool",
			description: "test",
			parameters: z.object({ dangerous: z.boolean() }),
			execute: async () => "ok",
			needsApproval: (params) => params.dangerous,
		});

		expect(typeof t.needsApproval).toBe("function");
	});
});
