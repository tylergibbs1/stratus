import type { Agent } from "./agent";
import type { InterruptedRunResult, RunResult } from "./result";
import { type RunOptions, run } from "./run";
import type { ChatMessage } from "./types";

export interface WorkflowDraftPhase {
	name: string;
	purpose: string;
	agents?: number;
	verification?: string;
}

export interface WorkflowDraft {
	name: string;
	description?: string;
	phases: WorkflowDraftPhase[];
	script: string;
	estimatedTasks?: number;
	budget?: {
		maxTotalTokens?: number;
		maxDurationMs?: number;
	};
	warnings: string[];
	rawOutput: string;
	runResult: RunResult | InterruptedRunResult;
}

export interface GenerateWorkflowDraftOptions<TContext = unknown>
	extends Omit<RunOptions<TContext>, "context"> {
	context?: TContext;
	goal?: string;
	constraints?: string[];
	patterns?: string[];
}

export async function generateWorkflowDraft<TContext = unknown>(
	agent: Agent<TContext>,
	prompt: string | ChatMessage[],
	options: GenerateWorkflowDraftOptions<TContext> = {},
): Promise<WorkflowDraft> {
	const result = await run(agent, buildDraftPrompt(prompt, options), {
		...options,
		context: options.context,
	});
	const parsed = parseDraft(result.output);
	return {
		name: parsed.name,
		description: parsed.description,
		phases: parsed.phases,
		script: parsed.script,
		estimatedTasks: parsed.estimatedTasks,
		budget: parsed.budget,
		warnings: parsed.warnings ?? [],
		rawOutput: result.output,
		runResult: result,
	};
}

function buildDraftPrompt<TContext>(
	prompt: string | ChatMessage[],
	options: GenerateWorkflowDraftOptions<TContext>,
): string | ChatMessage[] {
	const body = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
	const constraints = options.constraints?.map((item) => `- ${item}`).join("\n") ?? "- none";
	const patterns =
		options.patterns?.map((item) => `- ${item}`).join("\n") ??
		"- fan-out-and-synthesize\n- adversarial-verification\n- loop-until-done";
	return `Create a Stratus dynamic workflow draft for this request.

Return only JSON with this exact shape:
{
  "name": "kebab-case-name",
  "description": "short human summary",
  "phases": [{"name":"phase name","purpose":"why it exists","agents":3,"verification":"how results are checked"}],
  "script": "TypeScript workflow code using @usestratus/sdk workflow APIs",
  "estimatedTasks": 12,
  "budget": {"maxTotalTokens": 50000, "maxDurationMs": 600000},
  "warnings": ["token usage can be high"]
}

Goal:
${options.goal ?? body}

Requested workflow:
${body}

Preferred patterns:
${patterns}

Constraints:
${constraints}`;
}

function parseDraft(output: string): Omit<WorkflowDraft, "rawOutput" | "runResult"> {
	const json = extractJsonObject(output);
	const parsed = JSON.parse(json) as Partial<WorkflowDraft>;
	return {
		name: typeof parsed.name === "string" && parsed.name ? parsed.name : "generated-workflow",
		description: typeof parsed.description === "string" ? parsed.description : undefined,
		phases: Array.isArray(parsed.phases)
			? parsed.phases.map((phase) => ({
					name: String((phase as WorkflowDraftPhase).name ?? "phase"),
					purpose: String((phase as WorkflowDraftPhase).purpose ?? ""),
					agents:
						typeof (phase as WorkflowDraftPhase).agents === "number"
							? (phase as WorkflowDraftPhase).agents
							: undefined,
					verification:
						typeof (phase as WorkflowDraftPhase).verification === "string"
							? (phase as WorkflowDraftPhase).verification
							: undefined,
				}))
			: [],
		script: typeof parsed.script === "string" ? parsed.script : "",
		estimatedTasks:
			typeof parsed.estimatedTasks === "number" ? parsed.estimatedTasks : undefined,
		budget: parsed.budget,
		warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
	};
}

function extractJsonObject(output: string): string {
	const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start >= 0 && end > start) return output.slice(start, end + 1);
	throw new Error("Workflow draft response did not contain a JSON object");
}
