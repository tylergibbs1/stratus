import type { Agent } from "./agent";
import { RunContext } from "./context";
import type { CostEstimator } from "./cost";
import {
	MaxBudgetExceededError,
	MaxTurnsExceededError,
	OutputParseError,
	RunAbortedError,
	StratusError,
} from "./errors";
import { runInputGuardrails, runOutputGuardrails } from "./guardrails";
import type {
	AfterToolCallHook,
	BeforeToolCallHook,
	HandoffDecision,
	MatchedAfterToolCallHook,
	MatchedToolCallHook,
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
import type { FunctionTool } from "./tool";
import { getCurrentTrace } from "./tracing";
import type { AssistantMessage, ChatMessage, ToolCall, ToolDefinition, ToolMessage } from "./types";

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

export interface RunOptions<TContext> {
	context?: TContext;
	model?: Model;
	maxTurns?: number;
	signal?: AbortSignal;
	costEstimator?: CostEstimator;
	maxBudgetUsd?: number;
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new RunAbortedError();
	}
}

function validateBudgetOptions(options?: RunOptions<any>): void {
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

export async function run<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: RunOptions<TContext>,
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

	// Fire beforeRun hook on the entry agent
	const inputText = typeof input === "string" ? input : extractUserText(input);
	if (agent.hooks.beforeRun) {
		await agent.hooks.beforeRun({ agent, input: inputText, context: ctx.context });
	}

	// Run input guardrails on the starting agent
	if (agent.inputGuardrails.length > 0) {
		if (trace) {
			const span = trace.startSpan("input_guardrails", "guardrail");
			try {
				await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
			} finally {
				trace.endSpan(span);
			}
		} else {
			await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
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

	for (let turn = 0; turn < maxTurns; turn++) {
		checkAborted(signal);

		const toolDefs = buildToolDefs(currentAgent);
		const request: ModelRequest = {
			messages,
			tools: toolDefs.length > 0 ? toolDefs : undefined,
			modelSettings: currentAgent.modelSettings,
			responseFormat: currentAgent.getResponseFormat(),
			previousResponseId: lastResponseId,
		};

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
			return buildFinalResult(agent, currentAgent, messages, ctx, trace, lastFinishReason, lastResponseId);
		}

		const { toolMessages, handoffAgent } = await executeToolCallsWithHandoffs(
			currentAgent,
			ctx,
			response.toolCalls,
			trace,
			signal,
		);
		messages.push(...toolMessages);

		// Check toolUseBehavior — should we stop instead of calling the LLM again?
		if (shouldStopAfterToolCalls(currentAgent, response.toolCalls)) {
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
				if (trace) {
					const span = trace.startSpan(
						`handoff:${currentAgent.name}->${handoffAgent.name}`,
						"handoff",
						{ fromAgent: currentAgent.name, toAgent: handoffAgent.name },
					);
					trace.endSpan(span);
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

	throw new MaxTurnsExceededError(maxTurns);
}

export interface StreamOptions<TContext> extends RunOptions<TContext> {}

export interface StreamedRunResult<TOutput = undefined> {
	stream: AsyncGenerator<StreamEvent>;
	result: Promise<RunResult<TOutput>>;
}

export function stream<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: StreamOptions<TContext>,
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
	options: StreamOptions<TContext> | undefined,
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

		// Fire beforeRun hook on the entry agent
		const inputText = typeof input === "string" ? input : extractUserText(input);
		if (agent.hooks.beforeRun) {
			await agent.hooks.beforeRun({ agent, input: inputText, context: ctx.context });
		}

		// Run input guardrails on the starting agent
		if (agent.inputGuardrails.length > 0) {
			if (trace) {
				const span = trace.startSpan("input_guardrails", "guardrail");
				try {
					await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
				} finally {
					trace.endSpan(span);
				}
			} else {
				await runInputGuardrails(agent.inputGuardrails, inputText, ctx.context);
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

		for (let turn = 0; turn < maxTurns; turn++) {
			checkAborted(signal);

			const toolDefs = buildToolDefs(currentAgent);
			const request: ModelRequest = {
				messages,
				tools: toolDefs.length > 0 ? toolDefs : undefined,
				modelSettings: currentAgent.modelSettings,
				responseFormat: currentAgent.getResponseFormat(),
				previousResponseId: lastResponseId,
			};

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
				const result = await buildFinalResult(
					agent,
					currentAgent,
					messages,
					ctx,
					trace,
					lastFinishReason,
					lastResponseId,
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
			);
			messages.push(...toolMessages);

			// Check toolUseBehavior
			if (shouldStopAfterToolCalls(currentAgent, finalResponse!.toolCalls)) {
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
): Promise<RunResult<TOutput>> {
	const lastMessage = messages[messages.length - 1];
	const rawOutput =
		lastMessage && lastMessage.role === "assistant" ? (lastMessage.content ?? "") : "";

	// Run output guardrails on the current (possibly handed-off) agent
	if (currentAgent.outputGuardrails.length > 0) {
		if (trace) {
			const span = trace.startSpan("output_guardrails", "guardrail");
			try {
				await runOutputGuardrails(
					currentAgent.outputGuardrails,
					rawOutput,
					ctx.context,
				);
			} finally {
				trace.endSpan(span);
			}
		} else {
			await runOutputGuardrails(currentAgent.outputGuardrails, rawOutput, ctx.context);
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
	});

	// Fire afterRun hook on the entry agent
	if (entryAgent.hooks.afterRun) {
		await entryAgent.hooks.afterRun({ agent: entryAgent, result, context: ctx.context });
	}

	return result;
}

function buildToolDefs(agent: Agent<any, any>): (ToolDefinition | Record<string, unknown>)[] {
	const defs: (ToolDefinition | Record<string, unknown>)[] = [];
	for (const t of agent.tools) {
		if (isHostedTool(t)) {
			defs.push(t.definition);
		} else {
			defs.push(toolToDefinition(t));
		}
	}
	for (const sa of agent.subagents) {
		defs.push(subagentToDefinition(sa));
	}
	for (const h of agent.handoffs) {
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

function shouldStopAfterToolCalls(
	agent: Agent<any, any>,
	toolCalls: { function: { name: string } }[],
): boolean {
	if (agent.toolUseBehavior === "run_llm_again") return false;
	if (agent.toolUseBehavior === "stop_on_first_tool") return true;
	if ("stopAtToolNames" in agent.toolUseBehavior) {
		const stopNames = new Set(
			(agent.toolUseBehavior as { stopAtToolNames: string[] }).stopAtToolNames,
		);
		return toolCalls.some((tc) => stopNames.has(tc.function.name));
	}
	return false;
}

async function executeToolCallsWithHandoffs<TContext>(
	agent: Agent<TContext, any>,
	ctx: RunContext<TContext>,
	toolCalls: { id: string; function: { name: string; arguments: string } }[],
	trace: ReturnType<typeof getCurrentTrace>,
	signal?: AbortSignal,
): Promise<{ toolMessages: ToolMessage[]; handoffAgent?: Agent<TContext, any> }> {
	let handoffAgent: Agent<TContext, any> | undefined;

	// Build O(1) lookup maps
	const handoffsByName = new Map(agent.handoffs.map((h) => [h.toolName, h]));
	const subagentsByName = new Map(agent.subagents.map((sa) => [sa.toolName, sa]));
	const functionTools = agent.tools.filter(isFunctionTool) as FunctionTool[];
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
						content: `Error executing sub-agent "${matchedSubagent.agent.name}": ${getErrorMessage(error)}`,
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

				checkAborted(signal);
				let result: string;
				if (trace) {
					const span = trace.startSpan(`tool:${tcName}`, "tool_execution", {
						toolName: tcName,
					});
					try {
						result = await tool.execute(ctx.context, params, { signal });
					} finally {
						trace.endSpan(span);
					}
				} else {
					result = await tool.execute(ctx.context, params, { signal });
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
					content: `Error executing tool "${tcName}": ${getErrorMessage(error)}`,
				};
			}
		}),
	);

	return { toolMessages: results, handoffAgent };
}
