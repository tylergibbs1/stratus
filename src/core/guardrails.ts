import {
	InputGuardrailTripwireTriggered,
	OutputGuardrailTripwireTriggered,
} from "./errors";

export interface GuardrailResult {
	tripwireTriggered: boolean;
	outputInfo?: unknown;
}

export interface InputGuardrail<TContext = unknown> {
	name: string;
	execute: (input: string, context: TContext) => GuardrailResult | Promise<GuardrailResult>;
}

export interface OutputGuardrail<TContext = unknown> {
	name: string;
	execute: (output: string, context: TContext) => GuardrailResult | Promise<GuardrailResult>;
}

export async function runInputGuardrails<TContext>(
	guardrails: InputGuardrail<TContext>[],
	input: string,
	context: TContext,
): Promise<void> {
	const results = await Promise.all(
		guardrails.map(async (g) => {
			const result = await g.execute(input, context);
			return { guardrail: g, result };
		}),
	);

	for (const { guardrail, result } of results) {
		if (result.tripwireTriggered) {
			throw new InputGuardrailTripwireTriggered(guardrail.name, result.outputInfo);
		}
	}
}

export async function runOutputGuardrails<TContext>(
	guardrails: OutputGuardrail<TContext>[],
	output: string,
	context: TContext,
): Promise<void> {
	const results = await Promise.all(
		guardrails.map(async (g) => {
			const result = await g.execute(output, context);
			return { guardrail: g, result };
		}),
	);

	for (const { guardrail, result } of results) {
		if (result.tripwireTriggered) {
			throw new OutputGuardrailTripwireTriggered(guardrail.name, result.outputInfo);
		}
	}
}
