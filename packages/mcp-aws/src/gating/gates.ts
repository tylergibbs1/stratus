import type { Gate, GateContext, GateResult } from "../types.js";

/**
 * Requires at least one of the specified roles.
 */
export function role(...roles: string[]): Gate {
	return (ctx: GateContext): GateResult => {
		const hasRole = roles.some((r) => ctx.auth.roles.includes(r));
		if (hasRole) {
			return { allowed: true };
		}
		return {
			allowed: false,
			reason: `Requires one of roles: ${roles.join(", ")}`,
			hint: "Ensure the user has the appropriate role assigned.",
		};
	};
}

/**
 * Arbitrary async predicate gate.
 */
export function check(fn: (ctx: GateContext) => boolean | Promise<boolean>, reason?: string): Gate {
	return async (ctx: GateContext): Promise<GateResult> => {
		const passed = await fn(ctx);
		if (passed) {
			return { allowed: true };
		}
		return {
			allowed: false,
			reason: reason ?? "Check failed",
		};
	};
}

/**
 * Requires a prerequisite tool to have been called (unlocked in session).
 */
export function requires(prerequisiteToolName: string): Gate {
	return (ctx: GateContext): GateResult => {
		if (ctx.metadata.unlockedGates instanceof Set) {
			const gates = ctx.metadata.unlockedGates as Set<string>;
			if (gates.has(prerequisiteToolName)) {
				return { allowed: true };
			}
		}
		return {
			allowed: false,
			reason: `Requires "${prerequisiteToolName}" to be called first`,
			hint: `Call the "${prerequisiteToolName}" tool before using "${ctx.toolName}".`,
		};
	};
}

type RateLimitState = {
	count: number;
	windowStart: number;
};

/**
 * In-memory rate limiter per tool. Resets on cold start.
 */
export function rateLimit(opts: { max: number; windowMs: number }): Gate {
	const counters = new Map<string, RateLimitState>();

	return (ctx: GateContext): GateResult => {
		const key = `${ctx.sessionId}:${ctx.toolName}`;
		const now = Date.now();
		let state = counters.get(key);

		if (!state || now - state.windowStart >= opts.windowMs) {
			state = { count: 0, windowStart: now };
			counters.set(key, state);
		}

		if (state.count >= opts.max) {
			return {
				allowed: false,
				reason: `Rate limit exceeded: max ${opts.max} calls per ${opts.windowMs}ms`,
				hint: "Wait before retrying this tool.",
			};
		}

		state.count++;
		return { allowed: true };
	};
}
