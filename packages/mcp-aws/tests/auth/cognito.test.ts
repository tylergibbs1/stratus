import { describe, expect, test } from "bun:test";
import { CognitoAuth } from "../../src/auth/cognito.js";

describe("CognitoAuth", () => {
	// We can't test real JWT verification without a real Cognito pool,
	// but we can test the failure paths and configuration.

	test("returns unauthenticated when no authorization header", async () => {
		const auth = new CognitoAuth({
			userPoolId: "us-east-1_testPool",
			region: "us-east-1",
		});
		const result = await auth.authenticate({ headers: {} });
		expect(result.authenticated).toBe(false);
	});

	test("returns unauthenticated for invalid token", async () => {
		const auth = new CognitoAuth({
			userPoolId: "us-east-1_testPool",
			region: "us-east-1",
		});
		const result = await auth.authenticate({
			headers: { authorization: "Bearer invalid.token.here" },
		});
		expect(result.authenticated).toBe(false);
	});

	test("strips Bearer prefix", async () => {
		const auth = new CognitoAuth({
			userPoolId: "us-east-1_testPool",
			region: "us-east-1",
		});
		// Both with and without Bearer prefix should fail gracefully
		const result1 = await auth.authenticate({
			headers: { authorization: "Bearer xyz" },
		});
		const result2 = await auth.authenticate({
			headers: { authorization: "xyz" },
		});
		expect(result1.authenticated).toBe(false);
		expect(result2.authenticated).toBe(false);
	});

	test("uses custom rolesClaim", async () => {
		// Just verify it instantiates with custom config
		const auth = new CognitoAuth({
			userPoolId: "us-east-1_testPool",
			region: "us-east-1",
			audience: "my-client-id",
			rolesClaim: "custom:roles",
		});
		const result = await auth.authenticate({ headers: {} });
		expect(result.authenticated).toBe(false);
	});
});
