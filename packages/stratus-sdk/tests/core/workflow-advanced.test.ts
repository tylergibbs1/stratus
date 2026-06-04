import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	Agent,
	discoverSavedWorkflows,
	generateWorkflowDraft,
	loadWorkflowModule,
	runWorkflow,
	WorkflowRunManager,
	workflow,
	workflowTask,
} from "../../src";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import { textResponse } from "../../src/testing/index";

function mockModel(responses: ModelResponse[]): Model & { requests: ModelRequest[] } {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	return {
		requests,
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response) throw new Error("No more mock responses");
			if (response.content) yield { type: "content_delta", content: response.content };
			yield { type: "done", response };
		},
	};
}

describe("advanced workflows", () => {
	test("enforces token budgets after task completion", async () => {
		const model = mockModel([
			{
				...textResponse("expensive"),
				usage: { promptTokens: 8, completionTokens: 8, totalTokens: 16 },
			},
		]);
		const agent = new Agent({ name: "worker", model });
		const wf = workflow({
			name: "budgeted",
			run: (ctx) =>
				ctx.phase("phase", [workflowTask({ id: "task", agent, input: "spend tokens" })]),
		});

		await expect(
			runWorkflow(wf, undefined, { budget: { maxTotalTokens: 10 } }),
		).rejects.toThrow("maxTotalTokens");
	});

	test("generates a workflow draft from an agent response", async () => {
		const model = mockModel([
			textResponse(
				JSON.stringify({
					name: "audit-auth",
					description: "Audit auth checks",
					phases: [{ name: "scan", purpose: "Find routes", agents: 4 }],
					script: "export default workflow({ name: 'audit-auth', run: async () => 'ok' })",
					estimatedTasks: 4,
					warnings: ["start small"],
				}),
			),
		]);
		const agent = new Agent({ name: "drafter", model });

		const draft = await generateWorkflowDraft(agent, "Audit routes for auth gaps");

		expect(draft.name).toBe("audit-auth");
		expect(draft.phases[0]?.name).toBe("scan");
		expect(draft.script).toContain("workflow");
		expect(draft.warnings).toEqual(["start small"]);
	});

	test("loads saved workflows from .stratus/workflows", async () => {
		const root = await mkdtemp(join(tmpdir(), "stratus-workflows-"));
		try {
			const workflowDir = join(root, ".stratus", "workflows");
			await mkdir(workflowDir, { recursive: true });
			const workflowPath = join(workflowDir, "daily-review.mjs");
			await writeFile(
				workflowPath,
				"export default { name: 'daily-review', run: async () => 'ready' };",
			);

			const discovered = await discoverSavedWorkflows({
				cwd: root,
				includeUser: false,
			});
			const loaded = await loadWorkflowModule(discovered[0]!.path);

			expect(discovered.map((item) => item.name)).toEqual(["daily-review"]);
			expect(loaded.workflow?.name).toBe("daily-review");
			await expect(runWorkflow(loaded.workflow!, undefined)).resolves.toMatchObject({
				output: "ready",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("manages runs and resumes from the latest snapshot", async () => {
		let executions = 0;
		const wf = workflow({
			name: "managed",
			run: (ctx) =>
				ctx.phase("phase", [
					workflowTask({
						id: "once",
						execute: () => {
							executions++;
							return "done";
						},
					}),
				]),
		});
		const manager = new WorkflowRunManager();
		const first = manager.start(wf, undefined);
		await first.result;

		const second = manager.resume(first);
		const resumed = await second.result;

		expect(first.status).toBe("completed");
		expect(resumed.output[0]?.status).toBe("skipped");
		expect(executions).toBe(1);
		expect(manager.list().length).toBe(2);
	});

	test("manager can resume completed work from a failed fail-fast phase", async () => {
		let firstTaskRuns = 0;
		let secondTaskRuns = 0;
		let failSecond = true;
		const wf = workflow({
			name: "failed-resume",
			run: (ctx) =>
				ctx.phase(
					"phase",
					[
						workflowTask({
							id: "first",
							execute: () => {
								firstTaskRuns++;
								return "first";
							},
						}),
						workflowTask({
							id: "second",
							execute: () => {
								secondTaskRuns++;
								if (failSecond) throw new Error("not yet");
								return "second";
							},
						}),
					],
					{ concurrency: 1 },
				),
		});
		const manager = new WorkflowRunManager();
		const first = manager.start(wf, undefined);

		await expect(first.result).rejects.toThrow("not yet");
		expect(first.status).toBe("failed");
		expect(first.snapshot.status).toBe("failed");
		expect(first.snapshot.phases[0]?.tasks.map((task) => task.id)).toEqual(["first", "second"]);

		failSecond = false;
		const second = manager.resume(first);
		const resumed = await second.result;

		expect(resumed.output.map((task) => task.status)).toEqual(["skipped", "completed"]);
		expect(firstTaskRuns).toBe(1);
		expect(secondTaskRuns).toBe(2);
	});

	test("resume cache keeps anonymous tasks distinct", async () => {
		let runs = 0;
		const wf = workflow({
			name: "anonymous-resume",
			run: (ctx) =>
				ctx.phase("phase", [
					workflowTask({
						execute: () => {
							runs++;
							return "one";
						},
					}),
					workflowTask({
						execute: () => {
							runs++;
							return "two";
						},
					}),
				]),
		});

		const first = await runWorkflow(wf, undefined);
		const second = await runWorkflow(wf, undefined, { resumeFrom: first });

		expect(second.output.map((task) => task.output)).toEqual(["one", "two"]);
		expect(second.output.map((task) => task.status)).toEqual(["skipped", "skipped"]);
		expect(runs).toBe(2);
	});

	test("manager snapshots report running status before completion", async () => {
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wf = workflow({
			name: "snapshot-status",
			run: (ctx) =>
				ctx.phase("phase", [
					workflowTask({
						id: "slow",
						execute: async () => {
							await ready;
							return "done";
						},
					}),
				]),
		});
		const manager = new WorkflowRunManager();
		const run = manager.start(wf, undefined);

		expect(run.status).toBe("running");
		expect(run.snapshot.status).toBe("running");

		release();
		await run.result;

		expect(run.snapshot.status).toBe("completed");
	});

	test("runs fan-out synthesis, verification, filtering, tournament, and loop helpers", async () => {
		const model = mockModel([
			textResponse("summary"),
			textResponse("ACCEPT looks good"),
			textResponse("REJECT unsupported"),
			textResponse("ACCEPT keep"),
			textResponse("REJECT drop"),
			textResponse("RIGHT wins"),
		]);
		const agent = new Agent({ name: "helper", model });
		const wf = workflow({
			name: "patterns",
			run: async (ctx) => {
				const fanout = await ctx.fanOutAndSynthesize({
					name: "fanout",
					tasks: [
						workflowTask({ id: "a", execute: () => "a" }),
						workflowTask({ id: "b", execute: () => "b" }),
					],
					synthesizer: agent,
					prompt: (results) => results.map((result) => result.output).join(","),
				});
				const verified = await ctx.adversarialVerify({
					name: "verify",
					findings: [
						{ id: "one", output: "one" },
						{ id: "two", output: "two" },
					],
					verifier: agent,
				});
				const filtered = await ctx.generateAndFilter({
					name: "generate",
					generators: [
						workflowTask({ id: "candidate-a", execute: () => "candidate a" }),
						workflowTask({ id: "candidate-b", execute: () => "candidate b" }),
					],
					filter: agent,
				});
				const tournament = await ctx.tournament({
					name: "tournament",
					contestants: [
						workflowTask({ id: "left", execute: () => "left answer" }),
						workflowTask({ id: "right", execute: () => "right answer" }),
					],
					judge: agent,
				});
				const loop = await ctx.loopUntilDone({
					name: "loop",
					step: ({ iteration }) => ({ done: iteration === 3, output: `iteration ${iteration}` }),
				});
				return {
					fanout: fanout.output,
					accepted: verified.accepted.length,
					filtered: filtered.accepted.map((result) => result.id),
					winner: tournament.winner?.id,
					loop,
				};
			},
		});

		const result = await runWorkflow(wf, undefined);

		expect(result.output.fanout).toBe("summary");
		expect(result.output.accepted).toBe(1);
		expect(result.output.filtered).toEqual(["candidate-a"]);
		expect(result.output.winner).toBe("right");
		expect(result.output.loop.done).toBe(true);
		expect(result.output.loop.iterations).toHaveLength(3);
	});
});
