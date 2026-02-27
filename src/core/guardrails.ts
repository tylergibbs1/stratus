import { InputGuardrailTripwireTriggered, OutputGuardrailTripwireTriggered } from "./errors";

export interface GuardrailResult {
	tripwireTriggered: boolean;
	outputInfo?: unknown;
}

export interface GuardrailRunResult {
	guardrailName: string;
	result: GuardrailResult;
}

export interface InputGuardrail<TContext = unknown> {
	name: string;
	execute: (input: string, context: TContext) => GuardrailResult | Promise<GuardrailResult>;
}

export interface OutputGuardrail<TContext = unknown> {
	name: string;
	execute: (output: string, context: TContext) => GuardrailResult | Promise<GuardrailResult>;
}

/** Guardrail that runs before a tool call */
export interface ToolInputGuardrail<TContext = unknown> {
	name: string;
	execute: (params: {
		toolName: string;
		toolArgs: Record<string, unknown>;
		context: TContext;
	}) => GuardrailResult | Promise<GuardrailResult>;
}

/** Guardrail that runs after a tool call */
export interface ToolOutputGuardrail<TContext = unknown> {
	name: string;
	execute: (params: {
		toolName: string;
		toolResult: string;
		context: TContext;
	}) => GuardrailResult | Promise<GuardrailResult>;
}

export async function runInputGuardrails<TContext>(
	guardrails: InputGuardrail<TContext>[],
	input: string,
	context: TContext,
): Promise<GuardrailRunResult[]> {
	const results = await Promise.all(
		guardrails.map(async (g) => {
			const result = await g.execute(input, context);
			return { guardrailName: g.name, result };
		}),
	);

	for (const { guardrailName, result } of results) {
		if (result.tripwireTriggered) {
			throw new InputGuardrailTripwireTriggered(guardrailName, result.outputInfo);
		}
	}

	return results;
}

export async function runOutputGuardrails<TContext>(
	guardrails: OutputGuardrail<TContext>[],
	output: string,
	context: TContext,
): Promise<GuardrailRunResult[]> {
	const results = await Promise.all(
		guardrails.map(async (g) => {
			const result = await g.execute(output, context);
			return { guardrailName: g.name, result };
		}),
	);

	for (const { guardrailName, result } of results) {
		if (result.tripwireTriggered) {
			throw new OutputGuardrailTripwireTriggered(guardrailName, result.outputInfo);
		}
	}

	return results;
}

export async function runToolInputGuardrails<TContext>(
	guardrails: ToolInputGuardrail<TContext>[],
	toolName: string,
	toolArgs: Record<string, unknown>,
	context: TContext,
): Promise<GuardrailRunResult[]> {
	const results = await Promise.all(
		guardrails.map(async (g) => {
			const result = await g.execute({ toolName, toolArgs, context });
			return { guardrailName: g.name, result };
		}),
	);

	return results;
}

export async function runToolOutputGuardrails<TContext>(
	guardrails: ToolOutputGuardrail<TContext>[],
	toolName: string,
	toolResult: string,
	context: TContext,
): Promise<GuardrailRunResult[]> {
	const results = await Promise.all(
		guardrails.map(async (g) => {
			const result = await g.execute({ toolName, toolResult, context });
			return { guardrailName: g.name, result };
		}),
	);

	return results;
}
