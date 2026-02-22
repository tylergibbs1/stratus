import type { HostedTool } from "./hosted-tool";
import type { HostedToolDefinition } from "./types";

export interface WebSearchToolConfig {
	userLocation?: {
		type: "approximate";
		city?: string;
		state?: string;
		country?: string;
		region?: string;
	};
	searchContextSize?: "low" | "medium" | "high";
}

export function webSearchTool(config?: WebSearchToolConfig): HostedTool {
	const definition: HostedToolDefinition = {
		type: "web_search_preview",
	};
	if (config?.userLocation) {
		definition.user_location = config.userLocation;
	}
	if (config?.searchContextSize) {
		definition.search_context_size = config.searchContextSize;
	}
	return {
		type: "hosted",
		name: "web_search_preview",
		definition,
	};
}

export interface CodeInterpreterToolConfig {
	container?: {
		type: "auto" | string;
	};
}

export function codeInterpreterTool(config?: CodeInterpreterToolConfig): HostedTool {
	return {
		type: "hosted",
		name: "code_interpreter",
		definition: {
			type: "code_interpreter",
			container: config?.container ?? { type: "auto" },
		},
	};
}

export interface McpToolConfig {
	serverLabel: string;
	serverUrl: string;
	requireApproval?: "always" | "never" | { always?: string[]; never?: string[] };
	headers?: Record<string, string>;
}

export function mcpTool(config: McpToolConfig): HostedTool {
	const definition: HostedToolDefinition = {
		type: "mcp",
		server_label: config.serverLabel,
		server_url: config.serverUrl,
	};
	if (config.requireApproval !== undefined) {
		definition.require_approval = config.requireApproval;
	}
	if (config.headers) {
		definition.headers = config.headers;
	}
	return {
		type: "hosted",
		name: `mcp:${config.serverLabel}`,
		definition,
	};
}

export function imageGenerationTool(): HostedTool {
	return {
		type: "hosted",
		name: "image_generation",
		definition: {
			type: "image_generation",
		},
	};
}
