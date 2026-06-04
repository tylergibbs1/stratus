import { describe, expect, test } from "bun:test";
import { Agent } from "../../src/core/agent";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../../src/core/model";
import {
	runWorkflow,
	streamWorkflow,
	type WorkflowTask,
	workflow,
	workflowTask,
} from "../../src/core/workflow";
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

describe("workflows", () => {
	test("runs agent tasks in bounded parallel phases and aggregates usage", async () => {
		const model = mockModel([
			{
				...textResponse("one"),
				usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
			},
			{
				...textResponse("two"),
				usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
			},
		]);
		const agent = new Agent({ name: "worker", model });
		const wf = workflow({
			name: "audit",
			run: async (ctx) => {
				const tasks = ["a", "b"].map((id) =>
					workflowTask({
						id,
						name: `check ${id}`,
						agent,
						input: `check ${id}`,
					}),
				);
				const results = await ctx.phase("checks", tasks, { concurrency: 2 });
				return results.map((result) => result.output).join(",");
			},
		});

		const result = await runWorkflow(wf, undefined);

		expect(result.output).toBe("one,two");
		expect(result.phases).toHaveLength(1);
		const phase = requirePhase(result.phases[0]);
		expect(phase.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
		expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
		expect(result.numTurns).toBe(2);
		expect(model.requests).toHaveLength(2);
	});

	test("streams workflow progress events", async () => {
		const wf = workflow({
			name: "eventful",
			run: async (ctx) => {
				await ctx.phase("phase", [
					workflowTask({
						id: "custom",
						execute: () => "done",
					}),
				]);
				return "ok";
			},
		});

		const streamed = streamWorkflow(wf, undefined);
		const events = [];
		for await (const event of streamed.stream) {
			events.push(event.type);
		}
		const result = await streamed.result;

		expect(result.output).toBe("ok");
		expect(events).toEqual([
			"workflow_started",
			"workflow_phase_started",
			"workflow_task_started",
			"workflow_task_completed",
			"workflow_phase_completed",
			"workflow_completed",
		]);
	});

	test("continues a phase when failFast is false", async () => {
		const wf = workflow({
			name: "tolerant",
			run: async (ctx) => {
				const results = await ctx.phase(
					"mixed",
					[
						workflowTask({ id: "bad", execute: () => Promise.reject(new Error("boom")) }),
						workflowTask({ id: "good", execute: () => "fine" }),
					],
					{ failFast: false },
				);
				return results;
			},
		});

		const result = await runWorkflow(wf, undefined);

		expect(result.output.map((task) => task.status)).toEqual(["failed", "completed"]);
		const phase = requirePhase(result.phases[0]);
		const firstTask = requireTask(phase.tasks[0]);
		expect(phase.status).toBe("failed");
		expect(firstTask.error).toBe("boom");
	});

	test("uses resumeFrom to skip completed task results", async () => {
		const model = mockModel([textResponse("fresh")]);
		const agent = new Agent({ name: "worker", model });
		const tasks: WorkflowTask[] = [
			workflowTask({ id: "cached", agent, input: "cached" }),
			workflowTask({ id: "fresh", agent, input: "fresh" }),
		];
		const wf = workflow({
			name: "resume",
			run: (ctx) => ctx.phase("scan", tasks),
		});

		const prior = await runWorkflow(
			workflow({
				name: "resume",
				run: (ctx) =>
					ctx.phase("scan", [
						workflowTask({
							id: "cached",
							execute: () => "cached output",
						}),
					]),
			}),
			undefined,
		);
		const result = await runWorkflow(wf, undefined, { resumeFrom: prior });

		expect(result.output.map((task) => task.status)).toEqual(["skipped", "completed"]);
		const cached = requireTask(result.output[0]);
		const fresh = requireTask(result.output[1]);
		expect(cached.output).toBe("cached output");
		expect(fresh.output).toBe("fresh");
		expect(model.requests).toHaveLength(1);
	});

	test("synthesizes phase results through a Stratus agent", async () => {
		const synthesisModel = mockModel([textResponse("final report")]);
		const synthesizer = new Agent({ name: "synthesizer", model: synthesisModel });
		const wf = workflow({
			name: "research",
			run: async (ctx) => {
				const results = await ctx.phase("research", [
					workflowTask({ id: "left", execute: () => "left finding" }),
					workflowTask({ id: "right", execute: () => "right finding" }),
				]);
				const synthesis = await ctx.synthesize(
					synthesizer,
					`Summarize:\n${results.map((result) => result.output).join("\n")}`,
				);
				return synthesis.output;
			},
		});

		const result = await runWorkflow(wf, undefined);

		expect(result.output).toBe("final report");
		const request = synthesisModel.requests[0];
		if (!request) throw new Error("Expected synthesis request");
		expect(request.messages.at(-1)?.content).toContain("left finding");
	});
});

function requirePhase<T>(phase: T | undefined): T {
	if (!phase) throw new Error("Expected phase");
	return phase;
}

function requireTask<T>(task: T | undefined): T {
	if (!task) throw new Error("Expected task");
	return task;
}
