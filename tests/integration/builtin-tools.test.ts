import { describe, expect, test } from "bun:test";
import { Agent } from "../../src/core/agent";
import { webSearchTool, codeInterpreterTool } from "../../src/core/builtin-tools";
import { run, stream } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { StratusError } from "../../src/core/errors";
import { z } from "zod";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

describe("builtin tools: web search", () => {
	test("agent with webSearchTool answers a current events question", async () => {
		const agent = new Agent({
			name: "search-agent",
			model,
			instructions: "You are a helpful assistant with web search. Answer the user's question concisely.",
			tools: [webSearchTool()],
		});

		const result = await run(agent, "What is the current population of Tokyo? Just give the number.", {
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		expect(result.output!.length).toBeGreaterThan(5);
		// Should contain some numeric content about population
		expect(result.output).toMatch(/\d/);
	}, 30000);

	test("webSearchTool works with streaming", async () => {
		const agent = new Agent({
			name: "stream-search-agent",
			model,
			instructions: "Answer concisely using web search.",
			tools: [webSearchTool()],
		});

		const { stream: s, result: resultPromise } = stream(agent, "Who is the current US president?", {
			maxTurns: 3,
		});

		const events: string[] = [];
		for await (const event of s) {
			events.push(event.type);
		}

		const result = await resultPromise;
		expect(result.output).toBeTruthy();
		expect(events).toContain("content_delta");
		expect(events).toContain("done");
	}, 30000);

	test("webSearchTool with searchContextSize config", async () => {
		const agent = new Agent({
			name: "configured-search",
			model,
			instructions: "Answer concisely.",
			tools: [webSearchTool({ searchContextSize: "low" })],
		});

		const result = await run(agent, "What day is it today?", { maxTurns: 3 });
		expect(result.output).toBeTruthy();
	}, 30000);
});

describe("builtin tools: code interpreter", () => {
	// Requires a deployment that supports code_interpreter (not all models do)
	test.skip("agent with codeInterpreterTool executes Python code", async () => {
		const agent = new Agent({
			name: "code-agent",
			model,
			instructions: "You are a helpful assistant with code execution. Use the code interpreter to compute answers.",
			tools: [codeInterpreterTool()],
		});

		const result = await run(agent, "What is 2^100? Use code to compute it exactly.", {
			maxTurns: 3,
		});

		expect(result.output).toBeTruthy();
		// 2^100 = 1267650600228229401496703205376
		expect(result.output).toContain("1267650600228229401496703205376");
	}, 60000);
});

describe("builtin tools: mixed with function tools", () => {
	test("agent uses both hosted and function tools", async () => {
		let functionToolCalled = false;

		const formatResult = tool({
			name: "format_result",
			description: "Format a result as a bullet list",
			parameters: z.object({ items: z.array(z.string()) }),
			execute: async (_ctx, { items }) => {
				functionToolCalled = true;
				return items.map((item) => `- ${item}`).join("\n");
			},
		});

		const agent = new Agent({
			name: "mixed-agent",
			model,
			instructions:
				"You have web search and a format_result tool. Search the web for the answer, then use format_result to format your findings as a list of 3 key facts. Always use both tools.",
			tools: [webSearchTool(), formatResult],
		});

		const result = await run(agent, "Find 3 key facts about TypeScript and format them.", {
			maxTurns: 5,
		});

		expect(result.output).toBeTruthy();
		// The function tool should have been called
		expect(functionToolCalled).toBe(true);
	}, 60000);
});

describe("builtin tools: chat completions rejection", () => {
	test("AzureChatCompletionsModel throws when given hosted tools", async () => {
		const chatModel = new AzureChatCompletionsModel({
			endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
			apiKey: process.env.AZURE_OPENAI_API_KEY!,
			deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
		});

		const agent = new Agent({
			name: "should-fail",
			model: chatModel,
			tools: [webSearchTool()],
		});

		try {
			await run(agent, "Hello");
			expect(true).toBe(false); // should not reach
		} catch (error) {
			expect(error).toBeInstanceOf(StratusError);
			expect((error as StratusError).message).toContain("Hosted tools");
			expect((error as StratusError).message).toContain("AzureResponsesModel");
		}
	});
});

describe("builtin tools: toolChoice with responses API", () => {
	test("toolChoice specific function works with Responses API", async () => {
		const greetTool = tool({
			name: "greet",
			description: "Greet a person by name",
			parameters: z.object({ name: z.string() }),
			execute: async (_ctx, { name }) => `Hello, ${name}!`,
		});

		const agent = new Agent({
			name: "forced-tool",
			model,
			tools: [greetTool],
			modelSettings: {
				toolChoice: { type: "function", function: { name: "greet" } },
			},
			toolUseBehavior: "stop_on_first_tool",
		});

		const result = await run(agent, "Say hi to Alice");
		expect(result.output).toContain("Hello, Alice");
	}, 30000);
});
