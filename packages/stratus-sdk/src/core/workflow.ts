import type { Agent } from "./agent";
import { RunAbortedError, StratusError } from "./errors";
import type { Model, UsageInfo } from "./model";
import type { InterruptedRunResult, RunResult } from "./result";
import { type RunOptions, run } from "./run";
import type { ChatMessage } from "./types";

const DEFAULT_WORKFLOW_CONCURRENCY = 4;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_MAX_TASKS = 1000;
const DEFAULT_MAX_WORKFLOW_ITERATIONS = 25;

export type WorkflowTaskStatus = "completed" | "interrupted" | "failed" | "skipped";
export type WorkflowPhaseStatus = "completed" | "failed";
export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";

export interface WorkflowTaskBase<TContext = unknown> {
	id?: string;
	name?: string;
	metadata?: Record<string, unknown>;
	context?: TContext;
	model?: Model;
	maxTurns?: number;
	runOptions?: Omit<RunOptions<TContext>, "context" | "model" | "maxTurns" | "signal">;
}

export interface WorkflowAgentTask<TContext = unknown, TOutput = undefined>
	extends WorkflowTaskBase<TContext> {
	agent: Agent<TContext, TOutput>;
	input: string | ChatMessage[];
	execute?: never;
}

export interface WorkflowFunctionTask<TContext = unknown, TValue = unknown>
	extends WorkflowTaskBase<TContext> {
	agent?: never;
	input?: never;
	execute: (params: WorkflowTaskExecuteParams<TContext>) => Promise<TValue> | TValue;
}

export type WorkflowTask<TContext = unknown, TValue = unknown> =
	| WorkflowAgentTask<TContext, unknown>
	| WorkflowFunctionTask<TContext, TValue>;

export interface WorkflowTaskExecuteParams<TContext = unknown> {
	task: WorkflowTask<TContext>;
	context: TContext | undefined;
	signal?: AbortSignal;
	workflow: WorkflowRuntimeContext<unknown>;
}

export interface WorkflowPhaseOptions {
	concurrency?: number;
	failFast?: boolean;
}

export interface WorkflowBudget {
	maxPromptTokens?: number;
	maxCompletionTokens?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
	maxDurationMs?: number;
}

export interface WorkflowOptions {
	id?: string;
	signal?: AbortSignal;
	concurrency?: number;
	maxConcurrency?: number;
	maxTasks?: number;
	budget?: WorkflowBudget;
	resumeFrom?: WorkflowRunSnapshot<unknown>;
}

export interface WorkflowConfig<TArgs = unknown, TOutput = string> {
	name: string;
	description?: string;
	run: (ctx: WorkflowRuntimeContext<TArgs>, args: TArgs) => Promise<TOutput> | TOutput;
}

export interface Workflow<TArgs = unknown, TOutput = string>
	extends WorkflowConfig<TArgs, TOutput> {}

export interface WorkflowTaskResult<TValue = unknown> {
	id: string;
	name: string;
	phaseId: string;
	phaseName: string;
	status: WorkflowTaskStatus;
	output: string;
	value?: TValue;
	error?: string;
	interrupted?: boolean;
	runResult?: RunResult<unknown> | InterruptedRunResult<unknown>;
	usage: UsageInfo;
	numTurns: number;
	totalCostUsd: number;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	metadata?: Record<string, unknown>;
}

export interface WorkflowPhaseResult {
	id: string;
	name: string;
	status: WorkflowPhaseStatus;
	tasks: WorkflowTaskResult[];
	startedAt: string;
	completedAt: string;
	durationMs: number;
}

export interface WorkflowRunResult<TOutput = string> {
	id: string;
	name: string;
	status: WorkflowRunStatus;
	output: TOutput;
	phases: WorkflowPhaseResult[];
	usage: UsageInfo;
	numTurns: number;
	totalCostUsd: number;
	startedAt: string;
	completedAt: string;
	durationMs: number;
}

export type WorkflowRunSnapshot<TOutput = string> = WorkflowRunResult<TOutput>;

export type WorkflowEvent<TOutput = string> =
	| { type: "workflow_started"; runId: string; name: string }
	| {
			type: "workflow_phase_started";
			runId: string;
			phase: Pick<WorkflowPhaseResult, "id" | "name">;
	  }
	| {
			type: "workflow_task_started";
			runId: string;
			phaseId: string;
			task: { id: string; name: string };
	  }
	| {
			type: "workflow_task_completed";
			runId: string;
			phaseId: string;
			task: WorkflowTaskResult;
	  }
	| { type: "workflow_task_failed"; runId: string; phaseId: string; task: WorkflowTaskResult }
	| { type: "workflow_task_skipped"; runId: string; phaseId: string; task: WorkflowTaskResult }
	| { type: "workflow_phase_completed"; runId: string; phase: WorkflowPhaseResult }
	| { type: "workflow_synthesis_started"; runId: string; agentName: string }
	| { type: "workflow_synthesis_completed"; runId: string; output: string }
	| { type: "workflow_completed"; runId: string; result: WorkflowRunResult<TOutput> }
	| { type: "workflow_failed"; runId: string; error: string };

export interface StreamedWorkflowResult<TOutput = string> {
	stream: AsyncGenerator<WorkflowEvent<TOutput>>;
	result: Promise<WorkflowRunResult<TOutput>>;
}

export interface WorkflowRuntimeContext<TArgs = unknown> {
	readonly runId: string;
	readonly name: string;
	readonly args: TArgs;
	readonly snapshot: WorkflowRunSnapshot;
	phase<TContext = unknown, TValue = unknown>(
		name: string,
		tasks: WorkflowTask<TContext, TValue>[],
		options?: WorkflowPhaseOptions,
	): Promise<WorkflowTaskResult<TValue>[]>;
	runTask<TContext = unknown, TValue = unknown>(
		task: WorkflowTask<TContext, TValue>,
		options?: { phaseId?: string; phaseName?: string },
	): Promise<WorkflowTaskResult<TValue>>;
	synthesize<TContext, TOutput = undefined>(
		agent: Agent<TContext, TOutput>,
		input: string | ChatMessage[],
		options?: RunOptions<TContext, TOutput>,
	): Promise<RunResult<TOutput> | InterruptedRunResult<TOutput>>;
	fanOutAndSynthesize<TContext = unknown, TValue = unknown, TOutput = undefined>(
		config: WorkflowFanOutAndSynthesizeConfig<TContext, TValue, TOutput>,
	): Promise<WorkflowFanOutAndSynthesizeResult<TValue, TOutput>>;
	adversarialVerify<TContext = unknown>(
		config: WorkflowAdversarialVerificationConfig<TContext>,
	): Promise<WorkflowAdversarialVerificationResult>;
	generateAndFilter<TContext = unknown>(
		config: WorkflowGenerateAndFilterConfig<TContext>,
	): Promise<WorkflowGenerateAndFilterResult>;
	tournament<TContext = unknown>(
		config: WorkflowTournamentConfig<TContext>,
	): Promise<WorkflowTournamentResult>;
	loopUntilDone<TValue = unknown>(
		config: WorkflowLoopUntilDoneConfig<TArgs, TValue>,
	): Promise<WorkflowLoopUntilDoneResult<TValue>>;
}

export interface WorkflowFanOutAndSynthesizeConfig<
	TContext = unknown,
	TValue = unknown,
	TOutput = undefined,
> {
	name: string;
	tasks: WorkflowTask<TContext, TValue>[];
	synthesizer: Agent<TContext, TOutput>;
	prompt: (results: WorkflowTaskResult<TValue>[]) => string | ChatMessage[];
	phaseOptions?: WorkflowPhaseOptions;
	synthesisOptions?: RunOptions<TContext, TOutput>;
}

export interface WorkflowFanOutAndSynthesizeResult<TValue = unknown, TOutput = undefined> {
	tasks: WorkflowTaskResult<TValue>[];
	synthesis: RunResult<TOutput> | InterruptedRunResult<TOutput>;
	output: string;
}

export interface WorkflowAdversarialVerificationConfig<TContext = unknown> {
	name: string;
	findings: Array<{ id?: string; name?: string; output: string; metadata?: Record<string, unknown> }>;
	verifier: Agent<TContext>;
	prompt?: (finding: { id?: string; name?: string; output: string; metadata?: Record<string, unknown> }) =>
		| string
		| ChatMessage[];
	phaseOptions?: WorkflowPhaseOptions;
	runOptions?: Omit<RunOptions<TContext>, "context" | "model" | "maxTurns" | "signal">;
}

export interface WorkflowAdversarialVerificationResult {
	verifications: WorkflowTaskResult[];
	accepted: WorkflowTaskResult[];
	rejected: WorkflowTaskResult[];
}

export interface WorkflowGenerateAndFilterConfig<TContext = unknown> {
	name: string;
	generators: WorkflowTask<TContext>[];
	filter: Agent<TContext>;
	prompt?: (candidate: WorkflowTaskResult, index: number) => string | ChatMessage[];
	phaseOptions?: WorkflowPhaseOptions;
	runOptions?: Omit<RunOptions<TContext>, "context" | "model" | "maxTurns" | "signal">;
}

export interface WorkflowGenerateAndFilterResult {
	candidates: WorkflowTaskResult[];
	filtered: WorkflowTaskResult[];
	accepted: WorkflowTaskResult[];
}

export interface WorkflowTournamentConfig<TContext = unknown> {
	name: string;
	contestants: WorkflowTask<TContext>[];
	judge: Agent<TContext>;
	prompt?: (left: WorkflowTaskResult, right: WorkflowTaskResult) => string | ChatMessage[];
	phaseOptions?: WorkflowPhaseOptions;
	runOptions?: Omit<RunOptions<TContext>, "context" | "model" | "maxTurns" | "signal">;
}

export interface WorkflowTournamentResult {
	contestants: WorkflowTaskResult[];
	matches: WorkflowTaskResult[];
	winner?: WorkflowTaskResult;
}

export interface WorkflowLoopUntilDoneConfig<TArgs = unknown, TValue = unknown> {
	name: string;
	maxIterations?: number;
	step: (params: {
		ctx: WorkflowRuntimeContext<TArgs>;
		iteration: number;
		previous?: WorkflowLoopStepResult<TValue>;
	}) => Promise<WorkflowLoopStepResult<TValue>> | WorkflowLoopStepResult<TValue>;
}

export interface WorkflowLoopStepResult<TValue = unknown> {
	done: boolean;
	value?: TValue;
	output?: string;
}

export interface WorkflowLoopUntilDoneResult<TValue = unknown> {
	iterations: WorkflowLoopStepResult<TValue>[];
	done: boolean;
	output: string;
}

interface WorkflowState<TArgs> {
	id: string;
	name: string;
	args: TArgs;
	options: NormalizedWorkflowOptions;
	startedAt: Date;
	phases: WorkflowPhaseResult[];
	totalTasks: number;
	usage: UsageInfo;
	numTurns: number;
	totalCostUsd: number;
	emit: (event: WorkflowEvent<unknown>) => void;
	resumeCache: Map<string, WorkflowTaskResult>;
}

type NormalizedWorkflowOptions = Required<
	Pick<WorkflowOptions, "concurrency" | "maxConcurrency" | "maxTasks">
> &
	WorkflowOptions;

export function workflow<TArgs = unknown, TOutput = string>(
	config: WorkflowConfig<TArgs, TOutput>,
): Workflow<TArgs, TOutput> {
	return config;
}

export function workflowTask<TContext = unknown, TValue = unknown>(
	task: WorkflowTask<TContext, TValue>,
): WorkflowTask<TContext, TValue> {
	return task;
}

export async function runWorkflow<TArgs, TOutput = string>(
	wf: Workflow<TArgs, TOutput>,
	args: TArgs,
	options?: WorkflowOptions,
): Promise<WorkflowRunResult<TOutput>> {
	return executeWorkflow(wf, args, options, () => {});
}

export function streamWorkflow<TArgs, TOutput = string>(
	wf: Workflow<TArgs, TOutput>,
	args: TArgs,
	options?: WorkflowOptions,
): StreamedWorkflowResult<TOutput> {
	const channel = createWorkflowEventChannel<TOutput>();
	const result = executeWorkflow(wf, args, options, (event) => channel.push(event)).finally(() =>
		channel.done(),
	);

	return { stream: channel[Symbol.asyncIterator](), result };
}

async function executeWorkflow<TArgs, TOutput>(
	wf: Workflow<TArgs, TOutput>,
	args: TArgs,
	options: WorkflowOptions | undefined,
	emit: (event: WorkflowEvent<TOutput>) => void,
): Promise<WorkflowRunResult<TOutput>> {
	const normalized = normalizeOptions(options);
	const startedAt = new Date();
	const state: WorkflowState<TArgs> = {
		id: normalized.id ?? createRunId(),
		name: wf.name,
		args,
		options: normalized,
		startedAt,
		phases: [],
		totalTasks: 0,
		usage: emptyUsage(),
		numTurns: 0,
		totalCostUsd: 0,
		emit: emit as (event: WorkflowEvent<unknown>) => void,
		resumeCache: buildResumeCache(normalized.resumeFrom),
	};

	const ctx = new DefaultWorkflowRuntimeContext(state);
	emit({ type: "workflow_started", runId: state.id, name: wf.name });

	try {
		checkWorkflowAborted(normalized.signal);
		checkWorkflowBudget(state);
		const output = await wf.run(ctx, args);
		checkWorkflowBudget(state);
		const completedAt = new Date();
		const result: WorkflowRunResult<TOutput> = {
			id: state.id,
			name: wf.name,
			status: "completed",
			output,
			phases: [...state.phases],
			usage: state.usage,
			numTurns: state.numTurns,
			totalCostUsd: state.totalCostUsd,
			startedAt: startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			durationMs: completedAt.getTime() - startedAt.getTime(),
		};
		emit({ type: "workflow_completed", runId: state.id, result });
		return result;
	} catch (error) {
		const message = getErrorMessage(error);
		emit({ type: "workflow_failed", runId: state.id, error: message });
		throw error;
	}
}

class DefaultWorkflowRuntimeContext<TArgs = unknown> implements WorkflowRuntimeContext<TArgs> {
	readonly runId: string;
	readonly name: string;
	readonly args: TArgs;

	constructor(private readonly state: WorkflowState<TArgs>) {
		this.runId = state.id;
		this.name = state.name;
		this.args = state.args;
	}

	get snapshot(): WorkflowRunSnapshot {
		const now = new Date();
		return {
			id: this.state.id,
			name: this.state.name,
			status: "running",
			output: "",
			phases: [...this.state.phases],
			usage: this.state.usage,
			numTurns: this.state.numTurns,
			totalCostUsd: this.state.totalCostUsd,
			startedAt: this.state.startedAt.toISOString(),
			completedAt: now.toISOString(),
			durationMs: now.getTime() - this.state.startedAt.getTime(),
		};
	}

	async phase<TContext = unknown, TValue = unknown>(
		name: string,
		tasks: WorkflowTask<TContext, TValue>[],
		options?: WorkflowPhaseOptions,
	): Promise<WorkflowTaskResult<TValue>[]> {
		checkWorkflowAborted(this.state.options.signal);
		if (tasks.length === 0) {
			const now = new Date();
			const emptyPhase: WorkflowPhaseResult = {
				id: slugify(name),
				name,
				status: "completed",
				tasks: [],
				startedAt: now.toISOString(),
				completedAt: now.toISOString(),
				durationMs: 0,
			};
			this.state.phases.push(emptyPhase);
			this.state.emit({ type: "workflow_phase_started", runId: this.runId, phase: emptyPhase });
			this.state.emit({ type: "workflow_phase_completed", runId: this.runId, phase: emptyPhase });
			return [];
		}

		this.state.totalTasks += tasks.length;
		if (this.state.totalTasks > this.state.options.maxTasks) {
			throw new StratusError(
				`Workflow exceeded maxTasks (${this.state.options.maxTasks}); received ${this.state.totalTasks}`,
			);
		}

		const startedAt = new Date();
		const phaseId = uniquePhaseId(name, this.state.phases.length);
		const phaseShell = { id: phaseId, name };
		this.state.emit({ type: "workflow_phase_started", runId: this.runId, phase: phaseShell });

		const concurrency = clampConcurrency(
			options?.concurrency ?? this.state.options.concurrency,
			this.state.options.maxConcurrency,
		);
		const { results, failure } = await runTaskPool<TContext, TValue>({
			ctx: this,
			phaseId,
			phaseName: name,
			tasks,
			concurrency,
			failFast: options?.failFast ?? true,
		});
		const completedAt = new Date();
		const failed = results.some((result) => result.status === "failed");
		const phase: WorkflowPhaseResult = {
			id: phaseId,
			name,
			status: failed || failure ? "failed" : "completed",
			tasks: results,
			startedAt: startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			durationMs: completedAt.getTime() - startedAt.getTime(),
		};
		this.state.phases.push(phase);
		this.state.emit({ type: "workflow_phase_completed", runId: this.runId, phase });
		checkWorkflowBudget(this.state);
		if (failure) {
			throw new StratusError(`Workflow task "${failure.name}" failed: ${failure.error}`);
		}
		return results;
	}

	async runTask<TContext = unknown, TValue = unknown>(
		task: WorkflowTask<TContext, TValue>,
		options?: { phaseId?: string; phaseName?: string },
	): Promise<WorkflowTaskResult<TValue>> {
		const phaseId = options?.phaseId ?? "adhoc";
		const phaseName = options?.phaseName ?? "Ad hoc";
		const taskId = task.id ?? `${phaseId}:${task.name ?? "task"}`;
		const cacheKey = `${phaseId}:${taskId}`;
		const cached = this.state.resumeCache.get(cacheKey);
		if (cached?.status === "completed" || cached?.status === "interrupted") {
			const skipped = { ...cached, status: "skipped" as const };
			this.state.emit({ type: "workflow_task_skipped", runId: this.runId, phaseId, task: skipped });
			return skipped as WorkflowTaskResult<TValue>;
		}

		checkWorkflowAborted(this.state.options.signal);
		const name = task.name ?? taskId;
		this.state.emit({
			type: "workflow_task_started",
			runId: this.runId,
			phaseId,
			task: { id: taskId, name },
		});

		const startedAt = new Date();
		let result: Awaited<ReturnType<typeof executeTask<TContext, TValue>>>;
		try {
			result = await executeTask(task, {
				task,
				context: task.context,
				signal: this.state.options.signal,
				workflow: this,
			});
		} catch (error) {
			const completedAt = new Date();
			const taskResult: WorkflowTaskResult<TValue> = {
				id: taskId,
				name,
				phaseId,
				phaseName,
				status: "failed",
				output: "",
				error: getErrorMessage(error),
				usage: emptyUsage(),
				numTurns: 0,
				totalCostUsd: 0,
				startedAt: startedAt.toISOString(),
				completedAt: completedAt.toISOString(),
				durationMs: completedAt.getTime() - startedAt.getTime(),
				metadata: task.metadata,
			};
			this.state.emit({
				type: "workflow_task_failed",
				runId: this.runId,
				phaseId,
				task: taskResult,
			});
			return taskResult;
		}

		const completedAt = new Date();
		const taskResult: WorkflowTaskResult<TValue> = {
			id: taskId,
			name,
			phaseId,
			phaseName,
			status: result.status,
			output: result.output,
			value: result.value as TValue,
			interrupted: result.interrupted,
			runResult: result.runResult,
			usage: result.usage,
			numTurns: result.numTurns,
			totalCostUsd: result.totalCostUsd,
			startedAt: startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			durationMs: completedAt.getTime() - startedAt.getTime(),
			metadata: task.metadata,
		};
		this.addTaskTotals(taskResult);
		this.state.emit({
			type: "workflow_task_completed",
			runId: this.runId,
			phaseId,
			task: taskResult,
		});
		checkWorkflowBudget(this.state);
		return taskResult;
	}

	async synthesize<TContext, TOutput = undefined>(
		agent: Agent<TContext, TOutput>,
		input: string | ChatMessage[],
		options?: RunOptions<TContext, TOutput>,
	): Promise<RunResult<TOutput> | InterruptedRunResult<TOutput>> {
		this.state.emit({
			type: "workflow_synthesis_started",
			runId: this.runId,
			agentName: agent.name,
		});
		const result = await run(agent, input, {
			...options,
			signal: options?.signal ?? this.state.options.signal,
		});
		addUsage(this.state.usage, result.usage);
		this.state.numTurns += result.numTurns;
		this.state.totalCostUsd += result.totalCostUsd;
		this.state.emit({
			type: "workflow_synthesis_completed",
			runId: this.runId,
			output: result.output,
		});
		checkWorkflowBudget(this.state);
		return result;
	}

	async fanOutAndSynthesize<TContext = unknown, TValue = unknown, TOutput = undefined>(
		config: WorkflowFanOutAndSynthesizeConfig<TContext, TValue, TOutput>,
	): Promise<WorkflowFanOutAndSynthesizeResult<TValue, TOutput>> {
		const tasks = await this.phase(config.name, config.tasks, config.phaseOptions);
		const synthesis = await this.synthesize(
			config.synthesizer,
			config.prompt(tasks),
			config.synthesisOptions,
		);
		return { tasks, synthesis, output: synthesis.output };
	}

	async adversarialVerify<TContext = unknown>(
		config: WorkflowAdversarialVerificationConfig<TContext>,
	): Promise<WorkflowAdversarialVerificationResult> {
		const tasks = config.findings.map((finding, index) =>
			workflowTask<TContext>({
				id: finding.id ?? `verify-${index + 1}`,
				name: finding.name ? `verify ${finding.name}` : `verify ${index + 1}`,
				agent: config.verifier,
				input:
					config.prompt?.(finding) ??
					`Adversarially verify this finding. Start with ACCEPT or REJECT, then explain briefly.\n\n${finding.output}`,
				runOptions: config.runOptions,
				metadata: finding.metadata,
			}),
		);
		const verifications = await this.phase(config.name, tasks, config.phaseOptions);
		const accepted = verifications.filter((result) => verdictAccepts(result.output));
		return {
			verifications,
			accepted,
			rejected: verifications.filter((result) => !accepted.includes(result)),
		};
	}

	async generateAndFilter<TContext = unknown>(
		config: WorkflowGenerateAndFilterConfig<TContext>,
	): Promise<WorkflowGenerateAndFilterResult> {
		const candidates = await this.phase(config.name, config.generators, config.phaseOptions);
		const filterTasks = candidates.map((candidate, index) =>
			workflowTask<TContext>({
				id: `filter-${candidate.id}`,
				name: `filter ${candidate.name}`,
				agent: config.filter,
				input:
					config.prompt?.(candidate, index) ??
					`Evaluate this candidate. Start with ACCEPT or REJECT, then explain briefly.\n\n${candidate.output}`,
				runOptions: config.runOptions,
				metadata: candidate.metadata,
			}),
		);
		const filtered = await this.phase(`${config.name} filter`, filterTasks, config.phaseOptions);
		return {
			candidates,
			filtered,
			accepted: candidates.filter((_, index) => verdictAccepts(filtered[index]?.output ?? "")),
		};
	}

	async tournament<TContext = unknown>(
		config: WorkflowTournamentConfig<TContext>,
	): Promise<WorkflowTournamentResult> {
		const contestants = await this.phase(config.name, config.contestants, config.phaseOptions);
		let round = contestants.filter((result) => result.status === "completed");
		const matches: WorkflowTaskResult[] = [];
		let roundIndex = 1;

		while (round.length > 1) {
			const matchTasks: WorkflowTask<TContext>[] = [];
			for (let index = 0; index < round.length; index += 2) {
				const left = round[index];
				const right = round[index + 1];
				if (!left || !right) continue;
				matchTasks.push(
					workflowTask<TContext>({
						id: `round-${roundIndex}-match-${Math.floor(index / 2) + 1}`,
						name: `${left.name} vs ${right.name}`,
						agent: config.judge,
						input:
							config.prompt?.(left, right) ??
							`Pick the better output. Start with LEFT or RIGHT, then explain briefly.\n\nLEFT:\n${left.output}\n\nRIGHT:\n${right.output}`,
						runOptions: config.runOptions,
						metadata: { leftId: left.id, rightId: right.id },
					}),
				);
			}

			const roundMatches = await this.phase(`${config.name} round ${roundIndex}`, matchTasks, {
				...config.phaseOptions,
				failFast: config.phaseOptions?.failFast ?? false,
			});
			matches.push(...roundMatches);
			const winners: WorkflowTaskResult[] = [];
			for (let index = 0; index < round.length; index += 2) {
				const left = round[index];
				const right = round[index + 1];
				if (!left) continue;
				if (!right) {
					winners.push(left);
					continue;
				}
				const match = roundMatches[Math.floor(index / 2)];
				winners.push(verdictPrefersRight(match?.output ?? "") ? right : left);
			}
			round = winners;
			roundIndex++;
		}

		return { contestants, matches, winner: round[0] };
	}

	async loopUntilDone<TValue = unknown>(
		config: WorkflowLoopUntilDoneConfig<TArgs, TValue>,
	): Promise<WorkflowLoopUntilDoneResult<TValue>> {
		const maxIterations = config.maxIterations ?? DEFAULT_MAX_WORKFLOW_ITERATIONS;
		const iterations: WorkflowLoopStepResult<TValue>[] = [];
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			checkWorkflowAborted(this.state.options.signal);
			checkWorkflowBudget(this.state);
			const previous = iterations.at(-1);
			const step = await config.step({ ctx: this, iteration, previous });
			iterations.push(step);
			if (step.done) {
				return { iterations, done: true, output: step.output ?? stringifyTaskValue(step.value) };
			}
		}
		return {
			iterations,
			done: false,
			output: `Stopped after ${maxIterations} iterations without meeting the stop condition.`,
		};
	}

	private addTaskTotals(result: WorkflowTaskResult): void {
		addUsage(this.state.usage, result.usage);
		this.state.numTurns += result.numTurns;
		this.state.totalCostUsd += result.totalCostUsd;
	}
}

async function executeTask<TContext, TValue>(
	task: WorkflowTask<TContext, TValue>,
	params: WorkflowTaskExecuteParams<TContext>,
): Promise<{
	status: "completed" | "interrupted";
	output: string;
	value?: TValue;
	interrupted?: boolean;
	runResult?: RunResult<unknown> | InterruptedRunResult<unknown>;
	usage: UsageInfo;
	numTurns: number;
	totalCostUsd: number;
}> {
	if ("execute" in task && task.execute) {
		const value = await task.execute(params);
		return {
			status: "completed",
			output: stringifyTaskValue(value),
			value: value as TValue,
			usage: emptyUsage(),
			numTurns: 0,
			totalCostUsd: 0,
		};
	}

	const result = await run(task.agent, task.input, {
		...task.runOptions,
		context: task.context,
		model: task.model,
		maxTurns: task.maxTurns,
		signal: params.signal,
	});

	return {
		status: result.interrupted ? "interrupted" : "completed",
		output: result.output,
		value: result.output as TValue,
		interrupted: result.interrupted,
		runResult: result,
		usage: result.usage,
		numTurns: result.numTurns,
		totalCostUsd: result.totalCostUsd,
	};
}

async function runTaskPool<TContext, TValue>(params: {
	ctx: WorkflowRuntimeContext<unknown>;
	phaseId: string;
	phaseName: string;
	tasks: WorkflowTask<TContext, TValue>[];
	concurrency: number;
	failFast: boolean;
}): Promise<{
	results: WorkflowTaskResult<TValue>[];
	failure?: WorkflowTaskResult<TValue>;
}> {
	const results: WorkflowTaskResult<TValue>[] = new Array(params.tasks.length);
	let next = 0;
	let failure: WorkflowTaskResult<TValue> | undefined;

	async function worker(): Promise<void> {
		while (next < params.tasks.length && !failure) {
			const index = next++;
			const task = params.tasks[index];
			if (!task) return;
			const runnableTask =
				task.id === undefined
					? { ...task, id: `${slugify(task.name ?? "task")}-${index + 1}` }
					: task;
			const result = await params.ctx.runTask(runnableTask, {
				phaseId: params.phaseId,
				phaseName: params.phaseName,
			});
			results[index] = result;
			if (params.failFast && result.status === "failed") {
				failure = result;
			}
		}
	}

	const workerCount = Math.min(params.concurrency, params.tasks.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	const completedResults = results.filter(Boolean);
	return { results: completedResults, failure };
}

function normalizeOptions(options?: WorkflowOptions): NormalizedWorkflowOptions {
	const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	return {
		...options,
		concurrency: clampConcurrency(
			options?.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
			maxConcurrency,
		),
		maxConcurrency,
		maxTasks: options?.maxTasks ?? DEFAULT_MAX_TASKS,
	};
}

function checkWorkflowBudget(state: WorkflowState<unknown>): void {
	const budget = state.options.budget;
	if (!budget) return;
	const elapsedMs = Date.now() - state.startedAt.getTime();
	if (budget.maxDurationMs !== undefined && elapsedMs > budget.maxDurationMs) {
		throw new StratusError(`Workflow exceeded maxDurationMs (${budget.maxDurationMs})`);
	}
	if (
		budget.maxPromptTokens !== undefined &&
		state.usage.promptTokens > budget.maxPromptTokens
	) {
		throw new StratusError(`Workflow exceeded maxPromptTokens (${budget.maxPromptTokens})`);
	}
	if (
		budget.maxCompletionTokens !== undefined &&
		state.usage.completionTokens > budget.maxCompletionTokens
	) {
		throw new StratusError(
			`Workflow exceeded maxCompletionTokens (${budget.maxCompletionTokens})`,
		);
	}
	if (budget.maxTotalTokens !== undefined && state.usage.totalTokens > budget.maxTotalTokens) {
		throw new StratusError(`Workflow exceeded maxTotalTokens (${budget.maxTotalTokens})`);
	}
	if (budget.maxCostUsd !== undefined && state.totalCostUsd > budget.maxCostUsd) {
		throw new StratusError(`Workflow exceeded maxCostUsd (${budget.maxCostUsd})`);
	}
}

function clampConcurrency(concurrency: number, maxConcurrency: number): number {
	if (!Number.isFinite(concurrency) || concurrency < 1) {
		throw new StratusError("Workflow concurrency must be a positive number");
	}
	return Math.min(Math.floor(concurrency), maxConcurrency);
}

function buildResumeCache(
	snapshot?: WorkflowRunSnapshot<unknown>,
): Map<string, WorkflowTaskResult> {
	const cache = new Map<string, WorkflowTaskResult>();
	if (!snapshot) return cache;
	for (const phase of snapshot.phases) {
		for (const task of phase.tasks) {
			cache.set(`${phase.id}:${task.id}`, task);
		}
	}
	return cache;
}

function emptyUsage(): UsageInfo {
	return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(target: UsageInfo, usage: UsageInfo | undefined): void {
	if (!usage) return;
	target.promptTokens += usage.promptTokens;
	target.completionTokens += usage.completionTokens;
	target.totalTokens += usage.totalTokens;
	target.cacheReadTokens = addOptional(target.cacheReadTokens, usage.cacheReadTokens);
	target.cacheCreationTokens = addOptional(target.cacheCreationTokens, usage.cacheCreationTokens);
	target.reasoningTokens = addOptional(target.reasoningTokens, usage.reasoningTokens);
}

function addOptional(current: number | undefined, next: number | undefined): number | undefined {
	if (next === undefined) return current;
	return (current ?? 0) + next;
}

function checkWorkflowAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new RunAbortedError();
}

function uniquePhaseId(name: string, index: number): string {
	return `${slugify(name)}-${index + 1}`;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return slug || "phase";
}

function createRunId(): string {
	return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stringifyTaskValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function verdictAccepts(output: string): boolean {
	return /^\s*(accept|accepted|pass|passed|valid|yes)\b/i.test(output);
}

function verdictPrefersRight(output: string): boolean {
	return /^\s*(right|b|second|winner:\s*right)\b/i.test(output);
}

function createWorkflowEventChannel<TOutput>(): {
	push: (event: WorkflowEvent<TOutput>) => void;
	done: () => void;
	[Symbol.asyncIterator]: () => AsyncGenerator<WorkflowEvent<TOutput>>;
} {
	const queue: WorkflowEvent<TOutput>[] = [];
	let resolve: (() => void) | undefined;
	let finished = false;

	return {
		push(event) {
			queue.push(event);
			resolve?.();
			resolve = undefined;
		},
		done() {
			finished = true;
			resolve?.();
			resolve = undefined;
		},
		async *[Symbol.asyncIterator]() {
			while (!finished || queue.length > 0) {
				if (queue.length === 0) {
					await new Promise<void>((r) => {
						resolve = r;
					});
					continue;
				}
				const event = queue.shift();
				if (event) yield event;
			}
		},
	};
}
