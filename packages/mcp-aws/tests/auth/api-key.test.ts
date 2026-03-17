import { describe, expect, test } from "bun:test";
import { ApiKeyAuth } from "../../src/auth/api-key.js";

describe("ApiKeyAuth", () => {
	const auth = new ApiKeyAuth({
		keys: {
			"key-123": { subject: "user-1", roles: ["admin"], claims: { org: "acme" } },
			"key-456": { subject: "user-2", roles: ["reader"] },
			"key-minimal": {},
		},
	});

	test("authenticates with valid key", async () => {
		const result = await auth.authenticate({ headers: { "x-api-key": "key-123" } });
		expect(result.authenticated).toBe(true);
		expect(result.subject).toBe("user-1");
		expect(result.roles).toEqual(["admin"]);
		expect(result.claims).toEqual({ org: "acme" });
	});

	test("authenticates key with minimal entry (no roles/claims)", async () => {
		const result = await auth.authenticate({ headers: { "x-api-key": "key-minimal" } });
		expect(result.authenticated).toBe(true);
		expect(result.roles).toEqual([]);
		expect(result.claims).toEqual({});
	});

	test("returns unauthenticated for unknown key", async () => {
		const result = await auth.authenticate({ headers: { "x-api-key": "bad-key" } });
		expect(result.authenticated).toBe(false);
	});

	test("returns unauthenticated for missing header", async () => {
		const result = await auth.authenticate({ headers: {} });
		expect(result.authenticated).toBe(false);
	});

	test("uses custom header name", async () => {
		const customAuth = new ApiKeyAuth({
			keys: { "my-key": { subject: "custom" } },
			headerName: "authorization",
		});
		const result = await customAuth.authenticate({ headers: { authorization: "my-key" } });
		expect(result.authenticated).toBe(true);
		expect(result.subject).toBe("custom");
	});

	test("handles array header values", async () => {
		const result = await auth.authenticate({
			headers: { "x-api-key": ["key-123", "ignored"] },
		});
		expect(result.authenticated).toBe(true);
		expect(result.subject).toBe("user-1");
	});
});
