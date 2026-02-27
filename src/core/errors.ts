export class StratusError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StratusError";
	}
}

export class MaxTurnsExceededError extends StratusError {
	constructor(maxTurns: number) {
		super(`Agent exceeded maximum turns (${maxTurns})`);
		this.name = "MaxTurnsExceededError";
	}
}

export class ModelError extends StratusError {
	readonly status?: number;
	readonly code?: string;

	constructor(message: string, options?: { status?: number; code?: string; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "ModelError";
		this.status = options?.status;
		this.code = options?.code;
	}
}

export class ContentFilterError extends ModelError {
	constructor(message?: string, options?: { status?: number; cause?: unknown }) {
		super(message ?? "Content was filtered by the content management policy", {
			status: options?.status,
			code: "content_filter",
			cause: options?.cause,
		});
		this.name = "ContentFilterError";
	}
}

export class OutputParseError extends StratusError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OutputParseError";
	}
}

export class InputGuardrailTripwireTriggered extends StratusError {
	readonly guardrailName: string;
	readonly outputInfo?: unknown;

	constructor(guardrailName: string, outputInfo?: unknown) {
		super(`Input guardrail "${guardrailName}" tripwire triggered`);
		this.name = "InputGuardrailTripwireTriggered";
		this.guardrailName = guardrailName;
		this.outputInfo = outputInfo;
	}
}

export class RunAbortedError extends StratusError {
	constructor(message?: string) {
		super(message ?? "Run was aborted");
		this.name = "RunAbortedError";
	}
}

export class MaxBudgetExceededError extends StratusError {
	readonly budgetUsd: number;
	readonly spentUsd: number;

	constructor(budgetUsd: number, spentUsd: number) {
		super(`Agent exceeded maximum budget ($${budgetUsd.toFixed(4)}, spent $${spentUsd.toFixed(4)})`);
		this.name = "MaxBudgetExceededError";
		this.budgetUsd = budgetUsd;
		this.spentUsd = spentUsd;
	}
}

export class ToolTimeoutError extends StratusError {
	readonly toolName: string;
	readonly timeoutMs: number;

	constructor(toolName: string, timeoutMs: number) {
		super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
		this.name = "ToolTimeoutError";
		this.toolName = toolName;
		this.timeoutMs = timeoutMs;
	}
}

export class OutputGuardrailTripwireTriggered extends StratusError {
	readonly guardrailName: string;
	readonly outputInfo?: unknown;

	constructor(guardrailName: string, outputInfo?: unknown) {
		super(`Output guardrail "${guardrailName}" tripwire triggered`);
		this.name = "OutputGuardrailTripwireTriggered";
		this.guardrailName = guardrailName;
		this.outputInfo = outputInfo;
	}
}
