import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { Agent, type AgentConfig } from "./agent";
import type { AgentTool } from "./hosted-tool";
import { tool } from "./tool";

export interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface SandboxWorkspace {
	readonly root: string;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	listFiles(path?: string): Promise<string[]>;
	runCommand(command: string, options?: { timeoutMs?: number }): Promise<CommandResult>;
}

export interface LocalSandboxOptions {
	root: string;
	/** Default command timeout in milliseconds. Defaults to 30 seconds. */
	commandTimeoutMs?: number;
	/** Maximum bytes returned from stdout/stderr combined. Defaults to 64 KiB. */
	maxOutputBytes?: number;
}

export class LocalSandbox implements SandboxWorkspace {
	readonly root: string;
	private readonly commandTimeoutMs: number;
	private readonly maxOutputBytes: number;

	constructor(options: LocalSandboxOptions) {
		this.root = resolve(options.root);
		this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
		this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
	}

	async readFile(path: string): Promise<string> {
		return readFile(this.resolvePath(path), "utf8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		const fullPath = this.resolvePath(path);
		await mkdir(resolve(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content, "utf8");
	}

	async listFiles(path = "."): Promise<string[]> {
		const start = this.resolvePath(path);
		const entries: string[] = [];
		await this.walk(start, entries);
		return entries.sort();
	}

	async runCommand(command: string, options?: { timeoutMs?: number }): Promise<CommandResult> {
		await mkdir(this.root, { recursive: true });
		return new Promise((resolveCommand) => {
			const child = spawn(command, {
				cwd: this.root,
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const limitOutput = () => {
				const combined = stdout.length + stderr.length;
				if (combined <= this.maxOutputBytes) return;
				const keep = Math.floor(this.maxOutputBytes / 2);
				stdout = stdout.slice(0, keep);
				stderr = stderr.slice(0, keep);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, options?.timeoutMs ?? this.commandTimeoutMs);

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
				limitOutput();
			});
			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
				limitOutput();
			});
			child.on("close", (exitCode) => {
				clearTimeout(timer);
				resolveCommand({
					exitCode,
					stdout,
					stderr: timedOut ? `${stderr}\nCommand timed out`.trim() : stderr,
				});
			});
		});
	}

	private resolvePath(path: string): string {
		const fullPath = resolve(this.root, path);
		const rel = relative(this.root, fullPath);
		if (rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`Path escapes sandbox root: ${path}`);
		}
		return fullPath;
	}

	private async walk(path: string, entries: string[]): Promise<void> {
		const info = await stat(path);
		if (info.isFile()) {
			entries.push(relative(this.root, path));
			return;
		}
		if (!info.isDirectory()) return;
		for (const entry of await readdir(path)) {
			await this.walk(resolve(path, entry), entries);
		}
	}
}

export interface SandboxAgentConfig<TContext, TOutput = undefined> extends AgentConfig<
	TContext,
	TOutput
> {
	sandbox: SandboxWorkspace | LocalSandboxOptions;
	/** Include built-in workspace tools. Defaults to true. */
	includeSandboxTools?: boolean;
}

function createSandboxTools<TContext>(sandbox: SandboxWorkspace): AgentTool[] {
	return [
		tool({
			name: "sandbox_read_file",
			description: "Read a UTF-8 text file from the sandbox workspace.",
			parameters: z.object({ path: z.string() }),
			execute: async (_context: TContext, params) => sandbox.readFile(params.path),
		}),
		tool({
			name: "sandbox_write_file",
			description: "Write a UTF-8 text file into the sandbox workspace.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async (_context: TContext, params) => {
				await sandbox.writeFile(params.path, params.content);
				return `Wrote ${params.path}`;
			},
		}),
		tool({
			name: "sandbox_list_files",
			description: "List files in the sandbox workspace.",
			parameters: z.object({ path: z.string().optional() }),
			execute: async (_context: TContext, params) =>
				(await sandbox.listFiles(params.path)).join("\n"),
		}),
		tool({
			name: "sandbox_run_command",
			description: "Run a shell command inside the sandbox workspace.",
			parameters: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
			execute: async (_context: TContext, params) => {
				const result = await sandbox.runCommand(params.command, { timeoutMs: params.timeoutMs });
				return JSON.stringify(result);
			},
		}),
	];
}

function normalizeSandbox(sandbox: SandboxWorkspace | LocalSandboxOptions): SandboxWorkspace {
	if ("readFile" in sandbox) return sandbox;
	return new LocalSandbox(sandbox);
}

export class SandboxAgent<TContext = unknown, TOutput = undefined> extends Agent<
	TContext,
	TOutput
> {
	readonly sandbox: SandboxWorkspace;

	constructor(config: SandboxAgentConfig<TContext, TOutput>) {
		const sandbox = normalizeSandbox(config.sandbox);
		const sandboxTools =
			config.includeSandboxTools === false ? [] : createSandboxTools<TContext>(sandbox);
		super({
			...config,
			tools: [...sandboxTools, ...(config.tools ?? [])],
		});
		this.sandbox = sandbox;
	}
}
