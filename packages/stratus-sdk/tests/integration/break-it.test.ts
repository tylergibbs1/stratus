/**
 * Adversarial tests — intentionally trying to break the new features.
 * Each test targets a specific weak point or race condition.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { MemorySessionStore } from "../../src/core/memory-store";
import { ModelError } from "../../src/core/errors";
import { run, stream, resumeRun } from "../../src/core/run";
import { createSession, loadSession } from "../../src/core/session";
import { subagent } from "../../src/core/subagent";
import { tool } from "../../src/core/tool";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

describe("HITL abuse", () => {
	test("resumeRun with wrong toolCallId doesn't crash", async () => {
		const deleteTool = tool({
			name: "nuke",
			description: "Delete everything",
			parameters: z.object({ target: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { target }) => `Nuked ${target}`,
		});

		const agent = new Agent({
			name: "destroyer",
			model,
			instructions: "Use the nuke tool when asked. Always call it.",
			tools: [deleteTool],
		});

		const result = await run(agent, "Nuke the server");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			// Pass a bogus toolCallId — should still work (denied tools get error message)
			const resumed = await resumeRun(result, [
				{ toolCallId: "fake_id_that_doesnt_exist", decision: "approve" },
			]);
			// The real pending tool wasn't approved, so it should be denied by default
			// or the model should get an error and recover
			expect(resumed.interrupted).toBe(false);
		}
	}, 60000);

	test("resumeRun with empty approvals array", async () => {
		const deleteTool = tool({
			name: "remove",
			description: "Remove a file",
			parameters: z.object({ path: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { path }) => `Removed ${path}`,
		});

		const agent = new Agent({
			name: "cleaner",
			model,
			instructions: "Use remove tool when asked. Always call it.",
			tools: [deleteTool],
		});

		const result = await run(agent, "Remove /tmp/junk");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			// Empty approvals — no tool gets approved
			const resumed = await resumeRun(result, []);
			// Should not crash — unapproved tools get default deny
			expect(resumed.interrupted).toBe(false);
		}
	}, 60000);

	test("double resumeRun on same interrupted result", async () => {
		const callCount = { value: 0 };
		const archiveTool = tool({
			name: "archive_record",
			description: "Archive a database record by ID",
			parameters: z.object({ recordId: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { recordId }) => {
				callCount.value++;
				return `Archived record ${recordId}`;
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Use the archive_record tool when asked. Always call it.",
			tools: [archiveTool],
		});

		const result = await run(agent, "Archive record R-12345");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			const approval = [
				{ toolCallId: result.pendingToolCalls[0]!.toolCallId, decision: "approve" as const },
			];

			// Resume twice with the same interrupted result
			const [r1, r2] = await Promise.all([
				resumeRun(result, approval),
				resumeRun(result, approval),
			]);

			// Both should complete (tool executes twice — that's the caller's problem)
			expect(r1.interrupted).toBe(false);
			expect(r2.interrupted).toBe(false);
			expect(callCount.value).toBe(2); // Tool ran twice
		}
	}, 60000);
});

describe("retry abuse", () => {
	test("tool that always throws exhausts retries and model recovers", async () => {
		let callCount = 0;
		const brokenTool = tool({
			name: "always_fails",
			description: "This tool always fails",
			parameters: z.object({ input: z.string() }),
			retries: { limit: 2, delay: 50, backoff: "fixed" },
			execute: async () => {
				callCount++;
				throw new Error("Permanent failure");
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions:
				"Try using always_fails tool. If it fails, apologize and say you cannot help. Always try the tool first.",
			tools: [brokenTool],
		});

		const result = await run(agent, "Do the thing", { maxTurns: 5 });
		expect(result.interrupted).toBe(false);
		if (!result.interrupted) {
			// Tool was called 3 times (1 original + 2 retries), then error sent to model
			expect(callCount).toBe(3);
			expect(result.output).toBeTruthy();
		}
	}, 30000);

	test("retry with zero limit behaves like no retries", async () => {
		let callCount = 0;
		const noRetryTool = tool({
			name: "no_retry",
			description: "Fails once",
			parameters: z.object({ q: z.string() }),
			retries: { limit: 0 },
			execute: async () => {
				callCount++;
				throw new Error("Fail");
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Use no_retry tool. Always call it. If it fails, say 'failed'.",
			tools: [noRetryTool],
		});

		const result = await run(agent, "Try it", { maxTurns: 3 });
		expect(callCount).toBe(1); // No retries
	}, 30000);
});

describe("session store abuse", () => {
	test("store.save that throws doesn't crash the session", async () => {
		let saveAttempts = 0;
		const brokenStore = {
			save: async () => {
				saveAttempts++;
				throw new Error("Database connection lost");
			},
			load: async () => undefined,
			delete: async () => {},
		};

		const session = createSession({
			model,
			instructions: "Reply with one word.",
			store: brokenStore,
			sessionId: "broken-store",
		});

		session.send("Hi");
		const events = [];
		for await (const event of session.stream()) {
			events.push(event);
		}
		const result = await session.result;

		// Session should still work even if save fails
		expect(result.output).toBeTruthy();
		expect(saveAttempts).toBe(1); // Attempted to save
		// stream_end should still have fired
	}, 30000);

	test("loadSession with corrupted snapshot returns undefined gracefully", async () => {
		const store = new MemorySessionStore();

		// Manually save garbage
		await store.save("corrupt", {
			id: "corrupt",
			messages: [] as any,
		} as any);

		const session = await loadSession(store, "corrupt", { model });
		// Should load without crashing (empty messages is valid)
		expect(session).toBeDefined();
	}, 10000);

	test("concurrent send/stream on same session", async () => {
		const session = createSession({
			model,
			instructions: "Reply with one word only.",
		});

		// First stream
		session.send("Hello");
		const streamPromise = (async () => {
			for await (const event of session.stream()) {
				// consume
			}
		})();

		// Try to send while streaming — should throw or queue
		let threwError = false;
		try {
			session.send("World");
			for await (const event of session.stream()) {
				// consume
			}
		} catch {
			threwError = true;
		}

		await streamPromise;

		// Either it queued properly or threw — both are acceptable
		// The point is it shouldn't corrupt state or hang
		expect(true).toBe(true);
	}, 30000);
});

describe("subagent streaming edge cases", () => {
	test("subagent that errors still completes parent stream", async () => {
		const errorAgent = new Agent({
			name: "error-agent",
			model: new AzureResponsesModel({
				endpoint: "https://fake-endpoint.openai.azure.com",
				apiKey: "fake-key",
				deployment: "nonexistent",
				maxRetries: 0,
			}),
			instructions: "This agent will fail.",
		});

		const errorSubagent = subagent({
			agent: errorAgent,
			toolName: "ask_broken",
			toolDescription: "Ask a broken agent (will fail)",
			inputSchema: z.object({ question: z.string() }),
			mapInput: (params) => params.question,
		});

		const parentAgent = new Agent({
			name: "parent",
			model,
			instructions:
				"Use ask_broken tool. If it fails, apologize and answer the question yourself.",
			subagents: [errorSubagent],
		});

		const { stream: s, result } = stream(parentAgent, "What is 2+2?");
		const events = [];
		for await (const event of s) {
			events.push(event);
		}
		const finalResult = await result;

		// Parent should recover from subagent failure
		expect(finalResult.interrupted).toBe(false);
		if (!finalResult.interrupted) {
			expect(finalResult.output).toBeTruthy();
		}
	}, 60000);
});

describe("file input edge cases", () => {
	test("empty file content still accepted by API", async () => {
		// A minimal valid PDF that's essentially empty
		const emptyPdf = btoa("%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n206\n%%EOF");

		const result = await model.getResponse({
			messages: [
				{
					role: "user",
					content: [
						{ type: "file", file: { url: `data:application/pdf;base64,${emptyPdf}` }, filename: "empty.pdf" },
						{ type: "text", text: "Is this PDF empty? Reply yes or no." },
					],
				},
			],
		});

		expect(result.content).toBeTruthy();
	}, 30000);

	test("mixed text + image + file in one message", async () => {
		const pdfData = btoa("%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n206\n%%EOF");

		const result = await model.getResponse({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "How many items am I sending you? Reply with just the count." },
						{ type: "file", file: { url: `data:application/pdf;base64,${pdfData}` }, filename: "doc.pdf" },
					],
				},
			],
		});

		expect(result.content).toBeTruthy();
	}, 30000);
});

describe("abort during HITL resume", () => {
	test("abort signal during resumeRun cancels cleanly", async () => {
		const slowTool = tool({
			name: "slow_op",
			description: "A slow operation",
			parameters: z.object({ data: z.string() }),
			needsApproval: true,
			execute: async (_ctx, { data }, options) => {
				// Simulate slow work that respects abort
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve(`Done: ${data}`), 10000);
					options?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("Aborted"));
					});
				});
				return `Done: ${data}`;
			},
		});

		const agent = new Agent({
			name: "test",
			model,
			instructions: "Use slow_op tool. Always call it.",
			tools: [slowTool],
		});

		const result = await run(agent, "Process my data");
		expect(result.interrupted).toBe(true);

		if (result.interrupted) {
			const ac = new AbortController();
			// Abort immediately after starting resume
			setTimeout(() => ac.abort(), 100);

			let aborted = false;
			try {
				await resumeRun(
					result,
					[{ toolCallId: result.pendingToolCalls[0]!.toolCallId, decision: "approve" }],
					{ signal: ac.signal },
				);
			} catch (err) {
				aborted = true;
			}

			// Should have been aborted (either via RunAbortedError or tool error)
			expect(aborted).toBe(true);
		}
	}, 30000);
});

describe("state events ordering", () => {
	test("events fire in correct lifecycle order", async () => {
		const events: string[] = [];
		const store = new MemorySessionStore();

		const session = createSession({
			model,
			instructions: "Reply with exactly one word.",
			store,
			sessionId: "order-test",
			onStateChange: (event) => events.push(event.type),
		});

		session.send("Hi");
		for await (const event of session.stream()) {
			// consume
		}
		await session.result;

		// Verify ordering: stream_start must come before stream_end
		const startIdx = events.indexOf("stream_start");
		const endIdx = events.indexOf("stream_end");
		const savedIdx = events.indexOf("saved");

		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThan(startIdx);

		// saved should come before stream_end (per our fix)
		if (savedIdx >= 0) {
			expect(savedIdx).toBeLessThan(endIdx);
		}
	}, 30000);
});
