/**
 * Real DynamoDB integration test.
 * Requires AWS credentials and the table `stratus-mcp-test-sessions` in us-east-1.
 *
 * Run with: bun test tests/integration/real-dynamo.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { DynamoSessionStore } from "../../src/session/dynamo.js";
import type { McpSession } from "../../src/types.js";

const TABLE_NAME = "stratus-mcp-test-sessions";
const REGION = "us-east-1";

function makeSession(id: string): McpSession {
	const now = Date.now();
	return {
		id,
		visibleTools: new Set(["tool_alpha", "tool_beta"]),
		unlockedGates: new Set(["gate_one"]),
		toolCallHistory: [
			{ toolName: "tool_alpha", params: { query: "test" }, timestamp: now, durationMs: 42 },
		],
		auth: {
			authenticated: true,
			subject: "test-user",
			roles: ["admin", "reader"],
			claims: { org: "stratus" },
		},
		metadata: { env: "test", count: 3 },
		createdAt: now,
		lastAccessedAt: now,
	};
}

describe("DynamoSessionStore (real AWS)", () => {
	const store = new DynamoSessionStore({
		tableName: TABLE_NAME,
		region: REGION,
		ttlSeconds: 300, // 5 min TTL for test data
	});

	const testIds: string[] = [];

	afterAll(async () => {
		// Clean up all test sessions
		for (const id of testIds) {
			try {
				await store.delete(id);
			} catch {
				// ignore cleanup errors
			}
		}
	});

	test("set + get: full round-trip preserves all fields", async () => {
		const id = `test-roundtrip-${Date.now()}`;
		testIds.push(id);
		const session = makeSession(id);

		await store.set(session);
		const retrieved = await store.get(id);

		expect(retrieved).toBeDefined();
		expect(retrieved!.id).toBe(id);
		expect(retrieved!.auth.authenticated).toBe(true);
		expect(retrieved!.auth.subject).toBe("test-user");
		expect(retrieved!.auth.roles).toEqual(["admin", "reader"]);
		expect(retrieved!.auth.claims).toEqual({ org: "stratus" });

		// Sets are deserialized correctly
		expect(retrieved!.visibleTools).toBeInstanceOf(Set);
		expect(retrieved!.visibleTools.has("tool_alpha")).toBe(true);
		expect(retrieved!.visibleTools.has("tool_beta")).toBe(true);
		expect(retrieved!.visibleTools.size).toBe(2);

		expect(retrieved!.unlockedGates).toBeInstanceOf(Set);
		expect(retrieved!.unlockedGates.has("gate_one")).toBe(true);

		// Tool call history preserved
		expect(retrieved!.toolCallHistory.length).toBe(1);
		expect(retrieved!.toolCallHistory[0]!.toolName).toBe("tool_alpha");
		expect(retrieved!.toolCallHistory[0]!.durationMs).toBe(42);

		// Metadata preserved
		expect(retrieved!.metadata).toEqual({ env: "test", count: 3 });
	});

	test("get returns undefined for nonexistent session", async () => {
		const result = await store.get(`nonexistent-${Date.now()}`);
		expect(result).toBeUndefined();
	});

	test("delete removes session", async () => {
		const id = `test-delete-${Date.now()}`;
		testIds.push(id);

		await store.set(makeSession(id));
		const before = await store.get(id);
		expect(before).toBeDefined();

		await store.delete(id);
		const after = await store.get(id);
		expect(after).toBeUndefined();
	});

	test("set overwrites existing session", async () => {
		const id = `test-overwrite-${Date.now()}`;
		testIds.push(id);

		const session1 = makeSession(id);
		await store.set(session1);

		const session2 = makeSession(id);
		session2.auth.subject = "updated-user";
		session2.visibleTools = new Set(["new_tool"]);
		await store.set(session2);

		const retrieved = await store.get(id);
		expect(retrieved!.auth.subject).toBe("updated-user");
		expect(retrieved!.visibleTools.has("new_tool")).toBe(true);
		expect(retrieved!.visibleTools.has("tool_alpha")).toBe(false);
	});

	test("multiple concurrent sessions are isolated", async () => {
		const id1 = `test-concurrent-a-${Date.now()}`;
		const id2 = `test-concurrent-b-${Date.now()}`;
		testIds.push(id1, id2);

		const session1 = makeSession(id1);
		session1.auth.subject = "user-a";
		const session2 = makeSession(id2);
		session2.auth.subject = "user-b";

		await Promise.all([store.set(session1), store.set(session2)]);

		const [r1, r2] = await Promise.all([store.get(id1), store.get(id2)]);
		expect(r1!.auth.subject).toBe("user-a");
		expect(r2!.auth.subject).toBe("user-b");
	});
});
