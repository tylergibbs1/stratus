import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type AgentTool,
	type HostedTool,
	isFunctionTool,
	isHostedTool,
} from "../../src/core/hosted-tool";
import { tool } from "../../src/core/tool";

describe("HostedTool", () => {
	const hostedTool: HostedTool = {
		type: "hosted",
		name: "web_search_preview",
		definition: { type: "web_search_preview" },
	};

	const functionTool = tool({
		name: "greet",
		description: "Greet someone",
		parameters: z.object({ name: z.string() }),
		execute: async (_ctx, params) => `Hello, ${params.name}`,
	});

	test("isHostedTool returns true for hosted tools", () => {
		expect(isHostedTool(hostedTool)).toBe(true);
	});

	test("isHostedTool returns false for function tools", () => {
		expect(isHostedTool(functionTool)).toBe(false);
	});

	test("isFunctionTool returns true for function tools", () => {
		expect(isFunctionTool(functionTool)).toBe(true);
	});

	test("isFunctionTool returns false for hosted tools", () => {
		expect(isFunctionTool(hostedTool)).toBe(false);
	});

	test("AgentTool union accepts both types", () => {
		const tools: AgentTool[] = [hostedTool, functionTool];
		expect(tools).toHaveLength(2);
		expect(tools[0]!.type).toBe("hosted");
		expect(tools[1]!.type).toBe("function");
	});

	test("HostedTool has name and definition", () => {
		expect(hostedTool.name).toBe("web_search_preview");
		expect(hostedTool.definition).toEqual({ type: "web_search_preview" });
	});
});
