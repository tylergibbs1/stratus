import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { generateTypes, normalizeCode, sanitizeToolName } from "../../src/codemode/types.js";
import type { ToolConfig } from "../../src/types.js";

describe("sanitizeToolName", () => {
	test("passes through valid names", () => {
		expect(sanitizeToolName("myTool")).toBe("myTool");
	});

	test("replaces hyphens with underscores", () => {
		expect(sanitizeToolName("my-tool")).toBe("my_tool");
	});

	test("replaces dots with underscores", () => {
		expect(sanitizeToolName("my.tool")).toBe("my_tool");
	});

	test("prefixes digit-leading names", () => {
		expect(sanitizeToolName("123tool")).toBe("_123tool");
	});

	test("appends underscore to reserved words", () => {
		expect(sanitizeToolName("class")).toBe("class_");
		expect(sanitizeToolName("return")).toBe("return_");
	});

	test("handles empty string", () => {
		expect(sanitizeToolName("")).toBe("_");
	});
});

describe("normalizeCode", () => {
	test("returns async arrow function as-is", () => {
		const code = "async () => { return 42; }";
		expect(normalizeCode(code)).toBe(code);
	});

	test("wraps bare code", () => {
		const code = "const x = 1; return x;";
		const result = normalizeCode(code);
		expect(result).toContain("async () => {");
		expect(result).toContain(code);
	});

	test("strips code fences", () => {
		const code = "```javascript\nasync () => 42\n```";
		const result = normalizeCode(code);
		expect(result).toBe("async () => 42");
	});

	test("handles empty code", () => {
		expect(normalizeCode("")).toBe("async () => {}");
		expect(normalizeCode("   ")).toBe("async () => {}");
	});
});

describe("generateTypes", () => {
	test("generates types for tools with Zod schemas", () => {
		const tools: ToolConfig[] = [
			{
				name: "search_web",
				description: "Search the web",
				tier: "always",
				inputSchema: z.object({ query: z.string() }),
				handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
			},
		];

		const types = generateTypes(tools);
		expect(types).toContain("search_web");
		expect(types).toContain("codemode");
		expect(types).toContain("SearchWebInput");
	});

	test("generates types for tools without schemas", () => {
		const tools: ToolConfig[] = [
			{
				name: "simple_tool",
				description: "A simple tool",
				tier: "always",
				handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
			},
		];

		const types = generateTypes(tools);
		expect(types).toContain("simple_tool");
		expect(types).toContain("SimpleToolInput");
	});

	test("handles empty tools array", () => {
		const types = generateTypes([]);
		expect(types).toContain("codemode");
	});
});
