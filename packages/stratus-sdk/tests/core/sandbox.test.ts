import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, LocalSandbox, SandboxAgent, run } from "../../src";
import type { Model, ModelRequest, ModelResponse } from "../../src/core/model";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

function mockModel(responses: ModelResponse[], capture?: ModelRequest[]): Model {
	let callIndex = 0;
	return {
		async getResponse(request) {
			capture?.push(request);
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request) {
			capture?.push(request);
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			yield { type: "done", response };
		},
	};
}

describe("LocalSandbox", () => {
	test("confines file operations to the workspace root", async () => {
		const root = await mkdtemp(join(tmpdir(), "stratus-sandbox-"));
		roots.push(root);
		const sandbox = new LocalSandbox({ root });

		await sandbox.writeFile("src/index.ts", "export const x = 1;");

		expect(await sandbox.readFile("src/index.ts")).toContain("x = 1");
		expect(await sandbox.listFiles()).toEqual(["src/index.ts"]);
		await expect(sandbox.readFile("../outside.txt")).rejects.toThrow("escapes sandbox");
	});

	test("runs commands inside the workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "stratus-sandbox-"));
		roots.push(root);
		const sandbox = new LocalSandbox({ root });

		const result = await sandbox.runCommand("printf hello");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello");
	});
});

describe("SandboxAgent", () => {
	test("adds workspace tools to the agent", () => {
		const agent = new SandboxAgent({
			name: "workspace",
			sandbox: { root: tmpdir() },
		});

		expect(agent.tools.map((tool) => tool.name)).toContain("sandbox_read_file");
		expect(agent.tools.map((tool) => tool.name)).toContain("sandbox_run_command");
	});

	test("sandbox tools are callable through run loop", async () => {
		const root = await mkdtemp(join(tmpdir(), "stratus-sandbox-"));
		roots.push(root);
		const capture: ModelRequest[] = [];
		const model = mockModel(
			[
				{
					content: null,
					toolCalls: [
						{
							id: "call_1",
							type: "function",
							function: {
								name: "sandbox_write_file",
								arguments: JSON.stringify({ path: "note.txt", content: "hello" }),
							},
						},
					],
				},
				{ content: "done", toolCalls: [] },
			],
			capture,
		);
		const agent = new SandboxAgent({ name: "workspace", model, sandbox: { root } });

		const result = await run(agent, "write a note");

		expect(result.output).toBe("done");
		expect(await agent.sandbox.readFile("note.txt")).toBe("hello");
		expect(capture[0]!.tools?.map((tool: any) => tool.function.name)).toContain(
			"sandbox_write_file",
		);
	});

	test("can disable built-in sandbox tools", () => {
		const agent = new SandboxAgent({
			name: "workspace",
			sandbox: { root: tmpdir() },
			includeSandboxTools: false,
		});
		expect(agent).toBeInstanceOf(Agent);
		expect(agent.tools).toHaveLength(0);
	});
});
