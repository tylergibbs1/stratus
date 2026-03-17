import { describe, expect, test } from "bun:test";
import { FunctionExecutor, WorkerExecutor } from "../../src/codemode/executor.js";

describe("FunctionExecutor", () => {
	test("executes simple code", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute("async () => 42", {});
		expect(result.result).toBe(42);
		expect(result.error).toBeUndefined();
	});

	test("accesses codemode tools", async () => {
		const executor = new FunctionExecutor();
		const fns = {
			add: async (args: unknown) => {
				const { a, b } = args as { a: number; b: number };
				return a + b;
			},
		};
		const result = await executor.execute(
			"async () => { const r = await codemode.add({ a: 1, b: 2 }); return r; }",
			fns,
		);
		expect(result.result).toBe(3);
	});

	test("captures console output", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute(
			'async () => { console.log("hello"); console.warn("warning"); return "done"; }',
			{},
		);
		expect(result.result).toBe("done");
		expect(result.logs).toContain("hello");
		expect(result.logs).toContain("[warn] warning");
	});

	test("returns error for failing code", async () => {
		const executor = new FunctionExecutor();
		const result = await executor.execute('async () => { throw new Error("boom"); }', {});
		expect(result.error).toBe("boom");
		expect(result.result).toBeUndefined();
	});

	test("times out on long-running code", async () => {
		const executor = new FunctionExecutor({ timeout: 100 });
		const result = await executor.execute(
			"async () => { await new Promise(r => setTimeout(r, 5000)); }",
			{},
		);
		expect(result.error).toContain("timed out");
	});
});

describe("WorkerExecutor", () => {
	test("executes simple code in worker", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute("async () => 42", {});
		expect(result.result).toBe(42);
		expect(result.error).toBeUndefined();
	});

	test("accesses codemode tools via message passing", async () => {
		const executor = new WorkerExecutor();
		const fns = {
			multiply: async (args: unknown) => {
				const { a, b } = args as { a: number; b: number };
				return a * b;
			},
		};
		const result = await executor.execute(
			"async () => { const r = await codemode.multiply({ a: 3, b: 4 }); return r; }",
			fns,
		);
		expect(result.result).toBe(12);
	});

	test("returns error for failing code in worker", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute('async () => { throw new Error("worker boom"); }', {});
		expect(result.error).toBe("worker boom");
	});

	test("times out in worker", async () => {
		const executor = new WorkerExecutor({ timeout: 200 });
		const result = await executor.execute(
			"async () => { await new Promise(r => setTimeout(r, 10000)); }",
			{},
		);
		expect(result.error).toContain("timed out");
	});

	test("handles missing tool in worker", async () => {
		const executor = new WorkerExecutor();
		const result = await executor.execute(
			"async () => { return await codemode.nonexistent({}); }",
			{},
		);
		expect(result.error).toContain("not found");
	});
});
