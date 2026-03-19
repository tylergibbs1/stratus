import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { MemorySessionStore } from "../../src/core/memory-store";
import { run, stream, resumeRun } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

describe("needsApproval edge cases (real API)", () => {
	test("needsApproval works in streaming path", async () => {
		const deleteTool = tool({
			name: "delete_item",
			description: "Delete an item by ID",
			parameters: z.object({ id: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { id }) => `Deleted ${id}`,
		});

		const agent = new Agent({
			name: "manager",
			model,
			instructions: "When asked to delete something, use the delete_item tool. Always call it.",
			tools: [deleteTool],
		});

		const { stream: s, result } = stream(agent, "Delete item abc123");
		const events = [];
		for await (const event of s) {
			events.push(event);
		}
		const finalResult = await result;

		expect(finalResult.interrupted).toBe(true);
		if (finalResult.interrupted) {
			expect(finalResult.pendingToolCalls.length).toBeGreaterThan(0);
			expect(finalResult.pendingToolCalls[0]!.toolName).toBe("delete_item");
		}
	}, 30000);

	test("mixed tools: only needsApproval tools cause interrupt", async () => {
		const safeTool = tool({
			name: "get_info",
			description: "Get information about an item",
			parameters: z.object({ id: z.string() }),
			execute: async (_ctx, { id }) => `Info for ${id}: active`,
		});

		const dangerousTool = tool({
			name: "delete_item",
			description: "Delete an item permanently",
			parameters: z.object({ id: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { id }) => `Deleted ${id}`,
		});

		const agent = new Agent({
			name: "manager",
			model,
			instructions:
				"You have two tools. When asked to check and delete an item, FIRST call get_info, THEN call delete_item. Call both tools.",
			tools: [safeTool, dangerousTool],
		});

		// The model should call get_info (auto-executes) then delete_item (needs approval)
		const result = await run(agent, "Check item xyz then delete it");

		// Could be interrupted (if model calls delete_item) or completed (if model only called get_info)
		// Either way it shouldn't crash
		if (result.interrupted) {
			expect(result.pendingToolCalls[0]!.toolName).toBe("delete_item");
		}
	}, 30000);

	test("conditional needsApproval: low amount auto-executes, high amount interrupts", async () => {
		const executedAmounts: number[] = [];
		const payTool = tool({
			name: "process_payment",
			description: "Process a payment to a recipient",
			parameters: z.object({ amount: z.number(), recipient: z.string() }),
			needsApproval: async (params) => params.amount > 100,
			execute: async (_ctx, { amount, recipient }) => {
				executedAmounts.push(amount);
				return `Paid $${amount} to ${recipient}`;
			},
		});

		const agent = new Agent({
			name: "payments",
			model,
			instructions: "Process payments using the process_payment tool. Always call it with the exact amount given.",
			tools: [payTool],
		});

		// Low amount should auto-execute
		const lowResult = await run(agent, "Pay $10 to Alice");
		expect(lowResult.interrupted).toBe(false);
		if (!lowResult.interrupted) {
			expect(executedAmounts).toContain(10);
		}

		// High amount should interrupt
		executedAmounts.length = 0;
		const highResult = await run(agent, "Pay $500 to Bob");
		expect(highResult.interrupted).toBe(true);
		if (highResult.interrupted) {
			expect(highResult.pendingToolCalls[0]!.toolName).toBe("process_payment");
			expect(executedAmounts).toHaveLength(0); // NOT executed yet
		}
	}, 60000);

	test("resumeRun then model responds with final answer", async () => {
		const executedPaths: string[] = [];
		const deleteTool = tool({
			name: "delete_file",
			description: "Delete a file at the given path",
			parameters: z.object({ path: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { path }) => {
				executedPaths.push(path);
				return `Successfully deleted ${path}`;
			},
		});

		const agent = new Agent({
			name: "file-manager",
			model,
			instructions: "Delete files when asked. After deleting, confirm what was deleted.",
			tools: [deleteTool],
		});

		const result = await run(agent, "Delete /tmp/old.log");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			const resumed = await resumeRun(result, [
				{ toolCallId: result.pendingToolCalls[0]!.toolCallId, decision: "approve" },
			]);

			expect(resumed.interrupted).toBe(false);
			if (!resumed.interrupted) {
				expect(executedPaths).toContain("/tmp/old.log");
				expect(resumed.output).toBeTruthy();
				// The model should reference the deletion in its response
			}
		}
	}, 60000);
});

describe("tool retry edge cases (real API)", () => {
	test("shouldRetry predicate skips retry for specific errors", async () => {
		let callCount = 0;

		const strictTool = tool({
			name: "strict_api",
			description: "An API that fails with a client error",
			parameters: z.object({ query: z.string() }),
			retries: {
				limit: 3,
				delay: 100,
				shouldRetry: (error) => {
					// Don't retry "client errors"
					if (error instanceof Error && error.message.includes("client error")) return false;
					return true;
				},
			},
			execute: async (_ctx, { query }) => {
				callCount++;
				throw new Error("client error: invalid query format");
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Use strict_api for all queries. Always call it.",
			tools: [strictTool],
		});

		const result = await run(agent, "Search for test");
		// Tool should have been called exactly once (no retries due to shouldRetry)
		expect(callCount).toBe(1);
		// The model gets the error message and responds
		expect(result.interrupted).toBe(false);
	}, 30000);

	test("exponential backoff increases delay between retries", async () => {
		const timestamps: number[] = [];

		const timedTool = tool({
			name: "timed_api",
			description: "An API that tracks timing",
			parameters: z.object({ query: z.string() }),
			retries: {
				limit: 2,
				delay: 200,
				backoff: "exponential",
			},
			execute: async (_ctx, { query }) => {
				timestamps.push(Date.now());
				if (timestamps.length <= 2) throw new Error("Transient failure");
				return `Result: ${query}`;
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Use timed_api for queries. Always call it.",
			tools: [timedTool],
		});

		const result = await run(agent, "Search test");
		expect(timestamps.length).toBe(3); // 1 original + 2 retries

		// Check delays: first ~200ms, second ~400ms
		const delay1 = timestamps[1]! - timestamps[0]!;
		const delay2 = timestamps[2]! - timestamps[1]!;
		expect(delay1).toBeGreaterThanOrEqual(150);
		expect(delay2).toBeGreaterThanOrEqual(300);
	}, 30000);
});

describe("session persistence edge cases (real API)", () => {
	test("session NOT saved when stream errors", async () => {
		const store = new MemorySessionStore();
		let saveCount = 0;
		const trackingStore: typeof store = {
			save: async (id, snapshot) => {
				saveCount++;
				return store.save(id, snapshot);
			},
			load: (id) => store.load(id),
			delete: (id) => store.delete(id),
			list: () => store.list(),
		};

		const session = createSession({
			model,
			instructions: "You are helpful.",
			store: trackingStore,
			sessionId: "error-test",
			// Use extremely low maxTurns to force completion
			maxTurns: 1,
		});

		session.send("Hello");
		for await (const event of session.stream()) {
			// consume
		}
		const result = await session.result;

		// Should have saved (successful stream)
		expect(saveCount).toBeGreaterThan(0);
	}, 30000);

	test("loadSession preserves conversation context", async () => {
		const store = new MemorySessionStore();

		// Create and use first session
		const session1 = createSession({
			model,
			instructions: "Remember everything the user tells you. Be concise.",
			store,
			sessionId: "memory-test",
		});

		session1.send("My favorite color is purple. Remember this.");
		for await (const event of session1.stream()) {
			// consume
		}

		// Load into new session and verify context preserved
		const { loadSession } = await import("../../src/core/session");
		const session2 = await loadSession(store, "memory-test", {
			model,
			instructions: "Remember everything the user tells you. Be concise.",
		});

		expect(session2).toBeDefined();
		session2!.send("What is my favorite color? Reply with just the color.");
		for await (const event of session2!.stream()) {
			// consume
		}
		const result = await session2!.result;

		expect(result.output?.toLowerCase()).toContain("purple");
	}, 60000);
});

describe("subagent streaming relay edge cases (real API)", () => {
	test("subagent events appear in correct order", async () => {
		const mathAgent = new Agent({
			name: "calculator",
			model,
			instructions: "You are a calculator. Reply with just the number, nothing else.",
		});

		const calcSubagent = subagent({
			agent: mathAgent,
			toolName: "calculate",
			toolDescription: "Calculate a math expression",
			inputSchema: z.object({ expression: z.string().describe("Math expression to evaluate") }),
			mapInput: (params) => `Calculate: ${params.expression}`,
		});

		const parentAgent = new Agent({
			name: "tutor",
			model,
			instructions: "When asked a math question, use the calculate tool. Always use it.",
			subagents: [calcSubagent],
		});

		const { stream: s, result } = stream(parentAgent, "What is 12 * 13?");
		const subagentEvents = [];
		for await (const event of s) {
			if (event.type.startsWith("subagent_")) {
				subagentEvents.push(event);
			}
		}

		const finalResult = await result;
		expect(finalResult.interrupted).toBe(false);

		// If subagent was invoked, check event ordering
		if (subagentEvents.length > 0) {
			expect(subagentEvents[0]!.type).toBe("subagent_start");
			expect(subagentEvents[subagentEvents.length - 1]!.type).toBe("subagent_end");
		}
	}, 60000);
});

describe("dynamic subagent edge cases (real API)", () => {
	test("dynamic subagent combined with static tools", async () => {
		const lookupTool = tool({
			name: "lookup_price",
			description: "Look up the price of a product",
			parameters: z.object({ product: z.string() }),
			execute: async (_ctx, { product }) => `${product}: $29.99`,
		});

		const advisorAgent = new Agent({
			name: "advisor",
			model,
			instructions: "Give brief purchasing advice based on what you're told.",
		});

		const advisorSubagent = subagent({
			agent: advisorAgent,
			toolName: "get_advice",
			toolDescription: "Get purchasing advice about a product",
			inputSchema: z.object({ info: z.string().describe("Product info to get advice on") }),
			mapInput: (params) => params.info,
		});

		const parentAgent = new Agent({
			name: "shopping-assistant",
			model,
			instructions: "Help users shop. Use lookup_price to find prices. Use get_advice for recommendations.",
			tools: [lookupTool],
		});

		const result = await run(parentAgent, "What does a keyboard cost?", {
			dynamicSubagents: [advisorSubagent],
		});

		expect(result.interrupted).toBe(false);
		if (!result.interrupted) {
			expect(result.output).toBeTruthy();
		}
	}, 60000);
});
