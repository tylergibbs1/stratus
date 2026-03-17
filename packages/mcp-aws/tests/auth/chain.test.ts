import { describe, expect, test } from "bun:test";
import { ApiKeyAuth } from "../../src/auth/api-key.js";
import { chainAuth } from "../../src/auth/index.js";
import type { AuthProvider } from "../../src/auth/types.js";

describe("chainAuth", () => {
	test("returns first successful auth", async () => {
		const provider1 = new ApiKeyAuth({ keys: { "key-a": { subject: "a" } } });
		const provider2 = new ApiKeyAuth({ keys: { "key-b": { subject: "b" } } });
		const chain = chainAuth(provider1, provider2);

		const result = await chain.authenticate({ headers: { "x-api-key": "key-b" } });
		expect(result.authenticated).toBe(true);
		expect(result.subject).toBe("b");
	});

	test("first provider wins when both match", async () => {
		const provider1 = new ApiKeyAuth({ keys: { "key-shared": { subject: "first" } } });
		const provider2 = new ApiKeyAuth({ keys: { "key-shared": { subject: "second" } } });
		const chain = chainAuth(provider1, provider2);

		const result = await chain.authenticate({ headers: { "x-api-key": "key-shared" } });
		expect(result.authenticated).toBe(true);
		expect(result.subject).toBe("first");
	});

	test("returns unauthenticated when no provider matches", async () => {
		const provider1 = new ApiKeyAuth({ keys: { "key-a": { subject: "a" } } });
		const chain = chainAuth(provider1);

		const result = await chain.authenticate({ headers: { "x-api-key": "wrong" } });
		expect(result.authenticated).toBe(false);
	});

	test("works with custom AuthProvider", async () => {
		const customProvider: AuthProvider = {
			async authenticate() {
				return { authenticated: true, subject: "custom", roles: ["admin"], claims: {} };
			},
		};
		const chain = chainAuth(customProvider);

		const result = await chain.authenticate({ headers: {} });
		expect(result.authenticated).toBe(true);
		expect(result.subject).toBe("custom");
	});

	test("empty chain returns unauthenticated", async () => {
		const chain = chainAuth();
		const result = await chain.authenticate({ headers: {} });
		expect(result.authenticated).toBe(false);
	});
});
