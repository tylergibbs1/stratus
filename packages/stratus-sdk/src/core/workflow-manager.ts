import { RunAbortedError } from "./errors";
import type {
	Workflow,
	WorkflowEvent,
	WorkflowOptions,
	WorkflowPhaseResult,
	WorkflowRunResult,
	WorkflowRunSnapshot,
} from "./workflow";
import { streamWorkflow } from "./workflow";

export type ManagedWorkflowRunStatus = "running" | "completed" | "failed" | "stopped";

export interface WorkflowRunHandle<TArgs = unknown, TOutput = string> {
	readonly id: string;
	readonly workflow: Workflow<TArgs, TOutput>;
	readonly args: TArgs;
	readonly events: WorkflowEvent<TOutput>[];
	readonly result: Promise<WorkflowRunResult<TOutput>>;
	readonly status: ManagedWorkflowRunStatus;
	readonly snapshot: WorkflowRunSnapshot<TOutput>;
	onEvent(listener: (event: WorkflowEvent<TOutput>) => void): () => void;
	stop(): void;
}

interface MutableWorkflowRunHandle<TArgs, TOutput>
	extends WorkflowRunHandle<TArgs, TOutput> {
	status: ManagedWorkflowRunStatus;
	emit(event: WorkflowEvent<TOutput>): void;
}

export class WorkflowRunManager {
	private readonly runs = new Map<string, MutableWorkflowRunHandle<any, any>>();

	start<TArgs, TOutput = string>(
		wf: Workflow<TArgs, TOutput>,
		args: TArgs,
		options: WorkflowOptions = {},
	): WorkflowRunHandle<TArgs, TOutput> {
		const id = options.id ?? createManagedRunId();
		const controller = new AbortController();
		const signal = mergeAbortSignals(controller.signal, options.signal);
		const listeners = new Set<(event: WorkflowEvent<TOutput>) => void>();
		const events: WorkflowEvent<TOutput>[] = [];
		let phases: WorkflowPhaseResult[] = [];
		let usage = emptyUsage();
		let numTurns = 0;
		let totalCostUsd = 0;
		const startedAt = new Date();
		let latestSnapshot: WorkflowRunSnapshot<TOutput> | undefined;

		const streamed = streamWorkflow(wf, args, { ...options, id, signal });
		const handle: MutableWorkflowRunHandle<TArgs, TOutput> = {
			id,
			workflow: wf,
			args,
			events,
			status: "running",
			result: streamed.result
				.then((result) => {
					handle.status = "completed";
					latestSnapshot = result;
					return result;
				})
				.catch((error) => {
					handle.status = error instanceof RunAbortedError ? "stopped" : "failed";
					throw error;
				})
				.finally(() => {
					this.runs.set(id, handle);
				}),
				get snapshot() {
					if (latestSnapshot) return latestSnapshot;
					return buildManagedSnapshot({
						id,
						name: wf.name,
						status: handle.status,
						output: "",
						phases,
						usage,
					numTurns,
					totalCostUsd,
					startedAt,
				}) as WorkflowRunSnapshot<TOutput>;
			},
			onEvent(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			stop() {
				controller.abort();
			},
			emit(event) {
				events.push(event);
				if (event.type === "workflow_phase_completed") {
					phases = [...phases, event.phase];
					const totals = aggregatePhaseTotals(phases);
					usage = totals.usage;
					numTurns = totals.numTurns;
					totalCostUsd = totals.totalCostUsd;
					latestSnapshot = undefined;
				}
				if (event.type === "workflow_completed") {
					phases = event.result.phases;
					usage = event.result.usage;
					numTurns = event.result.numTurns;
					totalCostUsd = event.result.totalCostUsd;
					latestSnapshot = event.result;
				}
				for (const listener of listeners) listener(event);
			},
		};

		this.runs.set(id, handle);
		void (async () => {
			for await (const event of streamed.stream) {
				handle.emit(event);
			}
		})();
		return handle;
	}

	get<TArgs = unknown, TOutput = string>(
		id: string,
	): WorkflowRunHandle<TArgs, TOutput> | undefined {
		return this.runs.get(id);
	}

	list(): WorkflowRunHandle[] {
		return [...this.runs.values()];
	}

	stop(id: string): boolean {
		const run = this.runs.get(id);
		if (!run || run.status !== "running") return false;
		run.stop();
		return true;
	}

	resume<TArgs, TOutput>(
		run: WorkflowRunHandle<TArgs, TOutput>,
	): WorkflowRunHandle<TArgs, TOutput>;
	resume<TArgs, TOutput = string>(id: string): WorkflowRunHandle<TArgs, TOutput>;
	resume<TArgs, TOutput = string>(
		target: string | WorkflowRunHandle<TArgs, TOutput>,
	): WorkflowRunHandle<TArgs, TOutput> {
		const run = typeof target === "string" ? this.requireRun<TArgs, TOutput>(target) : target;
		return this.start(run.workflow, run.args, {
			id: createManagedRunId(),
			resumeFrom: run.snapshot,
		});
	}

	restart<TArgs, TOutput = string>(id: string): WorkflowRunHandle<TArgs, TOutput> {
		const run = this.requireRun<TArgs, TOutput>(id);
		return this.start(run.workflow, run.args, { id: createManagedRunId() });
	}

	private requireRun<TArgs, TOutput>(id: string): WorkflowRunHandle<TArgs, TOutput> {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown workflow run: ${id}`);
		return run;
	}
}

function mergeAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
	if (!secondary) return primary;
	if (secondary.aborted) {
		const controller = new AbortController();
		controller.abort();
		return controller.signal;
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	primary.addEventListener("abort", abort, { once: true });
	secondary.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

function buildManagedSnapshot(params: {
	id: string;
	name: string;
	status: WorkflowRunSnapshot["status"];
	output: string;
	phases: WorkflowPhaseResult[];
	usage: WorkflowRunResult["usage"];
	numTurns: number;
	totalCostUsd: number;
	startedAt: Date;
}): WorkflowRunSnapshot {
	const completedAt = new Date();
	return {
		id: params.id,
		name: params.name,
		status: params.status,
		output: params.output,
		phases: params.phases,
		usage: params.usage,
		numTurns: params.numTurns,
		totalCostUsd: params.totalCostUsd,
		startedAt: params.startedAt.toISOString(),
		completedAt: completedAt.toISOString(),
		durationMs: completedAt.getTime() - params.startedAt.getTime(),
	};
}

function aggregatePhaseTotals(phases: WorkflowPhaseResult[]): Pick<
	WorkflowRunResult,
	"usage" | "numTurns" | "totalCostUsd"
> {
	const usage = emptyUsage();
	let numTurns = 0;
	let totalCostUsd = 0;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			usage.promptTokens += task.usage.promptTokens;
			usage.completionTokens += task.usage.completionTokens;
			usage.totalTokens += task.usage.totalTokens;
			usage.cacheReadTokens = addOptional(usage.cacheReadTokens, task.usage.cacheReadTokens);
			usage.cacheCreationTokens = addOptional(
				usage.cacheCreationTokens,
				task.usage.cacheCreationTokens,
			);
			usage.reasoningTokens = addOptional(usage.reasoningTokens, task.usage.reasoningTokens);
			numTurns += task.numTurns;
			totalCostUsd += task.totalCostUsd;
		}
	}
	return { usage, numTurns, totalCostUsd };
}

function emptyUsage(): WorkflowRunResult["usage"] {
	return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addOptional(current: number | undefined, next: number | undefined): number | undefined {
	if (next === undefined) return current;
	return (current ?? 0) + next;
}

function createManagedRunId(): string {
	return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
