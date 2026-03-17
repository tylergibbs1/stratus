import type { Gate, GateContext, GateResult } from "../types.js";

/**
 * All gates must pass. Returns the first failure.
 */
export function all(...gates: Gate[]): Gate {
	return async (ctx: GateContext): Promise<GateResult> => {
		for (const gate of gates) {
			const result = await gate(ctx);
			if (!result.allowed) {
				return result;
			}
		}
		return { allowed: true };
	};
}

/**
 * At least one gate must pass. Returns all failure reasons if none pass.
 */
export function any(...gates: Gate[]): Gate {
	return async (ctx: GateContext): Promise<GateResult> => {
		const failures: string[] = [];
		for (const gate of gates) {
			const result = await gate(ctx);
			if (result.allowed) {
				return { allowed: true };
			}
			failures.push(result.reason);
		}
		return {
			allowed: false,
			reason: `None of the gates passed: ${failures.join("; ")}`,
		};
	};
}
