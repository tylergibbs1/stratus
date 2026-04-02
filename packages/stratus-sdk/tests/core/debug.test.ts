import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import { run } from "../../src/core/run";
import { tool } from "../../src/core/tool";
import { createMockModel, textResponse, toolCallResponse } from "../../src/testing/index";

let stderrOutput: string[] = [];
const originalWrite = process.stderr.write;

beforeEach(() => {
	stderrOutput = [];
	// @ts-expect-error -- mock
	process.stderr.write = (chunk: string) => {
		stderrOutput.push(chunk);
		return true;
	};
});

afterEach(() => {
	process.stderr.write = originalWrite;
});

describe("debug mode", () => {
	test("logs model request and response with debug: true", async () => {
		const model = createMockModel([textResponse("Hello!")]);
		const agent = new Agent({ name: "debugger", model });

		await run(agent, "Hi", { debug: true });

		const output = stderrOutput.join("");
		expect(output).toContain("[stratus:model]");
		expect(output).toContain("request to debugger");
		expect(output).toContain("response from debugger");
	});

	test("does not log with debug: false (default)", async () => {
		const model = createMockModel([textResponse("Hello!")]);
		const agent = new Agent({ name: "quiet", model });

		await run(agent, "Hi");

		expect(stderrOutput).toHaveLength(0);
	});

	test("logs tool execution", async () => {
		const add = tool({
			name: "add",
			description: "Add numbers",
			parameters: z.object({ a: z.number(), b: z.number() }),
			execute: async (_ctx, { a, b }) => String(a + b),
		});

		const model = createMockModel([
			toolCallResponse([{ name: "add", args: { a: 1, b: 2 } }]),
			textResponse("3"),
		]);

		const agent = new Agent({ name: "calc", model, tools: [add] });

		await run(agent, "Add 1 and 2", { debug: true });

		const output = stderrOutput.join("");
		expect(output).toContain("[stratus:tool]");
		expect(output).toContain("executing");
		expect(output).toContain("add");
		expect(output).toContain("results");
	});
});
