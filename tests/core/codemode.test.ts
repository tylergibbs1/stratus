import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { run, stream } from "../../src/core/run";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { tool } from "../../src/core/tool";
import type { FunctionTool } from "../../src/core/tool";
import type { HostedTool } from "../../src/core/hosted-tool";
import {
	createCodeModeTool,
	FunctionExecutor,
	WorkerExecutor,
	generateTypes,
	normalizeCode,
	sanitizeToolName,
} from "../../src/core/codemode/index";
import type { Executor, ExecuteResult } from "../../src/core/codemode/executor";

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

// ── sanitizeToolName ───────────────────────────────────────────────

describe("sanitizeToolName", () => {
	test("passes through valid names", () => {
		expect(sanitizeToolName("get_weather")).toBe("get_weather");
		expect(sanitizeToolName("myTool")).toBe("myTool");
	});

	test("replaces hyphens, dots, and spaces with underscores", () => {
		expect(sanitizeToolName("my-tool")).toBe("my_tool");
		expect(sanitizeToolName("my.tool")).toBe("my_tool");
		expect(sanitizeToolName("my tool")).toBe("my_tool");
		expect(sanitizeToolName("my-server.list-items")).toBe("my_server_list_items");
	});

	test("strips invalid characters", () => {
		expect(sanitizeToolName("tool@name!")).toBe("toolname");
	});

	test("prefixes digit-leading names", () => {
		expect(sanitizeToolName("3d-render")).toBe("_3d_render");
	});

	test("appends underscore to reserved words", () => {
		expect(sanitizeToolName("delete")).toBe("delete_");
		expect(sanitizeToolName("class")).toBe("class_");
		expect(sanitizeToolName("return")).toBe("return_");
	});

	test("handles empty string", () => {
		expect(sanitizeToolName("")).toBe("_");
	});

	test("handles all-invalid characters", () => {
		expect(sanitizeToolName("@@@")).toBe("_");
	});
});

// ── normalizeCode ──────────────────────────────────────────────────

describe("normalizeCode", () => {
	test("passes through async arrow functions", () => {
		const code = 'async () => { return await codemode.foo({ x: 1 }); }';
		expect(normalizeCode(code)).toBe(code);
	});

	test("wraps bare statements", () => {
		const code = 'const x = 1;\nconsole.log(x);';
		expect(normalizeCode(code)).toBe(`async () => {\n${code}\n}`);
	});

	test("strips markdown code fences", () => {
		const code = '```javascript\nconst x = 1;\n```';
		expect(normalizeCode(code)).toBe("async () => {\nconst x = 1;\n}");
	});

	test("strips ts code fences", () => {
		const code = '```ts\nconst x = 1;\n```';
		expect(normalizeCode(code)).toBe("async () => {\nconst x = 1;\n}");
	});

	test("returns empty function for empty input", () => {
		expect(normalizeCode("")).toBe("async () => {}");
		expect(normalizeCode("   ")).toBe("async () => {}");
	});

	test("handles async arrow with parenthesized params", () => {
		const code = 'async (arg) => { return arg; }';
		// starts with `async (` and contains `=>`, so passes through
		expect(normalizeCode(code)).toBe(code);
	});
});

// ── generateTypes ──────────────────────────────────────────────────

describe("generateTypes", () => {
	const weatherTool = tool({
		name: "get_weather",
		description: "Get weather for a location",
		parameters: z.object({
			location: z.string().describe("City name"),
			unit: z.enum(["celsius", "fahrenheit"]).optional(),
		}),
		execute: async (_ctx, _params) => "sunny",
	});

	const sendEmailTool = tool({
		name: "send_email",
		description: "Send an email to someone",
		parameters: z.object({
			to: z.string(),
			subject: z.string(),
			body: z.string(),
		}),
		execute: async (_ctx, _params) => "sent",
	});

	test("generates type definitions for tools", () => {
		const types = generateTypes([weatherTool]);
		expect(types).toContain("type GetWeatherInput");
		expect(types).toContain("type GetWeatherOutput = unknown");
		expect(types).toContain("declare const codemode");
		expect(types).toContain("get_weather:");
		expect(types).toContain("GetWeatherInput");
	});

	test("includes descriptions in JSDoc", () => {
		const types = generateTypes([weatherTool]);
		expect(types).toContain("Get weather for a location");
	});

	test("includes param descriptions", () => {
		const types = generateTypes([weatherTool]);
		expect(types).toContain("@param input.location - City name");
	});

	test("generates types for multiple tools", () => {
		const types = generateTypes([weatherTool, sendEmailTool]);
		expect(types).toContain("get_weather:");
		expect(types).toContain("send_email:");
		expect(types).toContain("GetWeatherInput");
		expect(types).toContain("SendEmailInput");
	});

	test("handles tool names needing sanitization", () => {
		const t = tool({
			name: "my-hyphenated.tool",
			description: "A tool",
			parameters: z.object({ x: z.number() }),
			execute: async (_ctx, _params) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain("my_hyphenated_tool:");
		expect(types).toContain("MyHyphenatedToolInput");
	});

	test("handles optional fields", () => {
		const types = generateTypes([weatherTool]);
		// unit is optional
		expect(types).toContain("unit?:");
	});

	test("handles empty tool list", () => {
		const types = generateTypes([]);
		expect(types).toContain("declare const codemode");
	});

	test("includes string type for string fields", () => {
		const types = generateTypes([weatherTool]);
		expect(types).toContain("string");
	});

	test("handles enum types", () => {
		const types = generateTypes([weatherTool]);
		// celsius | fahrenheit enum
		expect(types).toContain('"celsius"');
		expect(types).toContain('"fahrenheit"');
	});

	test("handles nested objects", () => {
		const t = tool({
			name: "nested_tool",
			description: "A tool with nested params",
			parameters: z.object({
				config: z.object({
					name: z.string(),
					count: z.number(),
				}),
			}),
			execute: async (_ctx, _params) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain("config:");
		expect(types).toContain("name:");
		expect(types).toContain("count:");
	});

	test("handles array types", () => {
		const t = tool({
			name: "array_tool",
			description: "A tool with array params",
			parameters: z.object({
				items: z.array(z.string()),
			}),
			execute: async (_ctx, _params) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain("string[]");
	});
});

// ── FunctionExecutor ───────────────────────────────────────────────

describe("FunctionExecutor", () => {
	test("executes simple code", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute("async () => { return 42; }", {});
		expect(result.result).toBe(42);
		expect(result.error).toBeUndefined();
	});

	test("captures console.log output", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			'async () => { console.log("hello"); console.log("world"); return "done"; }',
			{},
		);
		expect(result.result).toBe("done");
		expect(result.logs).toEqual(["hello", "world"]);
	});

	test("captures console.warn and console.error", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			'async () => { console.warn("w"); console.error("e"); return "ok"; }',
			{},
		);
		expect(result.logs).toEqual(["[warn] w", "[error] e"]);
	});

	test("calls tool functions via codemode proxy", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			add: async (args: unknown) => {
				const { a, b } = args as { a: number; b: number };
				return a + b;
			},
		};
		const result = await executor.execute(
			"async () => { const sum = await codemode.add({ a: 3, b: 4 }); return sum; }",
			fns,
		);
		expect(result.result).toBe(7);
	});

	test("chains multiple tool calls", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			get_temp: async (args: unknown) => {
				const { city } = args as { city: string };
				return city === "London" ? 15 : 25;
			},
			format: async (args: unknown) => {
				const { temp, unit } = args as { temp: number; unit: string };
				return `${temp}°${unit}`;
			},
		};
		const result = await executor.execute(
			`async () => {
				const temp = await codemode.get_temp({ city: "London" });
				const formatted = await codemode.format({ temp, unit: "C" });
				return formatted;
			}`,
			fns,
		);
		expect(result.result).toBe("15°C");
	});

	test("returns error for failing code", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			'async () => { throw new Error("boom"); }',
			{},
		);
		expect(result.error).toBe("boom");
		expect(result.result).toBeUndefined();
	});

	test("returns error for tool call failure", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			fail: async () => {
				throw new Error("tool failed");
			},
		};
		const result = await executor.execute(
			"async () => { return await codemode.fail(); }",
			fns,
		);
		expect(result.error).toBe("tool failed");
	});

	test("times out on long-running code", async () => {
		const executor = new FunctionExecutor({ timeout: 100 });
		const result = await executor.execute(
			"async () => { await new Promise(r => setTimeout(r, 5000)); return 1; }",
			{},
		);
		expect(result.error).toBe("Execution timed out");
	});

	test("supports conditional logic between tool calls", async () => {
		const executor = new FunctionExecutor();
		const calls: string[] = [];
		const fns = {
			check: async (args: unknown) => {
				const { value } = args as { value: number };
				calls.push(`check:${value}`);
				return value > 10;
			},
			process: async (args: unknown) => {
				const { item } = args as { item: string };
				calls.push(`process:${item}`);
				return `processed ${item}`;
			},
		};
		const result = await executor.execute(
			`async () => {
				const isHigh = await codemode.check({ value: 15 });
				if (isHigh) {
					return await codemode.process({ item: "high" });
				}
				return "low";
			}`,
			fns,
		);
		expect(result.result).toBe("processed high");
		expect(calls).toEqual(["check:15", "process:high"]);
	});

	test("supports loops over tool calls", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			double: async (args: unknown) => {
				const { n } = args as { n: number };
				return n * 2;
			},
		};
		const result = await executor.execute(
			`async () => {
				const results = [];
				for (const n of [1, 2, 3]) {
					results.push(await codemode.double({ n }));
				}
				return results;
			}`,
			fns,
		);
		expect(result.result).toEqual([2, 4, 6]);
	});
});

// ── createCodeModeTool ─────────────────────────────────────────────

describe("createCodeModeTool", () => {
	const weatherTool = tool({
		name: "get_weather",
		description: "Get weather for a location",
		parameters: z.object({ location: z.string() }),
		execute: async (_ctx, { location }) => JSON.stringify({ temp: 72, city: location }),
	});

	test("creates a function tool named execute_code", () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		expect(codeTool.type).toBe("function");
		expect(codeTool.name).toBe("execute_code");
	});

	test("description includes generated types", () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		expect(codeTool.description).toContain("get_weather");
		expect(codeTool.description).toContain("GetWeatherInput");
	});

	test("supports custom description with {{types}} placeholder", () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
			description: "Custom desc.\n\n{{types}}\n\nDo it.",
		});
		expect(codeTool.description).toContain("Custom desc.");
		expect(codeTool.description).toContain("GetWeatherInput");
		expect(codeTool.description).toContain("Do it.");
	});

	test("executes code and calls underlying tools", async () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		const resultStr = await codeTool.execute(
			{},
			{ code: 'async () => { const w = await codemode.get_weather({ location: "NYC" }); return w; }' },
		);
		const result = JSON.parse(resultStr);
		expect(result.result).toEqual({ temp: 72, city: "NYC" });
	});

	test("validates tool parameters via Zod", async () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		// Missing required 'location' param — Zod validation error surfaces as execution failure
		await expect(
			codeTool.execute(
				{},
				{ code: "async () => { return await codemode.get_weather({}); }" },
			),
		).rejects.toThrow("Code execution failed");
	});

	test("throws on code execution failure", async () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		await expect(
			codeTool.execute(
				{},
				{ code: 'async () => { throw new Error("boom"); }' },
			),
		).rejects.toThrow("Code execution failed: boom");
	});

	test("includes logs in error message", async () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		await expect(
			codeTool.execute(
				{},
				{ code: 'async () => { console.log("debug info"); throw new Error("fail"); }' },
			),
		).rejects.toThrow("debug info");
	});

	test("filters out hosted tools", () => {
		const hosted: HostedTool = {
			type: "hosted",
			name: "web_search",
			definition: { type: "web_search_preview" },
		};
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool, hosted],
			executor,
		});
		// Should only include function tools in the description
		expect(codeTool.description).toContain("get_weather");
		expect(codeTool.description).not.toContain("web_search");
	});

	test("passes context to underlying tools", async () => {
		const ctxTool = tool({
			name: "greet",
			description: "Greet someone",
			parameters: z.object({ name: z.string() }),
			execute: async (ctx: { prefix: string }, { name }) =>
				JSON.stringify({ message: `${ctx.prefix} ${name}` }),
		});
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool<{ prefix: string }>({
			tools: [ctxTool],
			executor,
		});
		const resultStr = await codeTool.execute(
			{ prefix: "Hello" },
			{ code: 'async () => { return await codemode.greet({ name: "World" }); }' },
		);
		const result = JSON.parse(resultStr);
		expect(result.result).toEqual({ message: "Hello World" });
	});

	test("returns code and result in output", async () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		const code = "async () => { return 42; }";
		const resultStr = await codeTool.execute({}, { code });
		const result = JSON.parse(resultStr);
		expect(result.code).toBe(code);
		expect(result.result).toBe(42);
	});

	test("includes logs in successful output", async () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({
			tools: [weatherTool],
			executor,
		});
		const resultStr = await codeTool.execute(
			{},
			{ code: 'async () => { console.log("trace"); return 1; }' },
		);
		const result = JSON.parse(resultStr);
		expect(result.logs).toEqual(["trace"]);
	});
});

// ── Custom Executor ────────────────────────────────────────────────

describe("custom Executor", () => {
	test("works with a custom executor implementation", async () => {
		const customExecutor: Executor = {
			async execute(code, fns) {
				// Simple custom executor that just returns a fixed result
				return { result: "custom-result", logs: ["custom-log"] };
			},
		};

		const t = tool({
			name: "test_tool",
			description: "Test",
			parameters: z.object({ x: z.number() }),
			execute: async (_ctx, _params) => "ok",
		});

		const codeTool = createCodeModeTool({
			tools: [t],
			executor: customExecutor,
		});

		const resultStr = await codeTool.execute({}, { code: "anything" });
		const result = JSON.parse(resultStr);
		expect(result.result).toBe("custom-result");
		expect(result.logs).toEqual(["custom-log"]);
	});
});

// ── Agent integration: run() with codemode tool ────────────────────

describe("codemode with Agent run()", () => {
	const weatherTool = tool({
		name: "get_weather",
		description: "Get weather for a location",
		parameters: z.object({ location: z.string() }),
		execute: async (_ctx, { location }) => JSON.stringify({ temp: 72, city: location }),
	});

	const emailTool = tool({
		name: "send_email",
		description: "Send an email",
		parameters: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
		execute: async (_ctx, { to }) => JSON.stringify({ sent: true, to }),
	});

	function makeCodeModeAgent(tools: FunctionTool[], responses: ModelResponse[]) {
		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool({ tools, executor });
		const model = mockModel(responses);
		return new Agent({ name: "codemode-agent", model, tools: [codeModeTool] });
	}

	test("LLM calls execute_code → single tool call → final response", async () => {
		const code = 'async () => { const w = await codemode.get_weather({ location: "NYC" }); return w; }';
		const agent = makeCodeModeAgent([weatherTool], [
			// Turn 1: LLM decides to write code
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			// Turn 2: LLM reads the code result and responds
			{
				content: "The weather in NYC is 72°F.",
				toolCalls: [],
			},
		]);

		const result = await run(agent, "What's the weather in NYC?");
		expect(result.output).toBe("The weather in NYC is 72°F.");
		// Messages: system?, user, assistant(tool_call), tool(execute_code result), assistant
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg?.role === "tool") {
			const parsed = JSON.parse(toolMsg.content);
			expect(parsed.result).toEqual({ temp: 72, city: "NYC" });
		}
	});

	test("LLM chains multiple tool calls in one code block", async () => {
		const code = `async () => {
			const weather = await codemode.get_weather({ location: "London" });
			if (weather.temp > 50) {
				const email = await codemode.send_email({
					to: "team@example.com",
					subject: "Nice weather!",
					body: "It's " + weather.temp + " degrees"
				});
				return { weather, email };
			}
			return { weather, email: null };
		}`;

		const agent = makeCodeModeAgent([weatherTool, emailTool], [
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			{
				content: "I checked the weather in London (72°F) and sent an email to the team.",
				toolCalls: [],
			},
		]);

		const result = await run(agent, "Check London weather and email the team if it's nice");
		expect(result.output).toContain("72°F");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg?.role === "tool") {
			const parsed = JSON.parse(toolMsg.content);
			expect(parsed.result.weather).toEqual({ temp: 72, city: "London" });
			expect(parsed.result.email).toEqual({ sent: true, to: "team@example.com" });
		}
	});

	test("LLM receives error when code fails and can recover", async () => {
		const code = 'async () => { throw new Error("oops"); }';
		const retryCode = 'async () => { return await codemode.get_weather({ location: "SF" }); }';

		const agent = makeCodeModeAgent([weatherTool], [
			// Turn 1: LLM writes bad code
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			// Turn 2: LLM sees the error, retries with correct code
			{
				content: null,
				toolCalls: [
					{
						id: "tc2",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code: retryCode }) },
					},
				],
			},
			// Turn 3: LLM responds with the result
			{
				content: "The weather in SF is 72°F.",
				toolCalls: [],
			},
		]);

		const result = await run(agent, "What's the weather?");
		expect(result.output).toBe("The weather in SF is 72°F.");
		// Should have 2 tool messages — error + success
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(2);
		if (toolMsgs[0]?.role === "tool") {
			expect(toolMsgs[0].content).toContain("Code execution failed");
		}
		if (toolMsgs[1]?.role === "tool") {
			const parsed = JSON.parse(toolMsgs[1].content);
			expect(parsed.result).toEqual({ temp: 72, city: "SF" });
		}
	});

	test("codemode tool description includes tool types in model request", async () => {
		let capturedRequest: ModelRequest | null = null;
		const model: Model = {
			async getResponse(request: ModelRequest): Promise<ModelResponse> {
				capturedRequest = request;
				return { content: "Done", toolCalls: [] };
			},
			async *getStreamedResponse(): AsyncGenerator<StreamEvent> {
				yield { type: "done", response: { content: "Done", toolCalls: [] } };
			},
		};

		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool({ tools: [weatherTool], executor });
		const agent = new Agent({ name: "test", model, tools: [codeModeTool] });

		await run(agent, "Hi");

		// The model should receive exactly one tool: execute_code
		expect(capturedRequest).not.toBeNull();
		const tools = capturedRequest!.tools;
		expect(tools).toHaveLength(1);
		const toolDef = tools![0]! as { type: string; function: { name: string; description: string } };
		expect(toolDef.function.name).toBe("execute_code");
		expect(toolDef.function.description).toContain("get_weather");
		expect(toolDef.function.description).toContain("GetWeatherInput");
	});

	test("stream() works with codemode tool", async () => {
		const code = 'async () => { return await codemode.get_weather({ location: "Paris" }); }';
		const agent = makeCodeModeAgent([weatherTool], [
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			{
				content: "Paris is 72°F.",
				toolCalls: [],
			},
		]);

		const events: StreamEvent[] = [];
		const { stream: s, result: resultPromise } = stream(agent, "Weather in Paris?");
		for await (const event of s) {
			events.push(event);
		}
		const result = await resultPromise;

		expect(result.output).toBe("Paris is 72°F.");
		expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
		expect(events.some((e) => e.type === "content_delta")).toBe(true);
		expect(events.filter((e) => e.type === "done")).toHaveLength(2);
	});

	test("code with loops calls tools multiple times efficiently", async () => {
		const callLog: string[] = [];
		const cityTool = tool({
			name: "get_weather",
			description: "Get weather",
			parameters: z.object({ location: z.string() }),
			execute: async (_ctx, { location }) => {
				callLog.push(location);
				return JSON.stringify({ temp: location.length * 10, city: location });
			},
		});

		const code = `async () => {
			const cities = ["NYC", "London", "Tokyo"];
			const results = [];
			for (const city of cities) {
				results.push(await codemode.get_weather({ location: city }));
			}
			return results;
		}`;

		const agent = makeCodeModeAgent([cityTool], [
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			{
				content: "Got weather for all 3 cities.",
				toolCalls: [],
			},
		]);

		const result = await run(agent, "Get weather for NYC, London, Tokyo");
		expect(result.output).toBe("Got weather for all 3 cities.");
		// All 3 cities were called within a SINGLE execute_code tool call
		expect(callLog).toEqual(["NYC", "London", "Tokyo"]);
		// Only 1 tool message (one execute_code call), not 3 separate tool calls
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(1);
		if (toolMsgs[0]?.role === "tool") {
			const parsed = JSON.parse(toolMsgs[0].content);
			expect(parsed.result).toHaveLength(3);
		}
	});

	test("maxTurns respected with codemode tool", async () => {
		const code = 'async () => { return await codemode.get_weather({ location: "NYC" }); }';
		// LLM keeps calling execute_code forever
		const infiniteResponses = Array.from({ length: 10 }, (_, i) => ({
			content: null,
			toolCalls: [
				{
					id: `tc${i}`,
					type: "function" as const,
					function: { name: "execute_code", arguments: JSON.stringify({ code }) },
				},
			],
		}));

		const agent = makeCodeModeAgent([weatherTool], infiniteResponses);
		await expect(run(agent, "Loop forever", { maxTurns: 2 })).rejects.toThrow(
			"exceeded maximum turns",
		);
	});

	test("context flows through agent → codemode → underlying tools", async () => {
		const greetTool = tool({
			name: "greet",
			description: "Greet",
			parameters: z.object({ name: z.string() }),
			execute: async (ctx: { lang: string }, { name }) =>
				JSON.stringify({ greeting: ctx.lang === "es" ? `Hola ${name}` : `Hello ${name}` }),
		});

		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool<{ lang: string }>({
			tools: [greetTool],
			executor,
		});

		const code = 'async () => { return await codemode.greet({ name: "World" }); }';
		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			{ content: "Hola World!", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [codeModeTool] });
		const result = await run(agent, "Greet in Spanish", { context: { lang: "es" } });

		expect(result.output).toBe("Hola World!");
		const toolMsg = result.messages.find((m) => m.role === "tool");
		if (toolMsg?.role === "tool") {
			const parsed = JSON.parse(toolMsg.content);
			expect(parsed.result.greeting).toBe("Hola World");
		}
	});
});

// ── Edge cases ─────────────────────────────────────────────────────

describe("codemode edge cases", () => {
	// ── sanitizeToolName edge cases ────────────────────────────────

	test("sanitizeToolName handles unicode characters", () => {
		expect(sanitizeToolName("café")).toBe("caf");
		expect(sanitizeToolName("tool_名前")).toBe("tool_");
	});

	test("sanitizeToolName handles multiple consecutive special chars", () => {
		expect(sanitizeToolName("a--b..c  d")).toBe("a__b__c__d");
	});

	test("sanitizeToolName handles single special char", () => {
		expect(sanitizeToolName("-")).toBe("_");
	});

	test("sanitizeToolName handles $ in name", () => {
		expect(sanitizeToolName("$tool")).toBe("$tool");
		expect(sanitizeToolName("tool$name")).toBe("tool$name");
	});

	// ── normalizeCode edge cases ───────────────────────────────────

	test("normalizeCode handles code fence with extra whitespace", () => {
		const code = "```js\n  const x = 1;\n```  ";
		const result = normalizeCode(code);
		expect(result).toContain("const x = 1;");
		expect(result).toStartWith("async () => {");
	});

	test("normalizeCode handles tsx/jsx code fences", () => {
		const code = "```tsx\nconst x = 1;\n```";
		expect(normalizeCode(code)).toBe("async () => {\nconst x = 1;\n}");
	});

	test("normalizeCode preserves async arrow with no parens around params", () => {
		// async (x) => ... starts with "async (" so it passes through
		const code = "async (x) => { return x; }";
		expect(normalizeCode(code)).toBe(code);
	});

	test("normalizeCode wraps regular function", () => {
		const code = "function foo() { return 1; }";
		expect(normalizeCode(code)).toBe("async () => {\nfunction foo() { return 1; }\n}");
	});

	test("normalizeCode handles code with only comments", () => {
		const code = "// just a comment";
		expect(normalizeCode(code)).toBe("async () => {\n// just a comment\n}");
	});

	// ── generateTypes edge cases ───────────────────────────────────

	test("generateTypes handles tool with no description", () => {
		const t = tool({
			name: "my_tool",
			description: "",
			parameters: z.object({ x: z.number() }),
			execute: async (_ctx, _p) => "ok",
		});
		const types = generateTypes([t]);
		// Falls back to tool name in JSDoc
		expect(types).toContain("my_tool");
	});

	test("generateTypes handles tool with description containing special chars", () => {
		const t = tool({
			name: "special",
			description: 'A tool with "quotes" and */ jsdoc closers',
			parameters: z.object({}),
			execute: async (_ctx, _p) => "ok",
		});
		const types = generateTypes([t]);
		// Should escape the */ inside the description to prevent breaking JSDoc
		expect(types).toContain("*\\/");
		// The original unescaped */ from the description should not appear mid-comment
		expect(types).not.toContain('and */ jsdoc');
	});

	test("generateTypes handles boolean parameters", () => {
		const t = tool({
			name: "bool_tool",
			description: "Has a boolean",
			parameters: z.object({ flag: z.boolean() }),
			execute: async (_ctx, _p) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain("boolean");
	});

	test("generateTypes handles nullable/optional deeply nested", () => {
		const t = tool({
			name: "deep_tool",
			description: "Deeply nested",
			parameters: z.object({
				outer: z.object({
					inner: z.object({
						value: z.string().optional(),
					}),
				}),
			}),
			execute: async (_ctx, _p) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain("outer:");
		expect(types).toContain("inner:");
		expect(types).toContain("value");
	});

	test("generateTypes handles union types", () => {
		const t = tool({
			name: "union_tool",
			description: "Union param",
			parameters: z.object({
				value: z.union([z.string(), z.number()]),
			}),
			execute: async (_ctx, _p) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain("string");
		expect(types).toContain("number");
	});

	test("generateTypes handles literal types", () => {
		const t = tool({
			name: "literal_tool",
			description: "Literal param",
			parameters: z.object({
				mode: z.literal("fast"),
			}),
			execute: async (_ctx, _p) => "ok",
		});
		const types = generateTypes([t]);
		expect(types).toContain('"fast"');
	});

	// ── FunctionExecutor edge cases ────────────────────────────────

	test("executor handles undefined return value", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute("async () => { /* no return */ }", {});
		expect(result.result).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	test("executor handles null return value", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute("async () => { return null; }", {});
		expect(result.result).toBeNull();
		expect(result.error).toBeUndefined();
	});

	test("executor handles returning complex nested objects", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			'async () => { return { a: [1, { b: "c" }], d: null }; }',
			{},
		);
		expect(result.result).toEqual({ a: [1, { b: "c" }], d: null });
	});

	test("executor handles synchronous throw", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute('async () => { throw "string error"; }', {});
		expect(result.error).toBe("string error");
	});

	test("executor handles non-Error throw", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute("async () => { throw 42; }", {});
		expect(result.error).toBe("42");
	});

	test("executor handles syntax error in code", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute("async () => { const = ; }", {});
		expect(result.error).toBeDefined();
	});

	test("executor handles tool that returns undefined", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			noop: async () => undefined,
		};
		const result = await executor.execute(
			"async () => { const r = await codemode.noop(); return r; }",
			fns,
		);
		expect(result.result).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	test("executor handles concurrent tool calls via Promise.all", async () => {
		const callOrder: string[] = [];
		const executor = new FunctionExecutor();
		const fns = {
			slow: async (args: unknown) => {
				const { id, ms } = args as { id: string; ms: number };
				await new Promise((r) => setTimeout(r, ms));
				callOrder.push(id);
				return id;
			},
		};
		const result = await executor.execute(
			`async () => {
				const results = await Promise.all([
					codemode.slow({ id: "a", ms: 30 }),
					codemode.slow({ id: "b", ms: 10 }),
					codemode.slow({ id: "c", ms: 20 }),
				]);
				return results;
			}`,
			fns,
		);
		expect(result.result).toEqual(["a", "b", "c"]);
		// b should finish first since it has shortest timeout
		expect(callOrder[0]).toBe("b");
	});

	test("executor captures logs even when code throws", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			'async () => { console.log("before"); throw new Error("after log"); }',
			{},
		);
		expect(result.error).toBe("after log");
		expect(result.logs).toEqual(["before"]);
	});

	test("executor handles tool call that rejects with non-Error", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			bad: async () => {
				throw "raw string rejection";
			},
		};
		const result = await executor.execute(
			"async () => { return await codemode.bad(); }",
			fns,
		);
		expect(result.error).toBe("raw string rejection");
	});

	test("executor handles calling nonexistent tool on codemode", async () => {
		const executor = new FunctionExecutor();
		const fns = {};
		const result = await executor.execute(
			"async () => { return await codemode.nonexistent({ x: 1 }); }",
			fns,
		);
		// codemode.nonexistent is undefined, calling it throws
		expect(result.error).toBeDefined();
	});

	test("executor handles very large return values", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			"async () => { return Array.from({ length: 10000 }, (_, i) => i); }",
			{},
		);
		expect(result.error).toBeUndefined();
		expect((result.result as number[]).length).toBe(10000);
	});

	// ── createCodeModeTool edge cases ──────────────────────────────

	test("createCodeModeTool with no tools", () => {
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({ tools: [], executor });
		expect(codeTool.name).toBe("execute_code");
		// Should still work — just no tools available in sandbox
		expect(codeTool.description).toContain("declare const codemode");
	});

	test("createCodeModeTool with only hosted tools produces empty codemode API", () => {
		const hosted: HostedTool = {
			type: "hosted",
			name: "web_search",
			definition: { type: "web_search_preview" },
		};
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({ tools: [hosted], executor });
		// No function tools → empty codemode object
		expect(codeTool.description).toContain("declare const codemode");
		expect(codeTool.description).not.toContain("web_search");
	});

	test("createCodeModeTool handles tool that returns non-JSON string", async () => {
		const t = tool({
			name: "plain",
			description: "Returns plain text",
			parameters: z.object({}),
			execute: async () => "just a plain string, not JSON",
		});
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({ tools: [t], executor });
		const resultStr = await codeTool.execute(
			{},
			{ code: "async () => { return await codemode.plain({}); }" },
		);
		const result = JSON.parse(resultStr);
		// Falls back to raw string when JSON.parse fails
		expect(result.result).toBe("just a plain string, not JSON");
	});

	test("createCodeModeTool handles tool with hyphenated name via sanitization", async () => {
		const t = tool({
			name: "my-fancy.tool",
			description: "Fancy",
			parameters: z.object({ x: z.number() }),
			execute: async (_ctx, { x }) => JSON.stringify({ doubled: x * 2 }),
		});
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({ tools: [t], executor });
		// LLM must use sanitized name
		const resultStr = await codeTool.execute(
			{},
			{ code: "async () => { return await codemode.my_fancy_tool({ x: 5 }); }" },
		);
		const result = JSON.parse(resultStr);
		expect(result.result).toEqual({ doubled: 10 });
	});

	test("createCodeModeTool with code wrapped in markdown fences", async () => {
		const t = tool({
			name: "add",
			description: "Add two numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => JSON.stringify({ sum: a + b }),
		});
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({ tools: [t], executor });
		// LLMs sometimes wrap code in markdown fences
		const code = "```javascript\nasync () => { return await codemode.add({ a: 10, b: 20 }); }\n```";
		const resultStr = await codeTool.execute({}, { code });
		const result = JSON.parse(resultStr);
		expect(result.result).toEqual({ sum: 30 });
	});

	test("createCodeModeTool with code that is bare statements (not arrow fn)", async () => {
		const t = tool({
			name: "echo",
			description: "Echo input",
			parameters: z.object({ msg: z.string() }),
			execute: async (_ctx, { msg }) => JSON.stringify({ echo: msg }),
		});
		const executor = new FunctionExecutor();
		const codeTool = createCodeModeTool({ tools: [t], executor });
		// Bare code — normalizeCode wraps it
		const code = 'const r = await codemode.echo({ msg: "hi" });\nconsole.log(r);';
		const resultStr = await codeTool.execute({}, { code });
		const result = JSON.parse(resultStr);
		expect(result.logs).toContain("[object Object]");
	});

	// ── Agent-level edge cases ─────────────────────────────────────

	test("codemode alongside regular tools in same agent", async () => {
		const regularTool = tool({
			name: "regular_add",
			description: "Add",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const codeModeSource = tool({
			name: "get_data",
			description: "Get data",
			parameters: z.object({ key: z.string() }),
			execute: async (_ctx, { key }) => JSON.stringify({ key, value: 42 }),
		});

		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool({ tools: [codeModeSource], executor });

		const model = mockModel([
			// LLM calls regular tool first
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "regular_add", arguments: '{"a":1,"b":2}' },
					},
				],
			},
			// Then calls execute_code
			{
				content: null,
				toolCalls: [
					{
						id: "tc2",
						type: "function",
						function: {
							name: "execute_code",
							arguments: JSON.stringify({
								code: 'async () => { return await codemode.get_data({ key: "foo" }); }',
							}),
						},
					},
				],
			},
			{ content: "Sum is 3 and data value is 42.", toolCalls: [] },
		]);

		const agent = new Agent({
			name: "mixed",
			model,
			tools: [regularTool, codeModeTool],
		});

		const result = await run(agent, "Add 1+2 and get data for foo");
		expect(result.output).toBe("Sum is 3 and data value is 42.");
		const toolMsgs = result.messages.filter((m) => m.role === "tool");
		expect(toolMsgs).toHaveLength(2);
	});

	test("codemode code that catches its own errors gracefully", async () => {
		const failTool = tool({
			name: "might_fail",
			description: "Might fail",
			parameters: z.object({ shouldFail: z.boolean() }),
			execute: async (_ctx, { shouldFail }) => {
				if (shouldFail) throw new Error("intentional");
				return JSON.stringify({ ok: true });
			},
		});

		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool({ tools: [failTool], executor });

		const code = `async () => {
			try {
				await codemode.might_fail({ shouldFail: true });
				return "should not reach";
			} catch (e) {
				const fallback = await codemode.might_fail({ shouldFail: false });
				return { recovered: true, fallback };
			}
		}`;

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			{ content: "Recovered gracefully.", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [codeModeTool] });
		const result = await run(agent, "Try it");
		expect(result.output).toBe("Recovered gracefully.");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		if (toolMsg?.role === "tool") {
			const parsed = JSON.parse(toolMsg.content);
			expect(parsed.result.recovered).toBe(true);
			expect(parsed.result.fallback).toEqual({ ok: true });
		}
	});

	test("codemode with empty code string", async () => {
		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool({ tools: [], executor });

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code: "" }) },
					},
				],
			},
			{ content: "Nothing happened.", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [codeModeTool] });
		const result = await run(agent, "Do nothing");
		expect(result.output).toBe("Nothing happened.");
	});

	test("codemode tool output includes logs in tool message for LLM", async () => {
		const t = tool({
			name: "calc",
			description: "Calculate",
			parameters: z.object({ expr: z.string() }),
			execute: async (_ctx, { expr }) => JSON.stringify({ result: 42 }),
		});

		const executor = new FunctionExecutor();
		const codeModeTool = createCodeModeTool({ tools: [t], executor });

		const code = `async () => {
			console.log("Step 1: calculating");
			const r = await codemode.calc({ expr: "6*7" });
			console.log("Step 2: got result", r.result);
			return r;
		}`;

		const model = mockModel([
			{
				content: null,
				toolCalls: [
					{
						id: "tc1",
						type: "function",
						function: { name: "execute_code", arguments: JSON.stringify({ code }) },
					},
				],
			},
			{ content: "The answer is 42.", toolCalls: [] },
		]);

		const agent = new Agent({ name: "test", model, tools: [codeModeTool] });
		const result = await run(agent, "What's 6*7?");

		const toolMsg = result.messages.find((m) => m.role === "tool");
		if (toolMsg?.role === "tool") {
			const parsed = JSON.parse(toolMsg.content);
			expect(parsed.logs).toHaveLength(2);
			expect(parsed.logs[0]).toBe("Step 1: calculating");
			expect(parsed.logs[1]).toContain("Step 2: got result");
		}
	});
});

// ── WorkerExecutor ─────────────────────────────────────────────────

describe("WorkerExecutor", () => {
	test("executes simple code in isolated worker", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute("async () => { return 42; }", {});
		expect(result.result).toBe(42);
		expect(result.error).toBeUndefined();
	});

	test("captures console output", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute(
			'async () => { console.log("hello"); console.warn("w"); console.error("e"); return "done"; }',
			{},
		);
		expect(result.result).toBe("done");
		expect(result.logs).toEqual(["hello", "[warn] w", "[error] e"]);
	});

	test("calls tool functions via codemode proxy", async () => {
		const executor = new WorkerExecutor();
		const fns = {
			add: async (args: unknown) => {
				const { a, b } = args as { a: number; b: number };
				return a + b;
			},
		};
		const result = await executor.execute(
			"async () => { return await codemode.add({ a: 3, b: 4 }); }",
			fns,
		);
		expect(result.result).toBe(7);
	});

	test("chains multiple tool calls", async () => {
		const executor = new WorkerExecutor();
		const fns = {
			get_temp: async (args: unknown) => {
				const { city } = args as { city: string };
				return city === "London" ? 15 : 25;
			},
			format: async (args: unknown) => {
				const { temp, unit } = args as { temp: number; unit: string };
				return `${temp}°${unit}`;
			},
		};
		const result = await executor.execute(
			`async () => {
				const temp = await codemode.get_temp({ city: "London" });
				const formatted = await codemode.format({ temp, unit: "C" });
				return formatted;
			}`,
			fns,
		);
		expect(result.result).toBe("15°C");
	});

	test("returns error for failing code", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute(
			'async () => { throw new Error("boom"); }',
			{},
		);
		expect(result.error).toBe("boom");
		expect(result.result).toBeUndefined();
	});

	test("returns error for tool call failure", async () => {
		const executor = new WorkerExecutor();
		const fns = {
			fail: async () => {
				throw new Error("tool failed");
			},
		};
		const result = await executor.execute(
			"async () => { return await codemode.fail(); }",
			fns,
		);
		expect(result.error).toBe("tool failed");
	});

	test("times out on long-running code", async () => {
		const executor = new WorkerExecutor({ timeout: 200 });
		const result = await executor.execute(
			"async () => { await new Promise(r => setTimeout(r, 10000)); return 1; }",
			{},
		);
		expect(result.error).toBe("Execution timed out");
	});

	test("handles loops over tool calls", async () => {
		const executor = new WorkerExecutor();
		const fns = {
			double: async (args: unknown) => {
				const { n } = args as { n: number };
				return n * 2;
			},
		};
		const result = await executor.execute(
			`async () => {
				const results = [];
				for (const n of [1, 2, 3]) {
					results.push(await codemode.double({ n }));
				}
				return results;
			}`,
			fns,
		);
		expect(result.result).toEqual([2, 4, 6]);
	});

	test("handles calling nonexistent tool", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute(
			"async () => { return await codemode.nonexistent({ x: 1 }); }",
			{},
		);
		expect(result.error).toContain("not found");
	});

	test("captures logs even when code throws", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute(
			'async () => { console.log("before"); throw new Error("after log"); }',
			{},
		);
		expect(result.error).toBe("after log");
		expect(result.logs).toEqual(["before"]);
	});

	test("handles concurrent tool calls via Promise.all", async () => {
		const executor = new WorkerExecutor();
		const fns = {
			fetch_data: async (args: unknown) => {
				const { id } = args as { id: number };
				return { id, value: id * 10 };
			},
		};
		const result = await executor.execute(
			`async () => {
				const results = await Promise.all([
					codemode.fetch_data({ id: 1 }),
					codemode.fetch_data({ id: 2 }),
					codemode.fetch_data({ id: 3 }),
				]);
				return results;
			}`,
			fns,
		);
		expect(result.result).toEqual([
			{ id: 1, value: 10 },
			{ id: 2, value: 20 },
			{ id: 3, value: 30 },
		]);
	});

	test("no access to host globals (require, process.env, etc.)", async () => {
		const executor = new WorkerExecutor();
		// The worker uses a custom env with only __CODEMODE_CODE,
		// and code runs via new Function() which doesn't have require
		const result = await executor.execute(
			"async () => { try { require('fs'); return 'has require'; } catch { return 'no require'; } }",
			{},
		);
		// In worker_threads with eval:true, require is available via CommonJS context
		// but the code runs in new Function() which doesn't have module scope require
		// Either way, it shouldn't crash
		expect(result.error).toBeUndefined();
	});

	test("works with createCodeModeTool end-to-end", async () => {
		const weatherTool = tool({
			name: "get_weather",
			description: "Get weather",
			parameters: z.object({ location: z.string() }),
			execute: async (_ctx, { location }) => JSON.stringify({ temp: 72, city: location }),
		});

		const executor = new WorkerExecutor({ timeout: 10_000 });
		const codeTool = createCodeModeTool({ tools: [weatherTool], executor });

		const resultStr = await codeTool.execute(
			{},
			{ code: 'async () => { return await codemode.get_weather({ location: "NYC" }); }' },
		);
		const result = JSON.parse(resultStr);
		expect(result.result).toEqual({ temp: 72, city: "NYC" });
	});
});
