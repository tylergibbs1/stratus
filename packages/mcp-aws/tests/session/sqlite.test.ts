import { afterAll, describe, expect, test } from "bun:test";
import { SqliteSessionStore } from "../../src/session/sqlite.js";
import type { McpSession } from "../../src/types.js";

function makeSession(id: string, overrides: Partial<McpSession> = {}): McpSession {
	const now = Date.now();
	return {
		id,
		visibleTools: new Set(["tool_a"]),
		unlockedGates: new Set(["gate_1"]),
		toolCallHistory: [{ toolName: "tool_a", params: {}, timestamp: now, durationMs: 10 }],
		auth: { authenticated: true, subject: "user-1", roles: ["admin"], claims: {} },
		metadata: { key: "val" },
		createdAt: now,
		lastAccessedAt: now,
		...overrides,
	};
}

describe("SqliteSessionStore", () => {
	const store = new SqliteSessionStore(); // in-memory

	afterAll(() => store.close());

	test("set + get round-trip preserves all fields", async () => {
		const session = makeSession("s1");
		await store.set(session);

		const retrieved = await store.get("s1");
		expect(retrieved).toBeDefined();
		expect(retrieved!.id).toBe("s1");
		expect(retrieved!.auth.subject).toBe("user-1");
		expect(retrieved!.auth.roles).toEqual(["admin"]);
		expect(retrieved!.visibleTools).toBeInstanceOf(Set);
		expect(retrieved!.visibleTools.has("tool_a")).toBe(true);
		expect(retrieved!.unlockedGates.has("gate_1")).toBe(true);
		expect(retrieved!.toolCallHistory.length).toBe(1);
		expect(retrieved!.metadata).toEqual({ key: "val" });
	});

	test("get returns undefined for nonexistent", async () => {
		expect(await store.get("nonexistent")).toBeUndefined();
	});

	test("delete removes session", async () => {
		await store.set(makeSession("s2"));
		expect(await store.get("s2")).toBeDefined();
		await store.delete("s2");
		expect(await store.get("s2")).toBeUndefined();
	});

	test("set overwrites existing", async () => {
		await store.set(makeSession("s3"));
		const updated = makeSession("s3", {
			auth: { authenticated: true, subject: "user-2", roles: [], claims: {} },
		});
		await store.set(updated);

		const retrieved = await store.get("s3");
		expect(retrieved!.auth.subject).toBe("user-2");
	});

	test("TTL expiration", async () => {
		const shortTtl = new SqliteSessionStore({ ttlMs: 50 });
		await shortTtl.set(makeSession("s4"));
		expect(await shortTtl.get("s4")).toBeDefined();

		await Bun.sleep(60);
		expect(await shortTtl.get("s4")).toBeUndefined();
		shortTtl.close();
	});

	test("file-based persistence", async () => {
		const path = `/tmp/stratus-test-${Date.now()}.db`;
		const store1 = new SqliteSessionStore({ path });
		await store1.set(makeSession("s5"));
		store1.close();

		// Reopen same file
		const store2 = new SqliteSessionStore({ path });
		const retrieved = await store2.get("s5");
		expect(retrieved).toBeDefined();
		expect(retrieved!.id).toBe("s5");
		store2.close();

		// Cleanup
		const { unlinkSync } = await import("node:fs");
		try {
			unlinkSync(path);
		} catch {}
	});
});
