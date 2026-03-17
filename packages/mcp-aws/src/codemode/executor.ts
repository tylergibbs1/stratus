/**
 * Code mode executor: runs LLM-generated code in a sandbox with tool access.
 * Copied from @usestratus/sdk (no dependency link — this package stands alone).
 */

import { Worker } from "node:worker_threads";

export type ExecuteResult = {
	result: unknown;
	error?: string;
	logs?: string[];
};

export type Executor = {
	execute(
		code: string,
		fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
	): Promise<ExecuteResult>;
};

export type FunctionExecutorOptions = {
	timeout?: number;
};

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
			const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
				...args: string[]
			) => (...args: unknown[]) => Promise<unknown>;

			const fn = new AsyncFunction("codemode", "console", `return await (${code})()`);

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

// ── WorkerExecutor ─────────────────────────────────────────────────

export type WorkerExecutorOptions = {
	timeout?: number;
};

const WORKER_BOOTSTRAP = `
const { parentPort } = require("worker_threads");

const codemode = new Proxy({}, {
	get: (_, name) => async (args) => {
		return new Promise((resolve, reject) => {
			const callId = String(Math.random());
			parentPort.postMessage({ type: "tool_call", callId, name: String(name), args });
			const handler = (msg) => {
				if (msg.callId === callId) {
					parentPort.off("message", handler);
					if (msg.error) reject(new Error(msg.error));
					else resolve(msg.result);
				}
			};
			parentPort.on("message", handler);
		});
	}
});

const __logs = [];
const __console = {
	log: (...a) => __logs.push(a.map(String).join(" ")),
	warn: (...a) => __logs.push("[warn] " + a.map(String).join(" ")),
	error: (...a) => __logs.push("[error] " + a.map(String).join(" ")),
};

(async () => {
	try {
		const __code = process.env.__CODEMODE_CODE;
		const fn = new Function("codemode", "console", "return (" + __code + ")()");
		const result = await fn(codemode, __console);
		parentPort.postMessage({ type: "done", result, logs: __logs });
	} catch (err) {
		parentPort.postMessage({ type: "done", error: err instanceof Error ? err.message : String(err), logs: __logs });
	}
})();
`;

export class WorkerExecutor implements Executor {
	readonly #timeout: number;

	constructor(options?: WorkerExecutorOptions) {
		this.#timeout = options?.timeout ?? 30_000;
	}

	async execute(
		code: string,
		fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
	): Promise<ExecuteResult> {
		return new Promise<ExecuteResult>((resolve) => {
			const timeoutMs = this.#timeout;
			let settled = false;

			const worker = new Worker(WORKER_BOOTSTRAP, {
				eval: true,
				env: { __CODEMODE_CODE: code },
			});

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					worker.terminate();
					resolve({ result: undefined, error: "Execution timed out" });
				}
			}, timeoutMs);

			worker.on("message", async (msg: Record<string, unknown>) => {
				if (msg.type === "tool_call") {
					const { callId, name, args } = msg as {
						callId: string;
						name: string;
						args: unknown;
					};
					const fn = fns[name];
					if (!fn) {
						worker.postMessage({ callId, error: `Tool "${name}" not found` });
						return;
					}
					try {
						const result = await fn(args);
						worker.postMessage({ callId, result });
					} catch (err) {
						worker.postMessage({
							callId,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				} else if (msg.type === "done") {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						worker.terminate();
						if (msg.error) {
							resolve({
								result: undefined,
								error: msg.error as string,
								logs: msg.logs as string[] | undefined,
							});
						} else {
							resolve({
								result: msg.result,
								logs: msg.logs as string[] | undefined,
							});
						}
					}
				}
			});

			worker.on("error", (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve({
						result: undefined,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		});
	}
}
