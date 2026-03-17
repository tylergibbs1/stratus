/**
 * Code mode: let LLMs write code that orchestrates tools instead of calling them one at a time.
 *
 * Inspired by Cloudflare's Code Mode and CodeAct — LLMs are better at writing code
 * than making individual tool calls because they've seen millions of lines of real-world
 * TypeScript but only contrived tool-calling examples.
 */

import { z } from "zod";
import { isFunctionTool } from "../hosted-tool";
import { tool } from "../tool";
import type { FunctionTool } from "../tool";
import type { AgentTool } from "../hosted-tool";
import type { Executor } from "./executor";
import { generateTypes, normalizeCode, sanitizeToolName } from "./types";

export type { Executor, ExecuteResult } from "./executor";
export { FunctionExecutor, WorkerExecutor } from "./executor";
export type { FunctionExecutorOptions, WorkerExecutorOptions } from "./executor";
export { generateTypes, normalizeCode, sanitizeToolName } from "./types";

// ── Default description ────────────────────────────────────────────

const DEFAULT_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

// ── createCodeModeTool ─────────────────────────────────────────────

export interface CodeModeToolOptions {
	/** The tools to make available inside the code sandbox. Hosted tools are filtered out. */
	tools: AgentTool[];
	/** The executor to run generated code in. */
	executor: Executor;
	/** Custom tool description. Use `{{types}}` as a placeholder for the generated type definitions. */
	description?: string;
}

export interface CodeModeOutput {
	code: string;
	result: unknown;
	logs?: string[];
}

const codeSchema = z.object({
	code: z.string().describe("JavaScript async arrow function to execute"),
});

/**
 * Create a code mode tool that allows LLMs to write and execute code
 * with access to your tools in a sandboxed environment.
 *
 * Returns a Stratus `FunctionTool` that can be added to any agent's tools array.
 *
 * @example
 * ```ts
 * import { Agent, tool } from "stratus";
 * import { createCodeModeTool, FunctionExecutor } from "stratus/core/codemode";
 *
 * const weatherTool = tool({
 *   name: "get_weather",
 *   description: "Get weather for a location",
 *   parameters: z.object({ location: z.string() }),
 *   execute: async (ctx, { location }) => `72°F, sunny in ${location}`,
 * });
 *
 * const executor = new FunctionExecutor({ timeout: 10_000 });
 * const codemode = createCodeModeTool({
 *   tools: [weatherTool],
 *   executor,
 * });
 *
 * const agent = new Agent({
 *   name: "assistant",
 *   instructions: "You are a helpful assistant.",
 *   tools: [codemode],
 * });
 * ```
 */
export function createCodeModeTool<TContext = unknown>(
	options: CodeModeToolOptions,
): FunctionTool<{ code: string }, TContext> {
	// Filter to only function tools (hosted tools can't be called locally)
	const functionTools = options.tools.filter(isFunctionTool);
	const types = generateTypes(functionTools);
	const executor = options.executor;

	return tool({
		name: "execute_code",
		description: (options.description ?? DEFAULT_DESCRIPTION).replace("{{types}}", types),
		parameters: codeSchema,
		async execute(context: TContext, { code }: { code: string }) {
			// Build the function map for the sandbox
			const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
			for (const t of functionTools) {
				const safeName = sanitizeToolName(t.name);
				fns[safeName] = async (args: unknown) => {
					const validated = t.parameters.parse(args);
					const result = await t.execute(context, validated);
					// Try to parse as JSON, fall back to raw string
					try {
						return JSON.parse(result);
					} catch {
						return result;
					}
				};
			}

			const normalizedCode = normalizeCode(code);
			const executeResult = await executor.execute(normalizedCode, fns);

			if (executeResult.error) {
				const logCtx = executeResult.logs?.length
					? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
					: "";
				throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
			}

			const output: CodeModeOutput = {
				code,
				result: executeResult.result,
			};
			if (executeResult.logs?.length) {
				output.logs = executeResult.logs;
			}
			return JSON.stringify(output);
		},
	});
}
