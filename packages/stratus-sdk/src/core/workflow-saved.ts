import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workflow } from "./workflow";

export type SavedWorkflowScope = "project" | "user";

export interface SavedWorkflowInfo {
	name: string;
	path: string;
	scope: SavedWorkflowScope;
}

export interface DiscoverSavedWorkflowsOptions {
	cwd?: string;
	includeUser?: boolean;
	includeProject?: boolean;
}

export interface LoadedWorkflowModule<TArgs = unknown, TOutput = string> {
	workflow?: Workflow<TArgs, TOutput>;
	workflows: Workflow<TArgs, TOutput>[];
	module: Record<string, unknown>;
	path: string;
}

export async function discoverSavedWorkflows(
	options: DiscoverSavedWorkflowsOptions = {},
): Promise<SavedWorkflowInfo[]> {
	const cwd = options.cwd ?? process.cwd();
	const roots: Array<{ scope: SavedWorkflowScope; path: string }> = [];
	if (options.includeProject !== false) {
		roots.push({ scope: "project", path: join(cwd, ".stratus", "workflows") });
	}
	if (options.includeUser !== false) {
		roots.push({ scope: "user", path: join(homedir(), ".stratus", "workflows") });
	}

	const workflows: SavedWorkflowInfo[] = [];
	for (const root of roots) {
		if (!(await exists(root.path))) continue;
		for (const entry of await readdir(root.path)) {
			const filePath = join(root.path, entry);
			const fileStat = await stat(filePath);
			if (!fileStat.isFile() || !isWorkflowModule(entry)) continue;
			workflows.push({
				name: basename(entry, extname(entry)),
				path: filePath,
				scope: root.scope,
			});
		}
	}
	return workflows.sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadWorkflowModule<TArgs = unknown, TOutput = string>(
	filePath: string,
): Promise<LoadedWorkflowModule<TArgs, TOutput>> {
	const resolved = resolve(filePath);
	const module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
	const workflows = collectWorkflows<TArgs, TOutput>(module);
	return {
		workflow: workflows[0],
		workflows,
		module,
		path: resolved,
	};
}

function collectWorkflows<TArgs, TOutput>(
	module: Record<string, unknown>,
): Workflow<TArgs, TOutput>[] {
	const candidates = [
		module.default,
		module.workflow,
		...(Array.isArray(module.workflows) ? module.workflows : []),
		...Object.values(module),
	];
	const seen = new Set<unknown>();
	const workflows: Workflow<TArgs, TOutput>[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		if (isWorkflow(candidate)) workflows.push(candidate as Workflow<TArgs, TOutput>);
	}
	return workflows;
}

function isWorkflow(value: unknown): value is Workflow {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Workflow).name === "string" &&
		typeof (value as Workflow).run === "function"
	);
}

function isWorkflowModule(fileName: string): boolean {
	return [".js", ".mjs", ".ts"].includes(extname(fileName));
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
