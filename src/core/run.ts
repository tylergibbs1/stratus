import type { Agent } from "./agent";
import { RunContext } from "./context";
import { MaxTurnsExceededError, OutputParseError, RunAbortedError, StratusError } from "./errors";
import { runInputGuardrails, runOutputGuardrails } from "./guardrails";
import { handoffToDefinition } from "./handoff";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "./model";
import { subagentToDefinition, subagentToTool } from "./subagent";
import { RunResult } from "./result";
import { toolToDefinition } from "./tool";
import { getCurrentTrace } from "./tracing";
import type { AssistantMessage, ChatMessage, ToolDefinition, ToolMessage } from "./types";

const DEFAULT_MAX_TURNS = 10;

export interface RunOptions<TContext> {
	context?: TContext;
	model?: Model;
	maxTurns?: number;
	signal?: AbortSignal;
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new RunAbortedError();
	}
}

export async function run<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: RunOptions<TContext>,
): Promise<RunResult<TOutput>> {
	const model = options?.model ?? agent.model;
	if (!model) {
		throw new StratusError("No model provided. Pass a model to the agent or to run().");
	}

	const signal = options?.signal;
	checkAborted(signal);

	const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
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

	let lastFinishReason: string | undefined;

	for (let turn = 0; turn < maxTurns; turn++) {
		checkAborted(signal);

		const toolDefs = buildToolDefs(currentAgent);
		const request: ModelRequest = {
			messages,
			tools: toolDefs.length > 0 ? toolDefs : undefined,
			modelSettings: currentAgent.modelSettings,
			responseFormat: currentAgent.getResponseFormat(),
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
				trace.endSpan(span, { error: String(error) });
				throw error;
			}
		} else {
			response = await model.getResponse(request, { signal });
		}

		checkAborted(signal);
		lastFinishReason = response.finishReason;
		ctx.addUsage(response.usage);

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: response.content,
			...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
		};
		messages.push(assistantMsg);

		if (response.toolCalls.length === 0) {
			return buildFinalResult(agent, currentAgent, messages, ctx, trace, lastFinishReason);
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
			return new RunResult<TOutput>(
				toolOutput,
				messages,
				ctx.usage,
				currentAgent,
				undefined,
				lastFinishReason,
			);
		}

		if (handoffAgent) {
			let allowHandoff = true;

			// Fire beforeHandoff hook on current agent
			if (currentAgent.hooks.beforeHandoff) {
				const decision = await currentAgent.hooks.beforeHandoff({
					fromAgent: currentAgent,
					toAgent: handoffAgent,
					context: ctx.context,
				});

				if (decision && typeof decision === "object" && "decision" in decision) {
					if (decision.decision === "deny") {
						allowHandoff = false;
						// Replace the last tool message for the handoff with the denial reason
						const lastToolMsg = messages[messages.length - 1];
						if (lastToolMsg && lastToolMsg.role === "tool") {
							lastToolMsg.content =
								decision.reason ??
								`Handoff to ${handoffAgent.name} was denied`;
						}
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
		const model = options?.model ?? agent.model;
		if (!model) {
			throw new StratusError("No model provided. Pass a model to the agent or to run().");
		}

		const signal = options?.signal;
		checkAborted(signal);

		const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
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

		let lastFinishReason: string | undefined;

		for (let turn = 0; turn < maxTurns; turn++) {
			checkAborted(signal);

			const toolDefs = buildToolDefs(currentAgent);
			const request: ModelRequest = {
				messages,
				tools: toolDefs.length > 0 ? toolDefs : undefined,
				modelSettings: currentAgent.modelSettings,
				responseFormat: currentAgent.getResponseFormat(),
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
			ctx.addUsage(finalResponse!.usage);

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
					new RunResult<TOutput>(
						toolOutput,
						messages,
						ctx.usage,
						currentAgent,
						undefined,
						lastFinishReason,
					),
				);
				return;
			}

			if (handoffAgent) {
				let allowHandoff = true;

				if (currentAgent.hooks.beforeHandoff) {
					const decision = await currentAgent.hooks.beforeHandoff({
						fromAgent: currentAgent,
						toAgent: handoffAgent,
						context: ctx.context,
					});

					if (decision && typeof decision === "object" && "decision" in decision) {
						if (decision.decision === "deny") {
							allowHandoff = false;
							const lastToolMsg = messages[messages.length - 1];
							if (lastToolMsg && lastToolMsg.role === "tool") {
								lastToolMsg.content =
									decision.reason ??
									`Handoff to ${handoffAgent.name} was denied`;
							}
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
	finishReason?: string,
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
				`Failed to parse structured output: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	const result = new RunResult<TOutput>(
		rawOutput,
		messages,
		ctx.usage,
		currentAgent,
		finalOutput,
		finishReason,
	);

	// Fire afterRun hook on the entry agent
	if (entryAgent.hooks.afterRun) {
		await entryAgent.hooks.afterRun({ agent: entryAgent, result, context: ctx.context });
	}

	return result;
}

function buildToolDefs(agent: Agent<any, any>): ToolDefinition[] {
	const defs: ToolDefinition[] = agent.tools.map((t) => toolToDefinition(t));
	for (const sa of agent.subagents) {
		defs.push(subagentToDefinition(sa));
	}
	for (const h of agent.handoffs) {
		defs.push(handoffToDefinition(h));
	}
	return defs;
}

function extractUserText(messages: ChatMessage[]): string {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => {
			if (typeof m.content === "string") return m.content;
			return m.content
				.filter((p): p is import("./types").TextContentPart => p.type === "text")
				.map((p) => p.text)
				.join("\n");
		})
		.join("\n");
}

function shouldStopAfterToolCalls(
	agent: Agent<any, any>,
	toolCalls: { function: { name: string } }[],
): boolean {
	if (agent.toolUseBehavior === "run_llm_again") return false;
	if (agent.toolUseBehavior === "stop_on_first_tool") return true;
	if ("stopAtToolNames" in agent.toolUseBehavior) {
		return toolCalls.some((tc) =>
			agent.toolUseBehavior !== "run_llm_again" &&
			agent.toolUseBehavior !== "stop_on_first_tool" &&
			(agent.toolUseBehavior as { stopAtToolNames: string[] }).stopAtToolNames.includes(
				tc.function.name,
			),
		);
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

	const results = await Promise.all(
		toolCalls.map(async (tc) => {
			// Check handoffs first
			const matchedHandoff = agent.handoffs.find((h) => h.toolName === tc.function.name);
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
			const matchedSubagent = agent.subagents.find(
				(sa) => sa.toolName === tc.function.name,
			);
			if (matchedSubagent) {
				const saTool = subagentToTool(matchedSubagent);
				try {
					const params = JSON.parse(tc.function.arguments);

					if (agent.hooks.beforeToolCall) {
						const decision = await agent.hooks.beforeToolCall({
							agent,
							toolCall: { id: tc.id, type: "function", function: tc.function },
							context: ctx.context,
						});

						if (decision && typeof decision === "object" && "decision" in decision) {
							if (decision.decision === "deny") {
								return {
									role: "tool" as const,
									tool_call_id: tc.id,
									content:
										decision.reason ??
										`Tool call "${tc.function.name}" was denied`,
								};
							}
						}
					}

					let result: string;
					if (trace) {
						const span = trace.startSpan(
							`subagent:${matchedSubagent.agent.name}`,
							"subagent",
							{ toolName: tc.function.name },
						);
						try {
							result = await saTool.execute(ctx.context, params, { signal });
						} finally {
							trace.endSpan(span);
						}
					} else {
						result = await saTool.execute(ctx.context, params, { signal });
					}

					if (agent.hooks.afterToolCall) {
						await agent.hooks.afterToolCall({
							agent,
							toolCall: { id: tc.id, type: "function", function: tc.function },
							result,
							context: ctx.context,
						});
					}

					return {
						role: "tool" as const,
						tool_call_id: tc.id,
						content: result,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						role: "tool" as const,
						tool_call_id: tc.id,
						content: `Error executing sub-agent "${matchedSubagent.agent.name}": ${message}`,
					};
				}
			}

			// Otherwise, execute as normal tool
			const tool = agent.tools.find((t) => t.name === tc.function.name);
			if (!tool) {
				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: `Error: Unknown tool "${tc.function.name}"`,
				};
			}

			try {
				let params = JSON.parse(tc.function.arguments);

				// Fire beforeToolCall hook
				if (agent.hooks.beforeToolCall) {
					const decision = await agent.hooks.beforeToolCall({
						agent,
						toolCall: { id: tc.id, type: "function", function: tc.function },
						context: ctx.context,
					});

					if (decision && typeof decision === "object" && "decision" in decision) {
						if (decision.decision === "deny") {
							return {
								role: "tool" as const,
								tool_call_id: tc.id,
								content: decision.reason ?? `Tool call "${tc.function.name}" was denied`,
							};
						}
						if (decision.decision === "modify") {
							params = decision.modifiedParams;
						}
					}
				}

				checkAborted(signal);
				let result: string;
				if (trace) {
					const span = trace.startSpan(`tool:${tc.function.name}`, "tool_execution", {
						toolName: tc.function.name,
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
				if (agent.hooks.afterToolCall) {
					await agent.hooks.afterToolCall({
						agent,
						toolCall: { id: tc.id, type: "function", function: tc.function },
						result,
						context: ctx.context,
					});
				}

				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: result,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					role: "tool" as const,
					tool_call_id: tc.id,
					content: `Error executing tool "${tc.function.name}": ${message}`,
				};
			}
		}),
	);

	return { toolMessages: results, handoffAgent };
}
