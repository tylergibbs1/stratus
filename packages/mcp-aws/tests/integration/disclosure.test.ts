import { describe, expect, test } from "bun:test";
import { all } from "../../src/gating/combinators.js";
import { role } from "../../src/gating/gates.js";
import { McpServer } from "../../src/server.js";

describe("Progressive Disclosure Integration", () => {
	function createServer() {
		const server = new McpServer("disclosure-test@1.0.0");

		for (let i = 0; i < 5; i++) {
			server.tool(`basic_${i}`, { description: `Basic tool ${i}` }, async () => `basic ${i}`);
		}
		for (let i = 0; i < 10; i++) {
			server.tool(
				`data_${i}`,
				{
					description: `Data processing tool ${i} for analytics`,
					tier: "discoverable",
					tags: ["data", "analytics"],
				},
				async () => `data ${i}`,
			);
		}
		for (let i = 0; i < 5; i++) {
			server.tool(
				`admin_${i}`,
				{
					description: `Admin tool ${i} for system management`,
					tier: "hidden",
					gate: role("admin"),
				},
				async () => `admin ${i}`,
			);
		}

		return server;
	}

	test("fresh session sees only always-tier tools", () => {
		const server = createServer();
		const now = Date.now();
		const session = {
			id: "s1",
			visibleTools: new Set<string>(),
			unlockedGates: new Set<string>(),
			toolCallHistory: [],
			auth: { authenticated: false, roles: [] as string[], claims: {} },
			metadata: {},
			createdAt: now,
			lastAccessedAt: now,
		};

		const visible = server.getVisibleTools(session);
		expect(visible.length).toBe(5);
		for (const tool of visible) {
			expect(tool.tier).toBe("always");
		}
	});

	test("search returns relevant discoverable tools", () => {
		const server = createServer();
		server.lambda(); // triggers index build

		const results = server.searchTools("data analytics");
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.name).toMatch(/data_/);
		}
	});

	test("20 tools registered across 3 tiers", () => {
		expect(createServer().toolCount).toBe(20);
	});

	test("promoted tools appear in visible set", () => {
		const server = createServer();
		const now = Date.now();
		const session = {
			id: "s1",
			visibleTools: new Set(["data_0", "data_1"]),
			unlockedGates: new Set<string>(),
			toolCallHistory: [],
			auth: { authenticated: false, roles: [] as string[], claims: {} },
			metadata: {},
			createdAt: now,
			lastAccessedAt: now,
		};

		const visible = server.getVisibleTools(session);
		expect(visible.length).toBe(7); // 5 always + 2 promoted
	});
});

describe("Gating Integration", () => {
	test("role gate combinator denies partial roles", async () => {
		const gate = all(role("admin"), role("superadmin"));
		const ctx = {
			auth: { authenticated: true, subject: "u1", roles: ["admin"], claims: {} },
			toolName: "test",
			sessionId: "s1",
			metadata: {},
		};
		expect((await gate(ctx)).allowed).toBe(false);
	});

	test("role gate combinator allows full roles", async () => {
		const gate = all(role("admin"), role("superadmin"));
		const ctx = {
			auth: { authenticated: true, subject: "u1", roles: ["admin", "superadmin"], claims: {} },
			toolName: "test",
			sessionId: "s1",
			metadata: {},
		};
		expect((await gate(ctx)).allowed).toBe(true);
	});
});
