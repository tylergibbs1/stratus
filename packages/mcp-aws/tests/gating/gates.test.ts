import { describe, expect, test } from "bun:test";
import { check, rateLimit, requires, role } from "../../src/gating/gates.js";
import type { GateContext } from "../../src/types.js";

function makeCtx(overrides: Partial<GateContext> = {}): GateContext {
	return {
		auth: { authenticated: true, subject: "user-1", roles: ["reader"], claims: {} },
		toolName: "test_tool",
		sessionId: "session-1",
		metadata: {},
		...overrides,
	};
}

describe("role gate", () => {
	test("allows when user has matching role", async () => {
		const gate = role("reader");
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(true);
	});

	test("allows when user has any of specified roles", async () => {
		const gate = role("admin", "reader");
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(true);
	});

	test("denies when user has no matching roles", async () => {
		const gate = role("admin", "writer");
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain("admin");
			expect(result.reason).toContain("writer");
		}
	});

	test("denies when user has no roles", async () => {
		const gate = role("admin");
		const result = await gate(makeCtx({ auth: { authenticated: true, roles: [], claims: {} } }));
		expect(result.allowed).toBe(false);
	});
});

describe("check gate", () => {
	test("allows when predicate returns true", async () => {
		const gate = check(() => true);
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(true);
	});

	test("denies when predicate returns false", async () => {
		const gate = check(() => false, "custom reason");
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toBe("custom reason");
		}
	});

	test("supports async predicates", async () => {
		const gate = check(async () => {
			await new Promise((r) => setTimeout(r, 1));
			return true;
		});
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(true);
	});

	test("uses default reason when not provided", async () => {
		const gate = check(() => false);
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toBe("Check failed");
		}
	});
});

describe("requires gate", () => {
	test("allows when prerequisite is in unlocked gates", async () => {
		const gate = requires("setup_tool");
		const ctx = makeCtx({ metadata: { unlockedGates: new Set(["setup_tool"]) } });
		const result = await gate(ctx);
		expect(result.allowed).toBe(true);
	});

	test("denies when prerequisite is not unlocked", async () => {
		const gate = requires("setup_tool");
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain("setup_tool");
			expect(result.hint).toContain("setup_tool");
		}
	});

	test("denies when unlocked gates is empty set", async () => {
		const gate = requires("setup_tool");
		const ctx = makeCtx({ metadata: { unlockedGates: new Set() } });
		const result = await gate(ctx);
		expect(result.allowed).toBe(false);
	});
});

describe("rateLimit gate", () => {
	test("allows within limit", async () => {
		const gate = rateLimit({ max: 3, windowMs: 60_000 });
		const ctx = makeCtx();
		expect((await gate(ctx)).allowed).toBe(true);
		expect((await gate(ctx)).allowed).toBe(true);
		expect((await gate(ctx)).allowed).toBe(true);
	});

	test("denies when limit exceeded", async () => {
		const gate = rateLimit({ max: 2, windowMs: 60_000 });
		const ctx = makeCtx({ toolName: "rate_test", sessionId: "rate-session" });
		expect((await gate(ctx)).allowed).toBe(true);
		expect((await gate(ctx)).allowed).toBe(true);
		const result = await gate(ctx);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain("Rate limit");
		}
	});

	test("separate counters per session+tool", async () => {
		const gate = rateLimit({ max: 1, windowMs: 60_000 });
		const ctx1 = makeCtx({ toolName: "tool_a", sessionId: "s1" });
		const ctx2 = makeCtx({ toolName: "tool_b", sessionId: "s1" });
		expect((await gate(ctx1)).allowed).toBe(true);
		expect((await gate(ctx2)).allowed).toBe(true);
		expect((await gate(ctx1)).allowed).toBe(false);
		expect((await gate(ctx2)).allowed).toBe(false);
	});

	test("window resets after windowMs elapses", async () => {
		const gate = rateLimit({ max: 1, windowMs: 50 });
		const ctx = makeCtx({ toolName: "reset_test", sessionId: "reset-session" });
		expect((await gate(ctx)).allowed).toBe(true);
		expect((await gate(ctx)).allowed).toBe(false);
		// Wait for window to expire
		await new Promise((r) => setTimeout(r, 60));
		expect((await gate(ctx)).allowed).toBe(true);
	});
});
