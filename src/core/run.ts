import type { Agent } from "./agent";
import { RunContext } from "./context";
import type { CostEstimator } from "./cost";
import {
	MaxBudgetExceededError,
	MaxTurnsExceededError,
	OutputParseError,
	RunAbortedError,
	StratusError,
	ToolTimeoutError,
} from "./errors";
import {
	runInputGuardrails,
	runOutputGuardrails,
	runToolInputGuardrails,
	runToolOutputGuardrails,
} from "./guardrails";
import type {
	GuardrailRunResult,
	ToolInputGuardrail,
	ToolOutputGuardrail,
} from "./guardrails";
import type {
	AfterToolCallHook,
	BeforeToolCallHook,
	HandoffDecision,
	MatchedAfterToolCallHook,
	MatchedToolCallHook,
	RunHooks,
	ToolCallDecision,
	ToolMatcher,
} from "./hooks";
import { handoffToDefinition } from "./handoff";
import { isHostedTool, isFunctionTool } from "./hosted-tool";
import type { FinishReason, Model, ModelRequest, ModelResponse, StreamEvent, UsageInfo } from "./model";
import { subagentToDefinition, subagentToTool } from "./subagent";
import type { SubAgent } from "./subagent";
import { RunResult } from "./result";
import { toolToDefinition } from "./tool";

import { getCurrentTrace } from "./tracing";
import type { AssistantMessage, ChatMessage, HostedToolDefinition, ToolCall, ToolDefinition, ToolMessage } from "./types";

const DEFAULT_MAX_TURNS = 10;

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function extractToolCallDecision(
	result: void | ToolCallDecision | undefined,
): ToolCallDecision | undefined {
	if (result && typeof result === "object" && "decision" in result) {
		return result;
	}
	return undefined;
}

function extractHandoffDecision(
	result: void | HandoffDecision | undefined,
): HandoffDecision | undefined {
	if (result && typeof result === "object" && "decision" in result) {
		return result;
	}
	return undefined;
}

function matchesToolName(matcher: ToolMatcher, name: string): boolean {
	if (typeof matcher === "string") return matcher === name;
	return matcher.test(name);
}

function matchesAny(matchers: ToolMatcher | ToolMatcher[], name: string): boolean {
	if (Array.isArray(matchers)) {
		return matchers.some((m) => matchesToolName(m, name));
	}
	return matchesToolName(matchers, name);
}

async function resolveBeforeToolCallHook<TContext>(
	hook: BeforeToolCallHook<TContext> | undefined,
	params: { agent: Agent<TContext, any>; toolCall: ToolCall; context: TContext },
): Promise<ToolCallDecision | undefined> {
	if (!hook) return undefined;

	// Function form (backward compat)
	if (typeof hook === "function") {
		return extractToolCallDecision(await hook(params));
	}

	// Matched array form
	for (const entry of hook as MatchedToolCallHook<TContext>[]) {
		if (matchesAny(entry.match, params.toolCall.function.name)) {
			const decision = extractToolCallDecision(await entry.hook(params));
			if (decision?.decision === "deny") return decision;
			if (decision?.decision === "modify") return decision;
		}
	}

	return undefined;
}

async function resolveAfterToolCallHook<TContext>(
	hook: AfterToolCallHook<TContext> | undefined,
	params: {
		agent: Agent<TContext, any>;
		toolCall: ToolCall;
		result: string;
		context: TContext;
	},
): Promise<void> {
	if (!hook) return;

	// Function form (backward compat)
	if (typeof hook === "function") {
		await hook(params);
		return;
	}

	// Matched array form
	for (const entry of hook as MatchedAfterToolCallHook<TContext>[]) {
		if (matchesAny(entry.match, params.toolCall.function.name)) {
			await entry.hook(params);
		}
	}
}

/** Check if a tool/handoff isEnabled field resolves to true */
async function checkEnabled<TContext>(
	isEnabled: boolean | ((context: TContext) => boolean | Promise<boolean>) | undefined,
	context: TContext,
): Promise<boolean> {
	if (isEnabled === undefined) return true;
	if (typeof isEnabled === "boolean") return isEnabled;
	return isEnabled(context);
}

/** Execute a tool with optional timeout */
async function executeWithTimeout<T>(
	fn: () => Promise<T> | T,
	timeout: number | undefined,
	toolName: string,
): Promise<T> {
	if (!timeout) return fn();

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new ToolTimeoutError(toolName, timeout));
		}, timeout);

		Promise.resolve(fn())
			.then((result) => {
				clearTimeout(timer);
				resolve(result);
			})
			.catch((error) => {
				clearTimeout(timer);
				reject(error);
			});
	});
}

export type ToolErrorFormatter = (toolName: string, error: unknown) => string;

export type CallModelInputFilter<TContext> = (params: {
	agent: Agent<TContext, any>;
	request: ModelRequest;
	context: TContext;
}) => ModelRequest;

export type MaxTurnsErrorHandler<TContext, TOutput> = (params: {
	agent: Agent<TContext, any>;
	messages: ChatMessage[];
	context: TContext;
	maxTurns: number;
}) => RunResult<TOutput> | Promise<RunResult<TOutput>>;

export interface RunOptions<TContext, TOutput = undefined> {
	context?: TContext;
	model?: Model;
	maxTurns?: number;
	signal?: AbortSignal;
	costEstimator?: CostEstimator;
	maxBudgetUsd?: number;
	/** Run-level hooks that fire across all agents */
	runHooks?: RunHooks<TContext>;
	/** Custom formatter for tool error messages sent to the LLM */
	toolErrorFormatter?: ToolErrorFormatter;
	/** Transform model requests before they're sent to the API */
	callModelInputFilter?: CallModelInputFilter<TContext>;
	/** Handle max_turns gracefully instead of throwing */
	errorHandlers?: {
		maxTurns?: MaxTurnsErrorHandler<TContext, TOutput>;
	};
	/** Tool guardrails that run before tool execution */
	toolInputGuardrails?: ToolInputGuardrail<TContext>[];
	/** Tool guardrails that run after tool execution */
	toolOutputGuardrails?: ToolOutputGuardrail<TContext>[];
	/** Reset tool_choice to "auto" after the first LLM call to prevent infinite loops */
	resetToolChoice?: boolean;
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new RunAbortedError();
	}
}

function validateBudgetOptions(options?: RunOptions<any, any>): void {
	if (options?.maxBudgetUsd !== undefined && !options.costEstimator) {
		throw new StratusError("maxBudgetUsd requires a costEstimator to be provided");
	}
}

function applyTurnCost(
	ctx: RunContext<any>,
	usage: UsageInfo | undefined,
	costEstimator?: CostEstimator,
): void {
	if (costEstimator && usage) {
		ctx.totalCostUsd += costEstimator(usage);
	}
}

function checkBudget(ctx: RunContext<any>, maxBudgetUsd: number | undefined): void {
	if (maxBudgetUsd !== undefined && ctx.totalCostUsd > maxBudgetUsd) {
		throw new MaxBudgetExceededError(maxBudgetUsd, ctx.totalCostUsd);
	}
}

function formatToolError(
	toolName: string,
	error: unknown,
	formatter?: ToolErrorFormatter,
): string {
	if (formatter) return formatter(toolName, error);
	return `Error executing tool "${toolName}": ${getErrorMessage(error)}`;
}

export async function run<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: RunOptions<TContext, TOutput>,
): Promise<RunResult<TOutput>> {
	validateBudgetOptions(options);

	const model = options?.model ?? agent.model;
	if (!model) {
		throw new StratusError("No model provided. Pass a model to the agent or to run().");
	}

	const signal = options?.signal;
	checkAborted(signal);

	const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
	const costEstimator = options?.costEstimator;
	const maxBudgetUsd = options?.maxBudgetUsd;
	const ctx = new RunContext(options?.context as TContext);
	const trace = getCurrentTrace();
	const runHooks = options?.runHooks;
	const toolErrorFmt = options?.toolErrorFormatter;
	const callModelInputFilter = options?.callModelInputFilter;
	const toolInputGuardrails = options?.toolInputGuardrails ?? [];
	const toolOutputGuardrails = options?.toolOutputGuardrails ?? [];

	// Fire beforeRun hook on the entry agent
	const inputText = typeof input === "string" ? input : extractUserText(input);
	if (agent.hooks.beforeRun) {
		await agent.hooks.beforeRun({ agent, input: inputText, context: ctx.context });
	}

	// Run input guardrails on the starting agent
	let inputGuardrailResults: GuardrailRunResult[] = [];
	if (agent.inputGuardrails.length > 0) {
		if (trace) {
			const span = trace.startSpan("input_guardrails", "guardrail");
			try {
				inputGuardrailResults = await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
			} finally {
				trace.endSpan(span);
			}
		} else {
			inputGuardrailResults = await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
		}
	}

	const messages: ChatMessage[] = [];

	let currentAgent: Agent<TContext, any> = agent;

	const systemPrompt = await currentAgent.getSystemPrompt(ctx.context);
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}

	if (typeof input === "string") {
		messages.push({ role: "user", content: input });
	} else {
		messages.push(...input);
	}

	let lastFinishReason: FinishReason | undefined;
	let lastResponseId: string | undefined;

	// Fire run-level onAgentStart
	if (runHooks?.onAgentStart) {
		await runHooks.onAgentStart({ agent: currentAgent, context: ctx.context });
	}

	for (let turn = 0; turn < maxTurns; turn++) {
		checkAborted(signal);

		const toolDefs = await buildToolDefs(currentAgent, ctx.context);
		let request: ModelRequest = {
			messages,
			tools: toolDefs.length > 0 ? toolDefs : undefined,
			modelSettings: currentAgent.modelSettings
				? applyResetToolChoice(currentAgent.modelSettings, turn, options?.resetToolChoice)
				: undefined,
			responseFormat: currentAgent.getResponseFormat(),
			previousResponseId: lastResponseId,
		};

		// Apply callModelInputFilter
		if (callModelInputFilter) {
			request = callModelInputFilter({ agent: currentAgent, request, context: ctx.context });
		}

		// Fire onLlmStart hooks
		if (currentAgent.hooks.onLlmStart) {
			await currentAgent.hooks.onLlmStart({ agent: currentAgent, messages, context: ctx.context });
		}
		if (runHooks?.onLlmStart) {
			await runHooks.onLlmStart({ agent: currentAgent, request, context: ctx.context });
		}

		let response: ModelResponse;
		if (trace) {
			const span = trace.startSpan(`model_call:${currentAgent.name}`, "model_call", {
				agent: currentAgent.name,
				turn,
			});
			try {
				response = await model.getResponse(request, { signal });
				trace.endSpan(span, {
					usage: response.usage,
					toolCallCount: response.toolCalls.length,
				});
			} catch (error) {
				trace.endSpan(span, { error: getErrorMessage(error) });
				throw error;
			}
		} else {
			response = await model.getResponse(request, { signal });
		}

		// Fire onLlmEnd hooks
		const llmEndInfo = { content: response.content, toolCallCount: response.toolCalls.length };
		if (currentAgent.hooks.onLlmEnd) {
			await currentAgent.hooks.onLlmEnd({ agent: currentAgent, response: llmEndInfo, context: ctx.context });
		}
		if (runHooks?.onLlmEnd) {
			await runHooks.onLlmEnd({ agent: currentAgent, response: llmEndInfo, context: ctx.context });
		}

		checkAborted(signal);
		lastFinishReason = response.finishReason;
		if (response.responseId) lastResponseId = response.responseId;
		ctx.addUsage(response.usage);
		ctx.numTurns++;

		applyTurnCost(ctx, response.usage, costEstimator);

		// Check budget after each model call
		try {
			checkBudget(ctx, maxBudgetUsd);
		} catch (error) {
			if (error instanceof MaxBudgetExceededError && currentAgent.hooks.onStop) {
				await currentAgent.hooks.onStop({
					agent: currentAgent,
					context: ctx.context,
					reason: "max_budget",
				});
			}
			throw error;
		}

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: response.content,
			...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
		};
		messages.push(assistantMsg);

		if (response.toolCalls.length === 0) {
			// Fire run-level onAgentEnd
			if (runHooks?.onAgentEnd) {
				await runHooks.onAgentEnd({ agent: currentAgent, output: response.content ?? "", context: ctx.context });
			}
			return buildFinalResult(
				agent, currentAgent, messages, ctx, trace,
				lastFinishReason, lastResponseId,
				inputGuardrailResults,
			);
		}

		const { toolMessages, handoffAgent } = await executeToolCallsWithHandoffs(
			currentAgent,
			ctx,
			response.toolCalls,
			trace,
			signal,
			toolErrorFmt,
			runHooks,
			toolInputGuardrails,
			toolOutputGuardrails,
		);
		messages.push(...toolMessages);

		// Check toolUseBehavior — should we stop instead of calling the LLM again?
		if (await shouldStopAfterToolCalls(currentAgent, response.toolCalls, toolMessages)) {
			const toolOutput = toolMessages.map((m) => m.content).join("\n");
			return new RunResult<TOutput>({
				output: toolOutput,
				messages,
				usage: ctx.usage,
				lastAgent: currentAgent,
				finishReason: lastFinishReason,
				numTurns: ctx.numTurns,
				totalCostUsd: ctx.totalCostUsd,
				responseId: lastResponseId,
				inputGuardrailResults,
			});
		}

		if (handoffAgent) {
			let allowHandoff = true;

			// Fire beforeHandoff hook on current agent
			if (currentAgent.hooks.beforeHandoff) {
				const raw = await currentAgent.hooks.beforeHandoff({
					fromAgent: currentAgent,
					toAgent: handoffAgent,
					context: ctx.context,
				});
				const decision = extractHandoffDecision(raw);

				if (decision?.decision === "deny") {
					allowHandoff = false;
					// Replace the last tool message for the handoff with the denial reason
					const lastToolMsg = messages[messages.length - 1];
					if (lastToolMsg && lastToolMsg.role === "tool") {
						messages[messages.length - 1] = {
							...lastToolMsg,
							content:
								decision.reason ??
								`Handoff to ${handoffAgent.name} was denied`,
						};
					}
				}
			}

			if (allowHandoff) {
				// Fire run-level onAgentEnd for current agent
				if (runHooks?.onAgentEnd) {
					await runHooks.onAgentEnd({ agent: currentAgent, output: response.content ?? "", context: ctx.context });
				}

				// Fire run-level onHandoff
				if (runHooks?.onHandoff) {
					await runHooks.onHandoff({ fromAgent: currentAgent, toAgent: handoffAgent, context: ctx.context });
				}

				if (trace) {
					const span = trace.startSpan(
						`handoff:${currentAgent.name}->${handoffAgent.name}`,
						"handoff",
						{ fromAgent: currentAgent.name, toAgent: handoffAgent.name },
					);
					trace.endSpan(span);
				}

				// Apply handoff inputFilter if present
				const matchedHandoff = currentAgent.handoffs.find(
					(h) => h.agent === handoffAgent || h.agent.name === handoffAgent.name,
				);
				if (matchedHandoff?.inputFilter) {
					const filtered = matchedHandoff.inputFilter({ history: [...messages] });
					messages.length = 0;
					messages.push(...filtered);
				}

				currentAgent = handoffAgent;

				// Replace system message with new agent's prompt
				const newSystemPrompt = await currentAgent.getSystemPrompt(ctx.context);
				const systemIdx = messages.findIndex((m) => m.role === "system");
				if (newSystemPrompt) {
					if (systemIdx >= 0) {
						messages[systemIdx] = { role: "system", content: newSystemPrompt };
					} else {
						messages.unshift({ role: "system", content: newSystemPrompt });
					}
				} else if (systemIdx >= 0) {
					messages.splice(systemIdx, 1);
				}

				// Fire run-level onAgentStart for new agent
				if (runHooks?.onAgentStart) {
					await runHooks.onAgentStart({ agent: currentAgent, context: ctx.context });
				}
			}
		}
	}

	// Fire onStop before throwing MaxTurnsExceededError
	if (currentAgent.hooks.onStop) {
		await currentAgent.hooks.onStop({
			agent: currentAgent,
			context: ctx.context,
			reason: "max_turns",
		});
	}

	// Check for error handler
	if (options?.errorHandlers?.maxTurns) {
		return options.errorHandlers.maxTurns({
			agent: currentAgent,
			messages,
			context: ctx.context,
			maxTurns,
		});
	}

	throw new MaxTurnsExceededError(maxTurns);
}

export interface StreamOptions<TContext, TOutput = undefined> extends RunOptions<TContext, TOutput> {}

export interface StreamedRunResult<TOutput = undefined> {
	stream: AsyncGenerator<StreamEvent>;
	result: Promise<RunResult<TOutput>>;
}

export function stream<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: StreamOptions<TContext, TOutput>,
): StreamedRunResult<TOutput> {
	let resolveResult: (result: RunResult<TOutput>) => void;
	let rejectResult: (error: unknown) => void;
	const resultPromise = new Promise<RunResult<TOutput>>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	const gen = streamInternal(agent, input, options, resolveResult!, rejectResult!);

	return { stream: gen, result: resultPromise };
}

async function* streamInternal<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options: StreamOptions<TContext, TOutput> | undefined,
	resolveResult: (result: RunResult<TOutput>) => void,
	rejectResult: (error: unknown) => void,
): AsyncGenerator<StreamEvent> {
	try {
		validateBudgetOptions(options);

		const model = options?.model ?? agent.model;
		if (!model) {
			throw new StratusError("No model provided. Pass a model to the agent or to run().");
		}

		const signal = options?.signal;
		checkAborted(signal);

		const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
		const costEstimator = options?.costEstimator;
		const maxBudgetUsd = options?.maxBudgetUsd;
		const ctx = new RunContext(options?.context as TContext);
		const trace = getCurrentTrace();
		const runHooks = options?.runHooks;
		const toolErrorFmt = options?.toolErrorFormatter;
		const callModelInputFilter = options?.callModelInputFilter;
		const toolInputGuardrails = options?.toolInputGuardrails ?? [];
		const toolOutputGuardrails = options?.toolOutputGuardrails ?? [];

		// Fire beforeRun hook on the entry agent
		const inputText = typeof input === "string" ? input : extractUserText(input);
		if (agent.hooks.beforeRun) {
			await agent.hooks.beforeRun({ agent, input: inputText, context: ctx.context });
		}

		// Run input guardrails on the starting agent
		let inputGuardrailResults: GuardrailRunResult[] = [];
		if (agent.inputGuardrails.length > 0) {
			if (trace) {
				const span = trace.startSpan("input_guardrails", "guardrail");
				try {
					inputGuardrailResults = await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
				} finally {
					trace.endSpan(span);
				}
			} else {
				inputGuardrailResults = await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
			}
		}

		const messages: ChatMessage[] = [];

		let currentAgent: Agent<TContext, any> = agent;

		const systemPrompt = await currentAgent.getSystemPrompt(ctx.context);
		if (systemPrompt) {
			messages.push({ role: "system", content: systemPrompt });
		}

		if (typeof input === "string") {
			messages.push({ role: "user", content: input });
		} else {
			messages.push(...input);
		}

		let lastFinishReason: FinishReason | undefined;
		let lastResponseId: string | undefined;

		// Fire run-level onAgentStart
		if (runHooks?.onAgentStart) {
			await runHooks.onAgentStart({ agent: currentAgent, context: ctx.context });
		}

		for (let turn = 0; turn < maxTurns; turn++) {
			checkAborted(signal);

			const toolDefs = await buildToolDefs(currentAgent, ctx.context);
			let request: ModelRequest = {
				messages,
				tools: toolDefs.length > 0 ? toolDefs : undefined,
				modelSettings: currentAgent.modelSettings
					? applyResetToolChoice(currentAgent.modelSettings, turn, options?.resetToolChoice)
					: undefined,
				responseFormat: currentAgent.getResponseFormat(),
				previousResponseId: lastResponseId,
			};

			// Apply callModelInputFilter
			if (callModelInputFilter) {
				request = callModelInputFilter({ agent: currentAgent, request, context: ctx.context });
			}

			// Fire onLlmStart hooks
			if (currentAgent.hooks.onLlmStart) {
				await currentAgent.hooks.onLlmStart({ agent: currentAgent, messages, context: ctx.context });
			}
			if (runHooks?.onLlmStart) {
				await runHooks.onLlmStart({ agent: currentAgent, request, context: ctx.context });
			}

			let finalResponse: ModelResponse | undefined;
			let gotDone = false;

			for await (const event of model.getStreamedResponse(request, { signal })) {
				yield event;
				if (event.type === "done") {
					finalResponse = event.response;
					gotDone = true;
				}
			}

			if (!gotDone) {
				throw new StratusError("Stream ended without a done event");
			}

			// Fire onLlmEnd hooks
			const llmEndInfo = { content: finalResponse!.content, toolCallCount: finalResponse!.toolCalls.length };
			if (currentAgent.hooks.onLlmEnd) {
				await currentAgent.hooks.onLlmEnd({ agent: currentAgent, response: llmEndInfo, context: ctx.context });
			}
			if (runHooks?.onLlmEnd) {
				await runHooks.onLlmEnd({ agent: currentAgent, response: llmEndInfo, context: ctx.context });
			}

			checkAborted(signal);
			lastFinishReason = finalResponse!.finishReason;
			if (finalResponse!.responseId) lastResponseId = finalResponse!.responseId;
			ctx.addUsage(finalResponse!.usage);
			ctx.numTurns++;

			applyTurnCost(ctx, finalResponse!.usage, costEstimator);

			// Check budget after each model call
			try {
				checkBudget(ctx, maxBudgetUsd);
			} catch (error) {
				if (error instanceof MaxBudgetExceededError && currentAgent.hooks.onStop) {
					await currentAgent.hooks.onStop({
						agent: currentAgent,
						context: ctx.context,
						reason: "max_budget",
					});
				}
				throw error;
			}

			const assistantMsg: AssistantMessage = {
				role: "assistant",
				content: finalResponse!.content,
				...(finalResponse!.toolCalls.length > 0
					? { tool_calls: finalResponse!.toolCalls }
					: {}),
			};
			messages.push(assistantMsg);

			if (finalResponse!.toolCalls.length === 0) {
				if (runHooks?.onAgentEnd) {
					await runHooks.onAgentEnd({ agent: currentAgent, output: finalResponse!.content ?? "", context: ctx.context });
				}
				const result = await buildFinalResult(
					agent, currentAgent, messages, ctx, trace,
					lastFinishReason, lastResponseId,
					inputGuardrailResults,
				);
				resolveResult(result);
				return;
			}

			const { toolMessages, handoffAgent } = await executeToolCallsWithHandoffs(
				currentAgent,
				ctx,
				finalResponse!.toolCalls,
				trace,
				signal,
				toolErrorFmt,
				runHooks,
				toolInputGuardrails,
				toolOutputGuardrails,
			);
			messages.push(...toolMessages);

			// Check toolUseBehavior
			if (await shouldStopAfterToolCalls(currentAgent, finalResponse!.toolCalls, toolMessages)) {
				const toolOutput = toolMessages.map((m) => m.content).join("\n");
				resolveResult(
					new RunResult<TOutput>({
						output: toolOutput,
						messages,
						usage: ctx.usage,
						lastAgent: currentAgent,
						finishReason: lastFinishReason,
						numTurns: ctx.numTurns,
						totalCostUsd: ctx.totalCostUsd,
						responseId: lastResponseId,
						inputGuardrailResults,
					}),
				);
				return;
			}

			if (handoffAgent) {
				let allowHandoff = true;

				if (currentAgent.hooks.beforeHandoff) {
					const raw = await currentAgent.hooks.beforeHandoff({
						fromAgent: currentAgent,
						toAgent: handoffAgent,
						context: ctx.context,
					});
					const decision = extractHandoffDecision(raw);

					if (decision?.decision === "deny") {
						allowHandoff = false;
						const lastToolMsg = messages[messages.length - 1];
						if (lastToolMsg && lastToolMsg.role === "tool") {
							messages[messages.length - 1] = {
								...lastToolMsg,
								content:
									decision.reason ??
									`Handoff to ${handoffAgent.name} was denied`,
							};
						}
					}
				}

				if (allowHandoff) {
					if (runHooks?.onAgentEnd) {
						await runHooks.onAgentEnd({ agent: currentAgent, output: finalResponse!.content ?? "", context: ctx.context });
					}
					if (runHooks?.onHandoff) {
						await runHooks.onHandoff({ fromAgent: currentAgent, toAgent: handoffAgent, context: ctx.context });
					}

					// Apply handoff inputFilter if present
					const matchedHandoff = currentAgent.handoffs.find(
						(h) => h.agent === handoffAgent || h.agent.name === handoffAgent.name,
					);
					if (matchedHandoff?.inputFilter) {
						const filtered = matchedHandoff.inputFilter({ history: [...messages] });
						messages.length = 0;
						messages.push(...filtered);
					}

					currentAgent = handoffAgent;

					const newSystemPrompt = await currentAgent.getSystemPrompt(ctx.context);
					const systemIdx = messages.findIndex((m) => m.role === "system");
					if (newSystemPrompt) {
						if (systemIdx >= 0) {
							messages[systemIdx] = { role: "system", content: newSystemPrompt };
						} else {
							messages.unshift({ role: "system", content: newSystemPrompt });
						}
					} else if (systemIdx >= 0) {
						messages.splice(systemIdx, 1);
					}

					if (runHooks?.onAgentStart) {
						await runHooks.onAgentStart({ agent: currentAgent, context: ctx.context });
					}
				}
			}
		}

		// Fire onStop before throwing MaxTurnsExceededError
		if (currentAgent.hooks.onStop) {
			await currentAgent.hooks.onStop({
				agent: currentAgent,
				context: ctx.context,
				reason: "max_turns",
			});
		}

		// Check for error handler
		if (options?.errorHandlers?.maxTurns) {
			resolveResult(
				await options.errorHandlers.maxTurns({
					agent: currentAgent,
					messages,
					context: ctx.context,
					maxTurns,
				}),
			);
			return;
		}

		throw new MaxTurnsExceededError(maxTurns);
	} catch (error) {
		rejectResult(error);
		throw error;
	}
}

async function buildFinalResult<TContext, TOutput>(
	entryAgent: Agent<TContext, TOutput>,
	currentAgent: Agent<TContext, any>,
	messages: ChatMessage[],
	ctx: RunContext<TContext>,
	trace: ReturnType<typeof getCurrentTrace>,
	finishReason?: FinishReason,
	responseId?: string,
	inputGuardrailResults?: GuardrailRunResult[],
): Promise<RunResult<TOutput>> {
	const lastMessage = messages[messages.length - 1];
	const rawOutput =
		lastMessage && lastMessage.role === "assistant" ? (lastMessage.content ?? "") : "";

	// Run output guardrails on the current (possibly handed-off) agent
	let outputGuardrailResults: GuardrailRunResult[] = [];
	if (currentAgent.outputGuardrails.length > 0) {
		if (trace) {
			const span = trace.startSpan("output_guardrails", "guardrail");
			try {
				outputGuardrailResults = await runOutputGuardrails(
					currentAgent.outputGuardrails,
					rawOutput,
					ctx.context,
				);
			} finally {
				trace.endSpan(span);
			}
		} else {
			outputGuardrailResults = await runOutputGuardrails(currentAgent.outputGuardrails, rawOutput, ctx.context);
		}
	}

	// Parse structured output if outputType is set
	let finalOutput: TOutput | undefined;
	if (entryAgent.outputType && rawOutput) {
		try {
			const parsed = JSON.parse(rawOutput);
			finalOutput = entryAgent.outputType.parse(parsed);
		} catch (error) {
			throw new OutputParseError(
				`Failed to parse structured output: ${getErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	const result = new RunResult<TOutput>({
		output: rawOutput,
		messages,
		usage: ctx.usage,
		lastAgent: currentAgent,
		finalOutput,
		finishReason,
		numTurns: ctx.numTurns,
		totalCostUsd: ctx.totalCostUsd,
		responseId,
		inputGuardrailResults,
		outputGuardrailResults,
	});

	// Fire afterRun hook on the entry agent
	if (entryAgent.hooks.afterRun) {
		await entryAgent.hooks.afterRun({ agent: entryAgent, result, context: ctx.context });
	}

	return result;
}

async function buildToolDefs(
	agent: Agent<any, any>,
	context: any,
): Promise<(ToolDefinition | HostedToolDefinition)[]> {
	const defs: (ToolDefinition | HostedToolDefinition)[] = [];

	for (const t of agent.tools) {
		if (isHostedTool(t)) {
			defs.push(t.definition);
		} else {
			// Check isEnabled for function tools
			if (!(await checkEnabled(t.isEnabled, context))) continue;
			defs.push(toolToDefinition(t));
		}
	}
	for (const sa of agent.subagents) {
		defs.push(subagentToDefinition(sa));
	}
	for (const h of agent.handoffs) {
		// Check isEnabled for handoffs
		if (!(await checkEnabled(h.isEnabled, context))) continue;
		defs.push(handoffToDefinition(h));
	}
	return defs;
}

function extractUserText(messages: ChatMessage[]): string {
	const texts: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") {
			texts.push(msg.content);
		} else {
			for (const part of msg.content) {
				if (part.type === "text") {
					texts.push(part.text);
				}
			}
		}
	}
	return texts.join("\n");
}

async function shouldStopAfterToolCalls(
	agent: Agent<any, any>,
	toolCalls: { function: { name: string } }[],
	toolMessages: ToolMessage[],
): Promise<boolean> {
	const behavior = agent.toolUseBehavior;
	if (behavior === "run_llm_again") return false;
	if (behavior === "stop_on_first_tool") return true;
	if (typeof behavior === "function") {
		// Custom function variant
		const results = toolCalls.map((tc, i) => ({
			toolName: tc.function.name,
			result: toolMessages[i]?.content ?? "",
		}));
		return behavior(results);
	}
	if (typeof behavior === "object" && "stopAtToolNames" in behavior) {
		const stopNames = new Set(behavior.stopAtToolNames);
		return toolCalls.some((tc) => stopNames.has(tc.function.name));
	}
	return false;
}

function applyResetToolChoice(
	settings: import("./types").ModelSettings,
	turn: number,
	resetToolChoice?: boolean,
): import("./types").ModelSettings {
	if (!resetToolChoice || turn === 0) return settings;
	// After the first turn, reset tool_choice to "auto" to prevent infinite loops
	if (settings.toolChoice && settings.toolChoice !== "auto") {
		return { ...settings, toolChoice: "auto" };
	}
	return settings;
}

async function executeToolCallsWithHandoffs<TContext>(
	agent: Agent<TContext, any>,
	ctx: RunContext<TContext>,
	toolCalls: { id: string; function: { name: string; arguments: string } }[],
	trace: ReturnType<typeof getCurrentTrace>,
	signal?: AbortSignal,
	toolErrorFmt?: ToolErrorFormatter,
	runHooks?: RunHooks<TContext>,
	toolInputGuardrails?: ToolInputGuardrail<TContext>[],
	toolOutputGuardrails?: ToolOutputGuardrail<TContext>[],
): Promise<{ toolMessages: ToolMessage[]; handoffAgent?: Agent<TContext, any> }> {
	let handoffAgent: Agent<TContext, any> | undefined;

	// Build O(1) lookup maps
	const handoffsByName = new Map(agent.handoffs.map((h) => [h.toolName, h]));
	const subagentsByName = new Map(agent.subagents.map((sa) => [sa.toolName, sa]));
	const functionTools = agent.tools.filter(isFunctionTool);
	const toolsByName = new Map(functionTools.map((t) => [t.name, t]));

	const results = await Promise.all(
		toolCalls.map(async (tc) => {
			const tcName = tc.function.name;

			// Check handoffs first
			const matchedHandoff = handoffsByName.get(tcName);
			if (matchedHandoff) {
				if (matchedHandoff.onHandoff) {
					await matchedHandoff.onHandoff(ctx.context);
				}
				handoffAgent = matchedHandoff.agent as Agent<TContext, any>;
				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: `Transferred to ${matchedHandoff.agent.name}`,
				};
			}

			// Check subagents
			const matchedSubagent = subagentsByName.get(tcName);
			if (matchedSubagent) {
				const saTool = subagentToTool(matchedSubagent);
				try {
					const params = JSON.parse(tc.function.arguments);
					const fullToolCall: ToolCall = { id: tc.id, type: "function", function: tc.function };

					const decision = await resolveBeforeToolCallHook(agent.hooks.beforeToolCall, {
						agent,
						toolCall: fullToolCall,
						context: ctx.context,
					});

					if (decision?.decision === "deny") {
						return {
							role: "tool" as const,
							tool_call_id: tc.id,
							content: decision.reason ?? `Tool call "${tcName}" was denied`,
						};
					}

					// Fire onSubagentStart
					if (agent.hooks.onSubagentStart) {
						await agent.hooks.onSubagentStart({
							agent,
							subagent: matchedSubagent as SubAgent,
							context: ctx.context,
						});
					}

					// Fire run-level onToolStart
					if (runHooks?.onToolStart) {
						await runHooks.onToolStart({ agent, toolName: tcName, context: ctx.context });
					}

					let result: string;
					if (trace) {
						const span = trace.startSpan(
							`subagent:${matchedSubagent.agent.name}`,
							"subagent",
							{ toolName: tcName },
						);
						try {
							result = await saTool.execute(ctx.context, params, { signal });
						} finally {
							trace.endSpan(span);
						}
					} else {
						result = await saTool.execute(ctx.context, params, { signal });
					}

					// Fire onSubagentStop
					if (agent.hooks.onSubagentStop) {
						await agent.hooks.onSubagentStop({
							agent,
							subagent: matchedSubagent as SubAgent,
							result,
							context: ctx.context,
						});
					}

					// Fire run-level onToolEnd
					if (runHooks?.onToolEnd) {
						await runHooks.onToolEnd({ agent, toolName: tcName, result, context: ctx.context });
					}

					await resolveAfterToolCallHook(agent.hooks.afterToolCall, {
						agent,
						toolCall: fullToolCall,
						result,
						context: ctx.context,
					});

					return {
						role: "tool" as const,
						tool_call_id: tc.id,
						content: result,
					};
				} catch (error) {
					return {
						role: "tool" as const,
						tool_call_id: tc.id,
						content: formatToolError(matchedSubagent.agent.name, error, toolErrorFmt),
					};
				}
			}

			// Otherwise, execute as normal tool
			const tool = toolsByName.get(tcName);
			if (!tool) {
				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: `Error: Unknown tool "${tcName}"`,
				};
			}

			try {
				let params = JSON.parse(tc.function.arguments);
				const fullToolCall: ToolCall = { id: tc.id, type: "function", function: tc.function };

				// Fire beforeToolCall hook
				const decision = await resolveBeforeToolCallHook(agent.hooks.beforeToolCall, {
					agent,
					toolCall: fullToolCall,
					context: ctx.context,
				});

				if (decision?.decision === "deny") {
					return {
						role: "tool" as const,
						tool_call_id: tc.id,
						content: decision.reason ?? `Tool call "${tcName}" was denied`,
					};
				}
				if (decision?.decision === "modify") {
					params = decision.modifiedParams;
				}

				// Run tool input guardrails
				if (toolInputGuardrails && toolInputGuardrails.length > 0) {
					const guardrailResults = await runToolInputGuardrails(
						toolInputGuardrails,
						tcName,
						params,
						ctx.context,
					);
					const tripped = guardrailResults.find((r) => r.result.tripwireTriggered);
					if (tripped) {
						return {
							role: "tool" as const,
							tool_call_id: tc.id,
							content: `Tool input guardrail "${tripped.guardrailName}" blocked execution of "${tcName}"`,
						};
					}
				}

				// Fire run-level onToolStart
				if (runHooks?.onToolStart) {
					await runHooks.onToolStart({ agent, toolName: tcName, context: ctx.context });
				}

				checkAborted(signal);
				let result: string;
				if (trace) {
					const span = trace.startSpan(`tool:${tcName}`, "tool_execution", {
						toolName: tcName,
					});
					try {
						result = await executeWithTimeout(
							() => tool.execute(ctx.context, params, { signal }),
							tool.timeout,
							tcName,
						);
					} finally {
						trace.endSpan(span);
					}
				} else {
					result = await executeWithTimeout(
						() => tool.execute(ctx.context, params, { signal }),
						tool.timeout,
						tcName,
					);
				}

				// Run tool output guardrails
				if (toolOutputGuardrails && toolOutputGuardrails.length > 0) {
					const guardrailResults = await runToolOutputGuardrails(
						toolOutputGuardrails,
						tcName,
						result,
						ctx.context,
					);
					const tripped = guardrailResults.find((r) => r.result.tripwireTriggered);
					if (tripped) {
						result = `Tool output guardrail "${tripped.guardrailName}" flagged the output of "${tcName}"`;
					}
				}

				// Fire run-level onToolEnd
				if (runHooks?.onToolEnd) {
					await runHooks.onToolEnd({ agent, toolName: tcName, result, context: ctx.context });
				}

				// Fire afterToolCall hook
				await resolveAfterToolCallHook(agent.hooks.afterToolCall, {
					agent,
					toolCall: fullToolCall,
					result,
					context: ctx.context,
				});

				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: result,
				};
			} catch (error) {
				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: formatToolError(tcName, error, toolErrorFmt),
				};
			}
		}),
	);

	return { toolMessages: results, handoffAgent };
}
