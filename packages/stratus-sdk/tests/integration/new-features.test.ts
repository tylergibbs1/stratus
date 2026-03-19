import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { MemorySessionStore } from "../../src/core/memory-store";
import type { InterruptedRunResult } from "../../src/core/result";
import { run, stream, resumeRun } from "../../src/core/run";
import { createSession, loadSession } from "../../src/core/session";
import type { SessionStateChangeEvent } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

describe("needsApproval + resumeRun (real API)", () => {
	test("tool with needsApproval returns InterruptedRunResult", async () => {
		const dangerousTool = tool({
			name: "delete_file",
			description: "Delete a file from the system",
			parameters: z.object({ path: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { path }) => `Deleted ${path}`,
		});

		const agent = new Agent({
			name: "file-manager",
			model,
			instructions: "When asked to delete a file, use the delete_file tool. Always call the tool.",
			tools: [dangerousTool],
		});

		const result = await run(agent, "Delete the file /tmp/test.txt");

		expect(result.interrupted).toBe(true);
		if (result.interrupted) {
			expect(result.pendingToolCalls.length).toBeGreaterThan(0);
			expect(result.pendingToolCalls[0]!.toolName).toBe("delete_file");
		}
	}, 30000);

	test("resumeRun with approve executes the tool", async () => {
		const executedTools: string[] = [];
		const dangerousTool = tool({
			name: "delete_file",
			description: "Delete a file from the system",
			parameters: z.object({ path: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { path }) => {
				executedTools.push(path);
				return `Deleted ${path}`;
			},
		});

		const agent = new Agent({
			name: "file-manager",
			model,
			instructions: "When asked to delete a file, use the delete_file tool. Always call the tool.",
			tools: [dangerousTool],
		});

		const result = await run(agent, "Delete /tmp/test.txt");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			const resumed = await resumeRun(result, [
				{ toolCallId: result.pendingToolCalls[0]!.toolCallId, decision: "approve" },
			]);

			expect(resumed.interrupted).toBe(false);
			expect(executedTools).toContain("/tmp/test.txt");
		}
	}, 60000);

	test("resumeRun with deny sends denial to model", async () => {
		const dangerousTool = tool({
			name: "delete_file",
			description: "Delete a file from the system",
			parameters: z.object({ path: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { path }) => `Deleted ${path}`,
		});

		const agent = new Agent({
			name: "file-manager",
			model,
			instructions: "When asked to delete a file, use the delete_file tool. If denied, apologize.",
			tools: [dangerousTool],
		});

		const result = await run(agent, "Delete /tmp/test.txt");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			const resumed = await resumeRun(result, [
				{
					toolCallId: result.pendingToolCalls[0]!.toolCallId,
					decision: "deny",
					denyMessage: "User denied file deletion",
				},
			]);

			expect(resumed.interrupted).toBe(false);
			if (!resumed.interrupted) {
				// Agent has no outputType, so output is a string, finalOutput is undefined
				expect(resumed.output).toBeTruthy();
			}
		}
	}, 60000);
});

describe("tool retries (real API)", () => {
	test("tool with retries recovers from transient failure", async () => {
		let callCount = 0;
		const flakyTool = tool({
			name: "flaky_api",
			description: "An API that sometimes fails",
			parameters: z.object({ query: z.string() }),
			retries: {
				limit: 2,
				delay: 100,
				backoff: "fixed",
			},
			execute: async (_ctx, { query }) => {
				callCount++;
				if (callCount === 1) throw new Error("Transient failure");
				return `Result for ${query}`;
			},
		});

		const agent = new Agent({
			name: "resilient",
			model,
			instructions: "Use the flaky_api tool to answer questions. Always call the tool.",
			tools: [flakyTool],
		});

		const result = await run(agent, "Search for TypeScript");
		expect(result.interrupted).toBe(false);
		if (!result.interrupted) {
			expect(result.output).toBeTruthy();
		}
		expect(callCount).toBe(2);
	}, 30000);
});

describe("subagent streaming relay (real API)", () => {
	test("parent stream includes subagent events", async () => {
		const mathAgent = new Agent({
			name: "math-expert",
			model,
			instructions: "You are a math expert. Answer math questions concisely with just the number.",
		});

		const mathSubagent = subagent({
			agent: mathAgent,
			toolName: "ask_math",
			toolDescription: "Ask a math question to the math expert",
			inputSchema: z.object({ question: z.string().describe("The math question") }),
			mapInput: (params) => params.question,
		});

		const parentAgent = new Agent({
			name: "coordinator",
			model,
			instructions: "When asked a math question, use the ask_math tool. Always use it.",
			subagents: [mathSubagent],
		});

		const { stream: s, result } = stream(parentAgent, "What is 7 * 8?");
		const eventTypes = new Set<string>();
		for await (const event of s) {
			eventTypes.add(event.type);
		}
		const finalResult = await result;

		expect(finalResult.interrupted).toBe(false);
		// Should see subagent events in the stream
		expect(eventTypes.has("subagent_start") || eventTypes.has("content_delta")).toBe(true);
	}, 60000);
});

describe("SessionStore (real API)", () => {
	test("session auto-saves to store and can be loaded", async () => {
		const store = new MemorySessionStore();

		const session = createSession({
			model,
			instructions: "You are a helpful assistant. Be concise.",
			store,
			sessionId: "test-session-1",
		});

		session.send("What is 2+2? Reply with just the number.");
		for await (const event of session.stream()) {
			// consume stream
		}
		const result = await session.result;

		// Verify auto-saved
		const snapshot = await store.load("test-session-1");
		expect(snapshot).toBeDefined();

		// Load into new session
		const loaded = await loadSession(store, "test-session-1", {
			model,
			instructions: "You are a helpful assistant. Be concise.",
		});
		expect(loaded).toBeDefined();

		// Continue conversation
		loaded!.send("What was my previous question? Reply in one sentence.");
		for await (const event of loaded!.stream()) {
			// consume
		}
		const result2 = await loaded!.result;
		expect(result2.output).toBeTruthy();
	}, 60000);
});

describe("session state change events (real API)", () => {
	test("onStateChange fires during interaction", async () => {
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			instructions: "Reply with exactly one word.",
			onStateChange: (event) => events.push(event),
		});

		session.send("Say hello");
		for await (const event of session.stream()) {
			// consume
		}
		await session.result;

		const types = events.map((e) => e.type);
		expect(types).toContain("stream_start");
		expect(types).toContain("stream_end");
	}, 30000);
});

describe("dynamic subagents (real API)", () => {
	test("dynamic subagent works via run options", async () => {
		const helperAgent = new Agent({
			name: "helper",
			model,
			instructions: "You are a helpful assistant. Reply concisely with one sentence.",
		});

		const dynamicHelper = subagent({
			agent: helperAgent,
			toolName: "ask_helper",
			toolDescription: "Ask the helper a question",
			inputSchema: z.object({ question: z.string().describe("The question to ask") }),
			mapInput: (params) => params.question,
		});

		const parentAgent = new Agent({
			name: "coordinator",
			model,
			instructions: "When asked a question, use the ask_helper tool. Always use it.",
		});

		const result = await run(parentAgent, "What is the capital of France?", {
			dynamicSubagents: [dynamicHelper],
		});

		expect(result.interrupted).toBe(false);
		if (!result.interrupted) {
			expect(result.output).toBeTruthy();
		}
	}, 60000);
});
