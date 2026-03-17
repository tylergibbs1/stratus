import type { FunctionTool } from "./tool";
import type { HostedToolDefinition } from "./types";

export interface HostedTool {
	type: "hosted";
	name: string;
	definition: HostedToolDefinition;
}

export type AgentTool = FunctionTool | HostedTool;

export function isHostedTool(tool: AgentTool): tool is HostedTool {
	return tool.type === "hosted";
}

export function isFunctionTool(tool: AgentTool): tool is FunctionTool {
	return tool.type === "function";
}
