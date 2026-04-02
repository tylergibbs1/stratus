import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { StratusError } from "../../src/core/errors";
import { tool } from "../../src/core/tool";
import { validateAgent } from "../../src/core/validate-agent";

const dummyTool = (name: string, opts?: { description?: string; timeout?: number }) =>
	tool({
		name,
		description: opts?.description ?? `Tool ${name}`,
		parameters: z.object({}),
		execute: async () => "ok",
		timeout: opts?.timeout,
	});

describe("validateAgent standalone", () => {
	test("valid agent returns no errors or warnings", () => {
		const result = validateAgent({
			name: "test",
			tools: [dummyTool("a"), dummyTool("b")],
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("duplicate tool names produce errors", () => {
		const result = validateAgent({
			name: "test",
			tools: [dummyTool("search"), dummyTool("search")],
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Duplicate tool name");
		expect(result.errors[0]).toContain("search");
	});

	test("timeout <= 0 produces error", () => {
		const result = validateAgent({
			name: "test",
			tools: [dummyTool("a", { timeout: 0 })],
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("invalid timeout");
	});

	test("negative timeout produces error", () => {
		const result = validateAgent({
			name: "test",
			tools: [dummyTool("a", { timeout: -100 })],
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("-100ms");
	});

	test("empty description produces warning", () => {
		const result = validateAgent({
			name: "test",
			tools: [dummyTool("a", { description: "" })],
		});
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("empty description");
	});
});

describe("Agent constructor validation", () => {
	test("throws on duplicate tool names", () => {
		expect(
			() =>
				new Agent({
					name: "bad",
					tools: [dummyTool("search"), dummyTool("search")],
				}),
		).toThrow(StratusError);
	});

	test("throws on invalid timeout", () => {
		expect(
			() =>
				new Agent({
					name: "bad",
					tools: [dummyTool("a", { timeout: 0 })],
				}),
		).toThrow(StratusError);
	});

	test("warns on empty description but does not throw", () => {
		const warnSpy = mock(() => {});
		const orig = console.warn;
		console.warn = warnSpy;

		try {
			const agent = new Agent({
				name: "ok",
				tools: [dummyTool("a", { description: "" })],
			});
			expect(agent).toBeDefined();
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			console.warn = orig;
		}
	});

	test("valid agent constructs without errors", () => {
		const agent = new Agent({
			name: "good",
			tools: [dummyTool("a"), dummyTool("b")],
		});
		expect(agent.name).toBe("good");
		expect(agent.tools).toHaveLength(2);
	});
});
