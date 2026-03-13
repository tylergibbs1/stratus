/**
 * Code mode executor: runs LLM-generated code in a sandbox with tool access.
 *
 * The Executor interface is deliberately minimal — implement it to run code
 * in any sandbox (Node VM, Bun, QuickJS, containers, Cloudflare Workers, etc.).
 */

export interface ExecuteResult {
	result: unknown;
	error?: string;
	logs?: string[];
}

/**
 * An executor runs LLM-generated code in a sandbox, making the provided
 * tool functions callable as `codemode.*` inside the sandbox.
 *
 * Implementations should never throw — errors are returned in `ExecuteResult.error`.
 */
export interface Executor {
	execute(
		code: string,
		fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
	): Promise<ExecuteResult>;
}

export interface FunctionExecutorOptions {
	/** Timeout in milliseconds for code execution. Defaults to 30000 (30s). */
	timeout?: number;
}

/**
 * Executes code using AsyncFunction (works in Node.js and Bun).
 * Tool calls are injected via the `codemode` parameter.
 *
 * This is NOT a secure sandbox — it runs in the same V8 isolate.
 * For production use with untrusted code, implement a custom Executor
 * using isolated-vm, Cloudflare Workers, or containers.
 */
export class FunctionExecutor implements Executor {
	readonly #timeout: number;

	constructor(options?: FunctionExecutorOptions) {
		this.#timeout = options?.timeout ?? 30_000;
	}

	async execute(
		code: string,
		fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
	): Promise<ExecuteResult> {
		const logs: string[] = [];

		// Create a console proxy that captures output
		const consoleProxy = {
			log: (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			},
			warn: (...args: unknown[]) => {
				logs.push(`[warn] ${args.map(String).join(" ")}`);
			},
			error: (...args: unknown[]) => {
				logs.push(`[error] ${args.map(String).join(" ")}`);
			},
		};

		try {
			// biome-ignore lint/security/noGlobalEval: Required for code mode execution
			const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
				...args: string[]
			) => (...args: unknown[]) => Promise<unknown>;

			const fn = new AsyncFunction(
				"codemode",
				"console",
				`return await (${code})()`,
			);

			const timeoutMs = this.#timeout;
			const result = await Promise.race([
				fn(fns, consoleProxy),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Execution timed out")), timeoutMs),
				),
			]);

			return { result, logs };
		} catch (err) {
			return {
				result: undefined,
				error: err instanceof Error ? err.message : String(err),
				logs,
			};
		}
	}
}
