import type { McpSession, ToolConfig } from "../types.js";

/**
 * Returns tools visible to this session based on tier and promotions.
 */
export function getVisibleTools(
	allTools: Map<string, ToolConfig>,
	session: McpSession,
): ToolConfig[] {
	const results: ToolConfig[] = [];
	for (const tool of allTools.values()) {
		if (tool.tier === "always" || session.visibleTools.has(tool.name)) {
			results.push(tool);
		}
	}
	return results;
}

/**
 * Promotes a tool to the session's visible set.
 * Returns true if the tool was newly promoted.
 */
export function promoteToVisible(session: McpSession, toolName: string): boolean {
	if (session.visibleTools.has(toolName)) return false;
	session.visibleTools.add(toolName);
	return true;
}

/**
 * Check if a tool's gate is (or wraps) a `requires()` gate matching the given name.
 * We detect this by calling the gate with the prerequisite in `unlockedGates` and without.
 * If the gate passes with it and fails without it, the gate depends on this prerequisite.
 */
function gateMatchesPrerequisite(tool: ToolConfig, gateName: string): boolean {
	if (!tool.gate) return false;

	// Synchronous heuristic: call the gate with and without the prerequisite.
	// requires() gates are synchronous, so this works for the common case.
	const baseCtx = {
		auth: { authenticated: false, roles: [] as string[], claims: {} },
		toolName: tool.name,
		sessionId: "check",
		metadata: { unlockedGates: new Set<string>() },
	};
	const withCtx = {
		...baseCtx,
		metadata: { unlockedGates: new Set([gateName]) },
	};

	const withoutResult = tool.gate(baseCtx);
	const withResult = tool.gate(withCtx);

	// Both should be synchronous GateResult for requires() gates
	if (withoutResult instanceof Promise || withResult instanceof Promise) {
		// Async gates can't be checked synchronously — conservatively promote
		return true;
	}

	return !withoutResult.allowed && withResult.allowed;
}

/**
 * Unlocks a gate and promotes hidden tools whose gate depends on it.
 * Returns the names of newly promoted tools.
 */
export function handleGateUnlock(
	allTools: Map<string, ToolConfig>,
	session: McpSession,
	gateName: string,
): string[] {
	session.unlockedGates.add(gateName);
	const promoted: string[] = [];

	for (const tool of allTools.values()) {
		if (tool.tier === "hidden" && !session.visibleTools.has(tool.name)) {
			if (gateMatchesPrerequisite(tool, gateName)) {
				session.visibleTools.add(tool.name);
				promoted.push(tool.name);
			}
		}
	}

	return promoted;
}
