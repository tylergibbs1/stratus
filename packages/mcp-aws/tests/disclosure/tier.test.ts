import { describe, expect, test } from "bun:test";
import { getVisibleTools, handleGateUnlock, promoteToVisible } from "../../src/disclosure/tier.js";
import { requires } from "../../src/gating/gates.js";
import type { McpSession, ToolConfig } from "../../src/types.js";

function makeTool(
	name: string,
	tier: "always" | "discoverable" | "hidden",
	gate?: ToolConfig["gate"],
): ToolConfig {
	return {
		name,
		description: `Tool: ${name}`,
		tier,
		gate,
		handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

function makeSession(): McpSession {
	const now = Date.now();
	return {
		id: "s1",
		visibleTools: new Set(),
		unlockedGates: new Set(),
		toolCallHistory: [],
		auth: { authenticated: false, roles: [], claims: {} },
		metadata: {},
		createdAt: now,
		lastAccessedAt: now,
	};
}

describe("getVisibleTools", () => {
	test("returns only always-tier tools for fresh session", () => {
		const tools = new Map<string, ToolConfig>([
			["always_tool", makeTool("always_tool", "always")],
			["discoverable_tool", makeTool("discoverable_tool", "discoverable")],
			["hidden_tool", makeTool("hidden_tool", "hidden")],
		]);

		const session = makeSession();
		const visible = getVisibleTools(tools, session);
		expect(visible.length).toBe(1);
		expect(visible[0]!.name).toBe("always_tool");
	});

	test("includes promoted tools", () => {
		const tools = new Map<string, ToolConfig>([
			["always_tool", makeTool("always_tool", "always")],
			["discoverable_tool", makeTool("discoverable_tool", "discoverable")],
		]);

		const session = makeSession();
		session.visibleTools.add("discoverable_tool");
		const visible = getVisibleTools(tools, session);
		expect(visible.length).toBe(2);
	});
});

describe("promoteToVisible", () => {
	test("adds tool to visible set", () => {
		const session = makeSession();
		const promoted = promoteToVisible(session, "new_tool");
		expect(promoted).toBe(true);
		expect(session.visibleTools.has("new_tool")).toBe(true);
	});

	test("returns false for already visible tool", () => {
		const session = makeSession();
		session.visibleTools.add("existing_tool");
		const promoted = promoteToVisible(session, "existing_tool");
		expect(promoted).toBe(false);
	});
});

describe("handleGateUnlock", () => {
	test("unlocks gate and promotes hidden tools with matching requires() gate", () => {
		const tools = new Map<string, ToolConfig>([
			["always_tool", makeTool("always_tool", "always")],
			["hidden_tool", makeTool("hidden_tool", "hidden", requires("review_step"))],
		]);

		const session = makeSession();
		const promoted = handleGateUnlock(tools, session, "review_step");

		expect(session.unlockedGates.has("review_step")).toBe(true);
		expect(promoted).toContain("hidden_tool");
		expect(session.visibleTools.has("hidden_tool")).toBe(true);
	});

	test("does NOT promote hidden tools whose gate doesn't match", () => {
		const tools = new Map<string, ToolConfig>([
			["hidden_a", makeTool("hidden_a", "hidden", requires("step_a"))],
			["hidden_b", makeTool("hidden_b", "hidden", requires("step_b"))],
		]);

		const session = makeSession();
		const promoted = handleGateUnlock(tools, session, "step_a");

		// Only hidden_a should be promoted (its gate matches step_a)
		expect(promoted).toContain("hidden_a");
		expect(promoted).not.toContain("hidden_b");
		expect(session.visibleTools.has("hidden_a")).toBe(true);
		expect(session.visibleTools.has("hidden_b")).toBe(false);
	});

	test("does not re-promote already visible tools", () => {
		const tools = new Map<string, ToolConfig>([
			["hidden_tool", makeTool("hidden_tool", "hidden", requires("gate_x"))],
		]);

		const session = makeSession();
		session.visibleTools.add("hidden_tool");
		const promoted = handleGateUnlock(tools, session, "gate_x");
		expect(promoted.length).toBe(0);
	});

	test("does not promote hidden tools without gates", () => {
		const tools = new Map<string, ToolConfig>([
			["hidden_no_gate", makeTool("hidden_no_gate", "hidden")],
		]);

		const session = makeSession();
		const promoted = handleGateUnlock(tools, session, "anything");
		expect(promoted.length).toBe(0);
	});
});
