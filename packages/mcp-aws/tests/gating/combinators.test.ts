import { describe, expect, test } from "bun:test";
import { all, any } from "../../src/gating/combinators.js";
import { check, role } from "../../src/gating/gates.js";
import type { GateContext } from "../../src/types.js";

function makeCtx(roles: string[] = []): GateContext {
	return {
		auth: { authenticated: true, subject: "user-1", roles, claims: {} },
		toolName: "test_tool",
		sessionId: "session-1",
		metadata: {},
	};
}

describe("all combinator", () => {
	test("passes when all gates pass", async () => {
		const gate = all(
			role("admin"),
			check(() => true),
		);
		const result = await gate(makeCtx(["admin"]));
		expect(result.allowed).toBe(true);
	});

	test("fails on first failure", async () => {
		const gate = all(
			role("admin"),
			check(() => true),
		);
		const result = await gate(makeCtx(["reader"]));
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain("admin");
		}
	});

	test("empty gates list passes", async () => {
		const gate = all();
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(true);
	});
});

describe("any combinator", () => {
	test("passes when any gate passes", async () => {
		const gate = any(role("admin"), role("reader"));
		const result = await gate(makeCtx(["reader"]));
		expect(result.allowed).toBe(true);
	});

	test("fails when no gates pass", async () => {
		const gate = any(role("admin"), role("writer"));
		const result = await gate(makeCtx(["reader"]));
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.reason).toContain("None of the gates passed");
		}
	});

	test("empty gates list fails", async () => {
		const gate = any();
		const result = await gate(makeCtx());
		expect(result.allowed).toBe(false);
	});
});
