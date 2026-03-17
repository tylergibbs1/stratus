import { describe, expect, test } from "bun:test";
import { MemorySessionStore } from "../../src/session/memory.js";
import type { McpSession } from "../../src/types.js";

function makeSession(id: string, overrides: Partial<McpSession> = {}): McpSession {
	const now = Date.now();
	return {
		id,
		visibleTools: new Set(),
		unlockedGates: new Set(),
		toolCallHistory: [],
		auth: { authenticated: false, roles: [], claims: {} },
		metadata: {},
		createdAt: now,
		lastAccessedAt: now,
		...overrides,
	};
}

describe("MemorySessionStore", () => {
	test("set and get session", async () => {
		const store = new MemorySessionStore();
		const session = makeSession("s1");
		await store.set(session);
		const retrieved = await store.get("s1");
		expect(retrieved).toBeDefined();
		expect(retrieved!.id).toBe("s1");
	});

	test("returns undefined for nonexistent session", async () => {
		const store = new MemorySessionStore();
		const result = await store.get("nonexistent");
		expect(result).toBeUndefined();
	});

	test("delete removes session", async () => {
		const store = new MemorySessionStore();
		await store.set(makeSession("s1"));
		await store.delete("s1");
		expect(await store.get("s1")).toBeUndefined();
	});

	test("updates lastAccessedAt on get", async () => {
		const store = new MemorySessionStore();
		const session = makeSession("s1", { lastAccessedAt: Date.now() - 1000 });
		await store.set(session);
		const before = session.lastAccessedAt;
		await store.get("s1");
		const retrieved = await store.get("s1");
		expect(retrieved!.lastAccessedAt).toBeGreaterThanOrEqual(before);
	});

	test("evicts expired sessions on get", async () => {
		const store = new MemorySessionStore({ ttlMs: 50 });
		const session = makeSession("s1", { lastAccessedAt: Date.now() - 100 });
		await store.set(session);
		const result = await store.get("s1");
		expect(result).toBeUndefined();
	});

	test("evicts oldest when maxSessions exceeded", async () => {
		const store = new MemorySessionStore({ maxSessions: 2 });
		await store.set(makeSession("s1", { lastAccessedAt: Date.now() - 3000 }));
		await store.set(makeSession("s2", { lastAccessedAt: Date.now() - 1000 }));
		await store.set(makeSession("s3", { lastAccessedAt: Date.now() }));

		// s1 should have been evicted as the oldest
		expect(await store.get("s1")).toBeUndefined();
		expect(await store.get("s2")).toBeDefined();
		expect(await store.get("s3")).toBeDefined();
	});

	test("overwriting existing session does not evict", async () => {
		const store = new MemorySessionStore({ maxSessions: 2 });
		await store.set(makeSession("s1"));
		await store.set(makeSession("s2"));
		// Overwrite s1 — should not evict
		await store.set(makeSession("s1"));
		expect(await store.get("s1")).toBeDefined();
		expect(await store.get("s2")).toBeDefined();
	});

	test("TTL expiration with real time delay", async () => {
		const store = new MemorySessionStore({ ttlMs: 50 });
		await store.set(makeSession("s1"));
		// Session exists immediately
		expect(await store.get("s1")).toBeDefined();
		// Wait for TTL to expire
		await new Promise((r) => setTimeout(r, 60));
		// Session should be evicted
		expect(await store.get("s1")).toBeUndefined();
	});
});
