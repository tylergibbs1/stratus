import { StratusError } from "./errors";
import { isFunctionTool } from "./hosted-tool";
import type { AgentTool } from "./hosted-tool";

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

export function validateAgent(agent: { tools: AgentTool[]; name: string }): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const seen = new Set<string>();
	for (const t of agent.tools) {
		const name = isFunctionTool(t) ? t.name : t.name;

		if (seen.has(name)) {
			errors.push(`Duplicate tool name "${name}"`);
		}
		seen.add(name);

		if (isFunctionTool(t)) {
			if (t.description.trim() === "") {
				warnings.push(`Tool "${t.name}" has an empty description`);
			}

			if (t.timeout !== undefined && t.timeout <= 0) {
				errors.push(`Tool "${t.name}" has invalid timeout: ${t.timeout}ms (must be > 0)`);
			}
		}
	}

	return { errors, warnings };
}

export function runValidation(agent: { tools: AgentTool[]; name: string }): void {
	const result = validateAgent(agent);

	for (const w of result.warnings) {
		console.warn(`[stratus] ${w}`);
	}

	if (result.errors.length > 0) {
		throw new StratusError(
			`Agent "${agent.name}" validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	}
}
