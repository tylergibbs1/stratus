import { describe, expect, test } from "bun:test";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { createSession, forkSession, resumeSession } from "../../src/core/session";

function mockModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	return {
		requests,
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			requests.push(structuredClone(request));
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

describe("session save/resume/fork", () => {
	test("save() returns snapshot with correct ID and messages", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);

		const session = createSession({ model });
		session.send("Hi");

		for await (const _event of session.stream()) {
			// drain
		}

		const snapshot = session.save();
		expect(snapshot.id).toBe(session.id);
		expect(snapshot.messages.length).toBeGreaterThan(0);
		expect(snapshot.messages.some((m) => m.role === "user")).toBe(true);
		expect(snapshot.messages.some((m) => m.role === "assistant")).toBe(true);
	});

	test("resumeSession restores same ID and messages", async () => {
		const model1 = mockModel([{ content: "First reply", toolCalls: [] }]);

		const session1 = createSession({ model: model1 });
		session1.send("Hello");

		for await (const _event of session1.stream()) {
			// drain
		}

		const snapshot = session1.save();

		const model2 = mockModel([{ content: "Second reply", toolCalls: [] }]);

		const session2 = resumeSession(snapshot, { model: model2 });
		expect(session2.id).toBe(snapshot.id);

		session2.send("Follow up");
		for await (const _event of session2.stream()) {
			// drain
		}

		const result = await session2.result;
		expect(result.output).toBe("Second reply");
		// Model should see full history including the first messages
		expect(model2.requests[0]!.messages.length).toBeGreaterThan(2);
	});

	test("forkSession creates new ID, preserves messages", async () => {
		const model1 = mockModel([{ content: "Original reply", toolCalls: [] }]);

		const session1 = createSession({ model: model1 });
		session1.send("Hello");

		for await (const _event of session1.stream()) {
			// drain
		}

		const snapshot = session1.save();

		const model2 = mockModel([{ content: "Forked reply", toolCalls: [] }]);

		const session2 = forkSession(snapshot, { model: model2 });
		expect(session2.id).not.toBe(snapshot.id);

		session2.send("Fork question");
		for await (const _event of session2.stream()) {
			// drain
		}

		const result = await session2.result;
		expect(result.output).toBe("Forked reply");
		// Should have the original history + new message
		expect(model2.requests[0]!.messages.length).toBeGreaterThan(2);
	});

	test("save() is a deep copy (mutations don't cross)", async () => {
		const model = mockModel([{ content: "Reply", toolCalls: [] }]);

		const session = createSession({ model });
		session.send("Hello");

		for await (const _event of session.stream()) {
			// drain
		}

		const snapshot = session.save();
		const originalLength = snapshot.messages.length;

		// Mutate the snapshot messages
		snapshot.messages.push({ role: "user", content: "extra" });

		// Session messages should be unaffected
		expect(session.messages.length).toBe(originalLength);
	});

	test("save() on closed session throws", async () => {
		const model = mockModel([{ content: "Reply", toolCalls: [] }]);

		const session = createSession({ model });
		session.close();

		expect(() => session.save()).toThrow("Session is closed");
	});

	test("save() while streaming throws", async () => {
		const model = mockModel([{ content: "Reply", toolCalls: [] }]);

		const session = createSession({ model });
		session.send("Hello");

		const gen = session.stream();

		// Start reading but don't finish
		const first = await gen.next();
		expect(first.done).toBe(false);

		expect(() => session.save()).toThrow("Cannot save while streaming");

		// Drain the rest
		while (!(await gen.next()).done) {}
	});

	test("empty session roundtrip", () => {
		const model = mockModel([]);

		const session = createSession({ model });
		const snapshot = session.save();

		expect(snapshot.messages).toEqual([]);

		const resumed = resumeSession(snapshot, { model });
		expect(resumed.messages).toEqual([]);
		expect(resumed.id).toBe(session.id);
	});
});
