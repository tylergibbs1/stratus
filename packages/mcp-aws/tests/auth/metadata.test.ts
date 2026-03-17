import { describe, expect, test } from "bun:test";
import { buildResourceMetadata, buildWwwAuthenticateHeader } from "../../src/auth/metadata.js";

describe("buildResourceMetadata", () => {
	test("builds metadata with defaults", () => {
		const metadata = buildResourceMetadata({
			baseUrl: "https://api.example.com",
			authorizationServers: ["https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123"],
		});

		expect(metadata.resource).toBe("https://api.example.com/mcp");
		expect(metadata.authorization_servers).toEqual([
			"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123",
		]);
		expect(metadata.bearer_methods_supported).toEqual(["header"]);
		expect(metadata.scopes_supported).toEqual(["openid"]);
	});

	test("builds metadata with custom path and scopes", () => {
		const metadata = buildResourceMetadata({
			baseUrl: "https://api.example.com",
			mcpPath: "/v1/mcp",
			authorizationServers: ["https://auth.example.com"],
			scopes: ["openid", "email", "profile"],
		});

		expect(metadata.resource).toBe("https://api.example.com/v1/mcp");
		expect(metadata.scopes_supported).toEqual(["openid", "email", "profile"]);
	});

	test("supports multiple authorization servers", () => {
		const metadata = buildResourceMetadata({
			baseUrl: "https://api.example.com",
			authorizationServers: ["https://auth1.example.com", "https://auth2.example.com"],
		});

		expect(metadata.authorization_servers.length).toBe(2);
	});
});

describe("buildWwwAuthenticateHeader", () => {
	test("includes resource_metadata URL", () => {
		const header = buildWwwAuthenticateHeader("https://api.example.com");
		expect(header).toBe(
			'Bearer realm="mcp-server", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
		);
	});

	test("works with different base URLs", () => {
		const header = buildWwwAuthenticateHeader("https://my-server.com:8080");
		expect(header).toContain("https://my-server.com:8080/.well-known/oauth-protected-resource");
	});
});
