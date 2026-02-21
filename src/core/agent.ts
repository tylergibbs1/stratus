import type { z } from "zod";
import type { InputGuardrail, OutputGuardrail } from "./guardrails";
import { type Handoff, handoff as normalizeHandoff } from "./handoff";
import type { AgentHooks } from "./hooks";
import type { Model } from "./model";
import type { SubAgent } from "./subagent";
import type { AgentTool } from "./hosted-tool";
import type { FunctionTool } from "./tool";
import type { ModelSettings, ResponseFormat, ToolUseBehavior } from "./types";
import { zodToJsonSchema } from "./utils/zod";

export type Instructions<TContext> = string | ((context: TContext) => string | Promise<string>);

export type HandoffInput<TContext> = Agent<TContext> | Handoff<TContext>;

export interface AgentConfig<TContext, TOutput = undefined> {
	name: string;
	instructions?: Instructions<TContext>;
	model?: Model;
	tools?: AgentTool[];
	subagents?: SubAgent[];
	modelSettings?: ModelSettings;
	responseFormat?: ResponseFormat;
	outputType?: z.ZodType<TOutput>;
	handoffs?: HandoffInput<TContext>[];
	handoffDescription?: string;
	inputGuardrails?: InputGuardrail<TContext>[];
	outputGuardrails?: OutputGuardrail<TContext>[];
	hooks?: AgentHooks<TContext>;
	toolUseBehavior?: ToolUseBehavior;
}

export class Agent<TContext = unknown, TOutput = undefined> {
	readonly name: string;
	readonly instructions?: Instructions<TContext>;
	readonly model?: Model;
	readonly tools: AgentTool[];
	readonly subagents: SubAgent[];
	readonly modelSettings?: ModelSettings;
	readonly responseFormat?: ResponseFormat;
	readonly outputType?: z.ZodType<TOutput>;
	readonly handoffs: Handoff<TContext>[];
	readonly handoffDescription?: string;
	readonly inputGuardrails: InputGuardrail<TContext>[];
	readonly outputGuardrails: OutputGuardrail<TContext>[];
	readonly hooks: AgentHooks<TContext>;
	readonly toolUseBehavior: ToolUseBehavior;

	constructor(config: AgentConfig<TContext, TOutput>) {
		this.name = config.name;
		this.instructions = config.instructions;
		this.model = config.model;
		this.tools = config.tools ?? [];
		this.subagents = config.subagents ?? [];
		this.modelSettings = config.modelSettings;
		this.responseFormat = config.responseFormat;
		this.outputType = config.outputType;
		this.handoffs = (config.handoffs ?? []).map((h) =>
			h instanceof Agent ? normalizeHandoff(h) : h,
		);
		this.handoffDescription = config.handoffDescription;
		this.inputGuardrails = config.inputGuardrails ?? [];
		this.outputGuardrails = config.outputGuardrails ?? [];
		this.hooks = config.hooks ?? {};
		this.toolUseBehavior = config.toolUseBehavior ?? "run_llm_again";
	}

	async getSystemPrompt(context: TContext): Promise<string | undefined> {
		if (this.instructions === undefined) return undefined;
		if (typeof this.instructions === "string") return this.instructions;
		return this.instructions(context);
	}

	getResponseFormat(): ResponseFormat | undefined {
		if (this.outputType) {
			return {
				type: "json_schema",
				json_schema: {
					name: "response",
					schema: zodToJsonSchema(this.outputType),
					strict: true,
				},
			};
		}
		return this.responseFormat;
	}

	clone(overrides: Partial<AgentConfig<TContext, TOutput>>): Agent<TContext, TOutput> {
		return new Agent({
			name: this.name,
			instructions: this.instructions,
			model: this.model,
			tools: this.tools,
			subagents: this.subagents,
			modelSettings: this.modelSettings,
			responseFormat: this.responseFormat,
			outputType: this.outputType,
			handoffs: this.handoffs,
			handoffDescription: this.handoffDescription,
			inputGuardrails: this.inputGuardrails,
			outputGuardrails: this.outputGuardrails,
			hooks: this.hooks,
			toolUseBehavior: this.toolUseBehavior,
			...overrides,
		});
	}
}
