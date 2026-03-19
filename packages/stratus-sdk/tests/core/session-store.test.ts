import { describe, expect, test } from "bun:test";
import { MemorySessionStore } from "../../src/core/memory-store";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { createSession, loadSession } from "../../src/core/session";
import type { SessionSnapshot } from "../../src/core/session";

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
				yield {
					type: "tool_call_start",
					toolCall: { id: tc.id, name: tc.function.name },
				};
				yield {
					type: "tool_call_delta",
					toolCallId: tc.id,
					arguments: tc.function.arguments,
				};
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};
}

describe("MemorySessionStore", () => {
	test("save and load round-trips a snapshot", async () => {
		const store = new MemorySessionStore();
		const snapshot: SessionSnapshot = {
			id: "sess-1",
			messages: [{ role: "user", content: "hello" }],
		};

		await store.save("sess-1", snapshot);
		const loaded = await store.load("sess-1");

		expect(loaded).toEqual(snapshot);
	});

	test("load returns undefined for missing session", async () => {
		const store = new MemorySessionStore();
		const loaded = await store.load("nonexistent");
		expect(loaded).toBeUndefined();
	});

	test("delete removes a session", async () => {
		const store = new MemorySessionStore();
		await store.save("sess-1", { id: "sess-1", messages: [] });

		await store.delete("sess-1");
		const loaded = await store.load("sess-1");

		expect(loaded).toBeUndefined();
	});

	test("list returns all session IDs", async () => {
		const store = new MemorySessionStore();
		await store.save("a", { id: "a", messages: [] });
		await store.save("b", { id: "b", messages: [] });
		await store.save("c", { id: "c", messages: [] });

		const ids = await store.list();

		expect(ids).toEqual(["a", "b", "c"]);
	});
});

describe("Session with store", () => {
	test("auto-saves after send() + stream()", async () => {
		const store = new MemorySessionStore();
		const model = mockModel([
			{
				content: "Hi there!",
				toolCalls: [],
				usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
			},
		]);

		const session = createSession({ model, store, sessionId: "test-session" });
		session.send("Hello");

		for await (const _event of session.stream()) {
			// drain
		}

		const saved = await store.load("test-session");
		expect(saved).toBeDefined();
		expect(saved!.id).toBe("test-session");
		expect(saved!.messages.length).toBeGreaterThan(0);
		// Should contain both user and assistant messages
		expect(saved!.messages.some((m) => m.role === "user")).toBe(true);
		expect(saved!.messages.some((m) => m.role === "assistant")).toBe(true);
	});
});

describe("loadSession", () => {
	test("returns session from store", async () => {
		const store = new MemorySessionStore();
		const snapshot: SessionSnapshot = {
			id: "sess-restore",
			messages: [
				{ role: "user", content: "previous message" },
				{ role: "assistant", content: "previous reply", toolCalls: [] },
			],
		};
		await store.save("sess-restore", snapshot);

		const model = mockModel([]);
		const session = await loadSession(store, "sess-restore", { model });

		expect(session).toBeDefined();
		expect(session!.id).toBe("sess-restore");
		expect(session!.messages).toEqual(snapshot.messages);
	});

	test("returns undefined for missing session", async () => {
		const store = new MemorySessionStore();
		const model = mockModel([]);

		const session = await loadSession(store, "nonexistent", { model });

		expect(session).toBeUndefined();
	});
});
