import { describe, expect, test } from "bun:test";
import { getAuthContext, getSession, withContext } from "../src/context.js";
import type { AuthContext, McpSession } from "../src/types.js";

describe("AsyncLocalStorage context", () => {
	test("getAuthContext returns auth inside withContext", async () => {
		const auth: AuthContext = { authenticated: true, subject: "user-1", roles: ["admin"], claims: {} };
		const session = { id: "s1" } as McpSession;

		let captured: AuthContext | undefined;
		await withContext({ auth, session }, () => {
			captured = getAuthContext();
		});

		expect(captured).toEqual(auth);
	});

	test("getSession returns session inside withContext", async () => {
		const auth: AuthContext = { authenticated: false, roles: [], claims: {} };
		const now = Date.now();
		const session: McpSession = {
			id: "s1",
			visibleTools: new Set(),
			unlockedGates: new Set(),
			toolCallHistory: [],
			auth,
			metadata: {},
			createdAt: now,
			lastAccessedAt: now,
		};

		let captured: McpSession | undefined;
		await withContext({ auth, session }, () => {
			captured = getSession();
		});

		expect(captured?.id).toBe("s1");
	});

	test("getAuthContext returns unauthenticated outside withContext", () => {
		const auth = getAuthContext();
		expect(auth.authenticated).toBe(false);
		expect(auth.roles).toEqual([]);
	});

	test("getSession returns undefined outside withContext", () => {
		expect(getSession()).toBeUndefined();
	});

	test("nested withContext scopes correctly", async () => {
		const outer = { authenticated: true, subject: "outer", roles: [] as string[], claims: {} };
		const inner = { authenticated: true, subject: "inner", roles: [] as string[], claims: {} };
		const session = { id: "s1" } as McpSession;

		let outerCapture: string | undefined;
		let innerCapture: string | undefined;

		await withContext({ auth: outer, session }, async () => {
			outerCapture = getAuthContext().subject;
			await withContext({ auth: inner, session }, () => {
				innerCapture = getAuthContext().subject;
			});
			// After inner exits, outer should be restored
			expect(getAuthContext().subject).toBe("outer");
		});

		expect(outerCapture).toBe("outer");
		expect(innerCapture).toBe("inner");
	});

	test("works with async handlers", async () => {
		const auth = { authenticated: true, subject: "async-user", roles: [] as string[], claims: {} };
		const session = { id: "s1" } as McpSession;

		const result = await withContext({ auth, session }, async () => {
			await new Promise((r) => setTimeout(r, 10));
			return getAuthContext().subject;
		});

		expect(result).toBe("async-user");
	});
});
