import { describe, expect, test } from "bun:test";
import { DynamoSessionStore } from "../../src/session/dynamo.js";
import type { McpSession } from "../../src/types.js";

function makeSession(id: string): McpSession {
	const now = Date.now();
	return {
		id,
		visibleTools: new Set(["tool_a"]),
		unlockedGates: new Set(["gate_x"]),
		toolCallHistory: [{ toolName: "tool_a", params: {}, timestamp: now, durationMs: 42 }],
		auth: { authenticated: true, subject: "user-1", roles: ["admin"], claims: {} },
		metadata: { key: "val" },
		createdAt: now,
		lastAccessedAt: now,
	};
}

describe("DynamoSessionStore", () => {
	test("set calls PutCommand with correct table and serialized data", async () => {
		const commands: unknown[] = [];
		const mockClient = {
			async send(command: unknown) {
				commands.push(command);
				return {};
			},
		};

		const store = new DynamoSessionStore({
			tableName: "test-table",
			ttlSeconds: 3600,
			client: mockClient,
		});

		await store.set(makeSession("s1"));
		expect(commands.length).toBe(1);

		const cmd = commands[0] as { input: Record<string, unknown> };
		expect(cmd.input.TableName).toBe("test-table");
		const item = cmd.input.Item as Record<string, unknown>;
		expect(item.pk).toBe("s1");
		expect(item.expiresAt).toBeDefined();

		const data = item.data as Record<string, unknown>;
		expect(data.id).toBe("s1");
		expect(data.visibleTools).toEqual(["tool_a"]);
		expect(data.unlockedGates).toEqual(["gate_x"]);
	});

	test("get returns deserialized session", async () => {
		const session = makeSession("s1");
		const serialized = {
			id: "s1",
			visibleTools: ["tool_a"],
			unlockedGates: ["gate_x"],
			toolCallHistory: session.toolCallHistory,
			auth: session.auth,
			metadata: session.metadata,
			createdAt: session.createdAt,
			lastAccessedAt: session.lastAccessedAt,
		};

		const commands: unknown[] = [];
		const mockClient = {
			async send(command: unknown) {
				const cmd = command as { input?: Record<string, unknown> };
				// GetCommand
				if (cmd.input && "Key" in cmd.input) {
					return { Item: { pk: "s1", data: serialized } };
				}
				// PutCommand (from the set call inside get)
				commands.push(command);
				return {};
			},
		};

		const store = new DynamoSessionStore({
			tableName: "test-table",
			client: mockClient,
		});

		const result = await store.get("s1");
		expect(result).toBeDefined();
		expect(result!.id).toBe("s1");
		expect(result!.visibleTools).toBeInstanceOf(Set);
		expect(result!.visibleTools.has("tool_a")).toBe(true);
		expect(result!.unlockedGates).toBeInstanceOf(Set);
	});

	test("get returns undefined for missing item", async () => {
		const mockClient = {
			async send() {
				return { Item: undefined };
			},
		};

		const store = new DynamoSessionStore({
			tableName: "test-table",
			client: mockClient,
		});

		const result = await store.get("nonexistent");
		expect(result).toBeUndefined();
	});

	test("delete calls DeleteCommand", async () => {
		const commands: unknown[] = [];
		const mockClient = {
			async send(command: unknown) {
				commands.push(command);
				return {};
			},
		};

		const store = new DynamoSessionStore({
			tableName: "test-table",
			client: mockClient,
		});

		await store.delete("s1");
		expect(commands.length).toBe(1);
		const cmd = commands[0] as { input: Record<string, unknown> };
		expect(cmd.input.TableName).toBe("test-table");
		expect(cmd.input.Key).toEqual({ pk: "s1" });
	});
});
