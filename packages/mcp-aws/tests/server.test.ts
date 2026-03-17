import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { apiKey } from "../src/auth/api-key.js";
import { role } from "../src/gating/gates.js";
import { McpServer } from "../src/server.js";

describe("McpServer", () => {
	// ── Constructor ──────────────────────────────────────────────────

	test("string constructor parses name@version", () => {
		const server = new McpServer("my-server@2.0.0");
		expect(server.config.name).toBe("my-server");
		expect(server.config.version).toBe("2.0.0");
	});

	test("string constructor defaults version when no @", () => {
		const server = new McpServer("my-server");
		expect(server.config.name).toBe("my-server");
		expect(server.config.version).toBe("0.0.0");
	});

	test("object constructor works", () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		expect(server.config.name).toBe("test");
	});

	// ── Tool Registration ───────────────────────────────────────────

	test("tool(name, handler) — simplest form", () => {
		const server = new McpServer("test@1.0.0");
		server.tool("ping", async () => "pong");
		expect(server.toolCount).toBe(1);
		expect(server.getToolConfig("ping")!.tier).toBe("always");
	});

	test("tool(name, zodSchema, handler)", () => {
		const server = new McpServer("test@1.0.0");
		server.tool("greet", z.object({ name: z.string() }), async ({ name }) => {
			return `Hello, ${name}!`;
		});
		expect(server.toolCount).toBe(1);
		expect(server.getToolConfig("greet")!.inputSchema).toBeDefined();
	});

	test("tool(name, options, handler) — full config", () => {
		const server = new McpServer("test@1.0.0");
		server.tool(
			"admin_reset",
			{
				description: "Reset user account",
				params: z.object({ userId: z.string() }),
				tier: "hidden",
				gate: role("admin"),
				timeout: 5000,
				tags: ["admin"],
			},
			async ({ userId }) => ({ reset: true, userId }),
		);
		const tool = server.getToolConfig("admin_reset")!;
		expect(tool.tier).toBe("hidden");
		expect(tool.gate).toBeDefined();
		expect(tool.timeout).toBe(5000);
		expect(tool.tags).toEqual(["admin"]);
	});

	test("tier defaults to 'always'", () => {
		const server = new McpServer("test@1.0.0");
		server.tool("a", { description: "A tool" }, async () => "ok");
		expect(server.getToolConfig("a")!.tier).toBe("always");
	});

	test("tool returns this for chaining", () => {
		const server = new McpServer("test@1.0.0");
		const result = server
			.tool("a", async () => "a")
			.tool("b", async () => "b")
			.tool("c", async () => "c");

		expect(result).toBe(server);
		expect(server.toolCount).toBe(3);
	});

	test("getToolConfig returns undefined for nonexistent", () => {
		const server = new McpServer("test@1.0.0");
		expect(server.getToolConfig("nope")).toBeUndefined();
	});

	// ── Auth ────────────────────────────────────────────────────────

	test("auth() returns this for chaining", () => {
		const server = new McpServer("test@1.0.0");
		const result = server.auth(apiKey({ "sk-123": {} }));
		expect(result).toBe(server);
	});

	test("full fluent chain", () => {
		const server = new McpServer("test@1.0.0")
			.auth(apiKey({ "sk-123": { roles: ["admin"] } }))
			.tool("ping", async () => "pong")
			.tool("greet", z.object({ name: z.string() }), async ({ name }) => `Hello, ${name}!`);

		expect(server.toolCount).toBe(2);
	});

	// ── Lambda Transport ────────────────────────────────────────────

	test("lambda() returns a function", () => {
		const server = new McpServer("test@1.0.0");
		server.tool("test", async () => "ok");
		const handler = server.lambda();
		expect(typeof handler).toBe("function");
	});

	test("lambda handler rejects GET with 405", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("test", async () => "ok");
		const handler = server.lambda();

		const result = (await handler({
			headers: {},
			httpMethod: "GET",
			path: "/mcp",
		})) as { statusCode: number };

		expect(result.statusCode).toBe(405);
	});

	test("lambda handler processes POST with JSON-RPC initialize", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("test", async () => "ok");
		const handler = server.lambda();

		const result = (await handler({
			headers: { "x-session-id": "s1" },
			httpMethod: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		})) as { statusCode: number; headers: Record<string, string>; body: string };

		expect(result.statusCode).toBe(200);
		expect(result.headers["x-session-id"]).toBe("s1");
		const body = JSON.parse(result.body);
		expect(body.result.serverInfo.name).toBe("test");
	});

	test("lambda 401 with WWW-Authenticate when auth fails", async () => {
		const server = new McpServer("test@1.0.0")
			.auth(apiKey({ "valid-key": { subject: "u1" } }))
			.tool("test", async () => "ok");

		const handler = server.lambda({ baseUrl: "https://api.example.com" });
		const result = (await handler({
			headers: { "x-api-key": "wrong" },
			httpMethod: "POST",
			body: "{}",
		})) as { statusCode: number; headers: Record<string, string> };

		expect(result.statusCode).toBe(401);
		expect(result.headers["WWW-Authenticate"]).toContain("resource_metadata");
		expect(result.headers["WWW-Authenticate"]).toContain("https://api.example.com");
	});

	test("lambda serves RFC 9728 metadata", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("test", async () => "ok");

		const handler = server.lambda({
			resourceMetadata: {
				baseUrl: "https://api.example.com",
				authorizationServers: ["https://auth.example.com"],
				scopes: ["openid", "email"],
			},
		});

		const result = (await handler({
			headers: {},
			httpMethod: "GET",
			path: "/.well-known/oauth-protected-resource",
		})) as { statusCode: number; body: string };

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.resource).toBe("https://api.example.com/mcp");
		expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
		expect(body.scopes_supported).toEqual(["openid", "email"]);
	});

	test("lambda passes auth through to session", async () => {
		const server = new McpServer("test@1.0.0")
			.auth(apiKey({ "good-key": { subject: "u1", roles: ["admin"] } }))
			.tool("test", async () => "ok");

		const handler = server.lambda();
		const result = (await handler({
			headers: { "x-api-key": "good-key" },
			httpMethod: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		})) as { statusCode: number };

		expect(result.statusCode).toBe(200);
	});

	// ── Express Transport ───────────────────────────────────────────

	test("express().setup mounts routes", () => {
		const server = new McpServer("test@1.0.0");
		server.tool("test", async () => "ok");

		const routes: { method: string; path: string }[] = [];
		const mockApp = {
			get: (path: string) => routes.push({ method: "get", path }),
			post: (path: string) => routes.push({ method: "post", path }),
			delete: (path: string) => routes.push({ method: "delete", path }),
		};

		server
			.express({
				mcpPath: "/v1/mcp",
				resourceMetadata: {
					baseUrl: "https://api.example.com",
					authorizationServers: ["https://auth.example.com"],
				},
			})
			.setup(mockApp);

		expect(routes).toContainEqual({ method: "get", path: "/.well-known/oauth-protected-resource" });
		expect(routes).toContainEqual({ method: "post", path: "/v1/mcp" });
		expect(routes).toContainEqual({ method: "get", path: "/v1/mcp" });
		expect(routes).toContainEqual({ method: "delete", path: "/v1/mcp" });
	});

	// ── Search ──────────────────────────────────────────────────────

	test("searchTools works after lambda build", () => {
		const server = new McpServer("test@1.0.0");
		server.tool("search_web", { description: "Search the web", tags: ["web"] }, async () => "ok");
		server.tool("read_file", { description: "Read a file" }, async () => "ok");
		server.lambda(); // triggers build

		const results = server.searchTools("web search");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.name).toBe("search_web");
	});

	// ── Disclosure Auto-Inference ───────────────────────────────────

	test("20 tools across tiers", () => {
		const server = new McpServer("test@1.0.0");
		for (let i = 0; i < 5; i++) server.tool(`always_${i}`, async () => `a${i}`);
		for (let i = 0; i < 10; i++)
			server.tool(`disc_${i}`, { tier: "discoverable", tags: ["data"] }, async () => `d${i}`);
		for (let i = 0; i < 5; i++)
			server.tool(`hidden_${i}`, { tier: "hidden", gate: role("admin") }, async () => `h${i}`);
		expect(server.toolCount).toBe(20);
	});

	test("code mode configuration", () => {
		const server = new McpServer({
			name: "test",
			version: "1.0.0",
			codeMode: { enabled: true, executor: "worker" },
		});
		expect(server.config.codeMode?.enabled).toBe(true);
	});
});
