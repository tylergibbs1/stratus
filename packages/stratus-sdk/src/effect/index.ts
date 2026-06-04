import { Data, Effect, type Layer } from "effect";
import type { z } from "zod";
import type { Agent } from "../core/agent";
import type {
	Model,
	ModelRequest,
	ModelRequestOptions,
	ModelResponse,
	StreamEvent,
} from "../core/model";
import type { InterruptedRunResult, RunResult } from "../core/result";
import {
	type RunOptions,
	resumeRun,
	run,
	type StreamedRunResult,
	type StreamOptions,
	stream,
	type ToolApproval,
} from "../core/run";
import { type FunctionTool, type ToolExecuteOptions, tool } from "../core/tool";
import type { ChatMessage } from "../core/types";

export class StratusEffectError extends Data.TaggedError("StratusEffectError")<{
	readonly message: string;
	readonly cause: unknown;
}> {}

export interface EffectToolConfig<
	TParams,
	TContext = unknown,
	Requirements = never,
	Error = unknown,
> {
	name: string;
	description: string;
	parameters: z.ZodType<TParams>;
	execute: (
		context: TContext,
		params: TParams,
		options?: ToolExecuteOptions,
	) => Effect.Effect<string, Error, Requirements>;
	layer?: Layer.Layer<Requirements, unknown, never>;
	timeout?: number;
	isEnabled?: boolean | ((context: TContext) => boolean | Promise<boolean>);
	needsApproval?: boolean | ((params: TParams, context: TContext) => boolean | Promise<boolean>);
	retries?: FunctionTool<TParams, TContext>["retries"];
}

export interface EffectModelConfig<Requirements = never, Error = unknown> {
	getResponse: (
		request: ModelRequest,
		options?: ModelRequestOptions,
	) => Effect.Effect<ModelResponse, Error, Requirements>;
	getStreamedResponse?: (
		request: ModelRequest,
		options?: ModelRequestOptions,
	) => Effect.Effect<AsyncIterable<StreamEvent>, Error, Requirements>;
	layer?: Layer.Layer<Requirements, unknown, never>;
}

function errorMessage(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

function toStratusEffectError(cause: unknown): StratusEffectError {
	return new StratusEffectError({
		message: errorMessage(cause),
		cause,
	});
}

function withEffectSignal<TOptions extends { signal?: AbortSignal }>(
	options: TOptions | undefined,
	signal: AbortSignal,
): TOptions {
	return { ...(options ?? ({} as TOptions)), signal: options?.signal ?? signal };
}

function provideLayer<A, Error, Requirements>(
	self: Effect.Effect<A, Error, Requirements>,
	layer?: Layer.Layer<Requirements, unknown, never>,
): Effect.Effect<A, Error | unknown, never> {
	if (!layer) {
		return self as Effect.Effect<A, Error, never>;
	}
	return Effect.provide(self, layer) as Effect.Effect<A, Error | unknown, never>;
}

function runProvided<A, Error, Requirements>(
	self: Effect.Effect<A, Error, Requirements>,
	layer: Layer.Layer<Requirements, unknown, never> | undefined,
	signal?: AbortSignal,
): Promise<A> {
	return Effect.runPromise(provideLayer(self, layer), signal ? { signal } : undefined);
}

function responseToStream(response: ModelResponse): AsyncIterable<StreamEvent> {
	return (async function* () {
		if (response.content) {
			yield { type: "content_delta", content: response.content };
		}
		for (const toolCall of response.toolCalls) {
			yield {
				type: "tool_call_start",
				toolCall: { id: toolCall.id, name: toolCall.function.name },
			};
			yield {
				type: "tool_call_delta",
				toolCallId: toolCall.id,
				arguments: toolCall.function.arguments,
			};
			yield { type: "tool_call_done", toolCallId: toolCall.id };
		}
		yield { type: "done", response };
	})();
}

export function effectTool<TParams, TContext = unknown, Requirements = never, Error = unknown>(
	config: EffectToolConfig<TParams, TContext, Requirements, Error>,
): FunctionTool<TParams, TContext> {
	return tool({
		name: config.name,
		description: config.description,
		parameters: config.parameters,
		execute: (context, params, options) =>
			runProvided(config.execute(context, params, options), config.layer, options?.signal),
		timeout: config.timeout,
		isEnabled: config.isEnabled,
		needsApproval: config.needsApproval,
		retries: config.retries,
	});
}

export function effectModel<Requirements = never, Error = unknown>(
	config: EffectModelConfig<Requirements, Error>,
): Model {
	return {
		getResponse: (request, options) =>
			runProvided(config.getResponse(request, options), config.layer, options?.signal),
		async *getStreamedResponse(request, options) {
			const iterable = config.getStreamedResponse
				? await runProvided(
						config.getStreamedResponse(request, options),
						config.layer,
						options?.signal,
					)
				: responseToStream(
						await runProvided(config.getResponse(request, options), config.layer, options?.signal),
					);
			yield* iterable;
		},
	};
}

export function runEffect<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: RunOptions<TContext, TOutput>,
): Effect.Effect<RunResult<TOutput> | InterruptedRunResult<TOutput>, StratusEffectError, never> {
	return Effect.tryPromise({
		try: (signal) => run(agent, input, withEffectSignal(options, signal)),
		catch: toStratusEffectError,
	});
}

export function resumeRunEffect<TContext, TOutput = undefined>(
	interrupted: InterruptedRunResult<TOutput>,
	approvals: ToolApproval[],
	options?: RunOptions<TContext, TOutput>,
): Effect.Effect<RunResult<TOutput> | InterruptedRunResult<TOutput>, StratusEffectError, never> {
	return Effect.tryPromise({
		try: (signal) =>
			resumeRun<TContext, TOutput>(interrupted, approvals, withEffectSignal(options, signal)),
		catch: toStratusEffectError,
	});
}

export function streamEffect<TContext, TOutput = undefined>(
	agent: Agent<TContext, TOutput>,
	input: string | ChatMessage[],
	options?: StreamOptions<TContext, TOutput>,
): Effect.Effect<StreamedRunResult<TOutput>, StratusEffectError, never> {
	return Effect.try({
		try: () => stream(agent, input, options),
		catch: toStratusEffectError,
	});
}
