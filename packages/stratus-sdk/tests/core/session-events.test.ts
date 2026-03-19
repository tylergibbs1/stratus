import { describe, expect, test } from "bun:test";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { createSession } from "../../src/core/session";
import type { SessionStateChangeEvent, SessionStore } from "../../src/core/session";

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

function createMemoryStore(): SessionStore {
	const data = new Map<string, any>();
	return {
		async save(id, snapshot) {
			data.set(id, structuredClone(snapshot));
		},
		async load(id) {
			return data.get(id);
		},
		async delete(id) {
			data.delete(id);
		},
	};
}

describe("session state change events", () => {
	test("receives stream_start and stream_end events", async () => {
		const model = mockModel([{ content: "Hello!", toolCalls: [] }]);
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			onStateChange: (event) => events.push(event),
		});

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		const types = events.map((e) => e.type);
		expect(types).toContain("stream_start");
		expect(types).toContain("stream_end");

		// stream_start should come before stream_end
		const startIdx = types.indexOf("stream_start");
		const endIdx = types.indexOf("stream_end");
		expect(startIdx).toBeLessThan(endIdx);
	});

	test("fires message_added for user message on send()", async () => {
		const model = mockModel([{ content: "Reply", toolCalls: [] }]);
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			onStateChange: (event) => events.push(event),
		});

		session.send("Hello");

		const messageEvents = events.filter((e) => e.type === "message_added");
		expect(messageEvents).toHaveLength(1);
		expect(messageEvents[0]!.type).toBe("message_added");
		if (messageEvents[0]!.type === "message_added") {
			expect(messageEvents[0]!.message.role).toBe("user");
			expect(messageEvents[0]!.message.content).toBe("Hello");
		}
	});

	test("fires message_added for assistant messages after streaming", async () => {
		const model = mockModel([{ content: "Bot reply", toolCalls: [] }]);
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			onStateChange: (event) => events.push(event),
		});

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		const messageAddedEvents = events.filter((e) => e.type === "message_added");
		// Should have at least 2: the user message from send() and the assistant message
		expect(messageAddedEvents.length).toBeGreaterThanOrEqual(2);

		const assistantEvents = messageAddedEvents.filter(
			(e) => e.type === "message_added" && e.message.role === "assistant",
		);
		expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
	});

	test("fires saved event when store is set", async () => {
		const model = mockModel([{ content: "Saved reply", toolCalls: [] }]);
		const store = createMemoryStore();
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			store,
			onStateChange: (event) => events.push(event),
		});

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		const savedEvents = events.filter((e) => e.type === "saved");
		expect(savedEvents).toHaveLength(1);
		if (savedEvents[0]!.type === "saved") {
			expect(savedEvents[0]!.sessionId).toBe(session.id);
		}

		// saved should come after stream_end
		const types = events.map((e) => e.type);
		const endIdx = types.indexOf("stream_end");
		const savedIdx = types.indexOf("saved");
		expect(endIdx).toBeLessThan(savedIdx);
	});

	test("session without onStateChange works normally", async () => {
		const model = mockModel([{ content: "No crash", toolCalls: [] }]);

		const session = createSession({ model });

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		const result = await session.result;
		expect(result.output).toBe("No crash");
	});

	test("no saved event when store is not set", async () => {
		const model = mockModel([{ content: "Reply", toolCalls: [] }]);
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			onStateChange: (event) => events.push(event),
		});

		session.send("Hi");
		for await (const _event of session.stream()) {
			// drain
		}

		const savedEvents = events.filter((e) => e.type === "saved");
		expect(savedEvents).toHaveLength(0);
	});

	test("event order is correct across a full interaction", async () => {
		const model = mockModel([{ content: "Response", toolCalls: [] }]);
		const store = createMemoryStore();
		const events: SessionStateChangeEvent[] = [];

		const session = createSession({
			model,
			store,
			onStateChange: (event) => events.push(event),
		});

		session.send("Hello");
		for await (const _event of session.stream()) {
			// drain
		}

		const types = events.map((e) => e.type);

		// Expected order: message_added (user), stream_start, message_added (assistant), stream_end, saved
		expect(types[0]).toBe("message_added"); // user message from send()
		expect(types[1]).toBe("stream_start");
		// message_added events for new messages come during result resolution
		expect(types).toContain("stream_end");
		expect(types[types.length - 1]).toBe("saved");
	});
});
