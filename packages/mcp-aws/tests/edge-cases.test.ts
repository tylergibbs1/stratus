/**
 * Edge case tests — all local, no AWS deploys.
 * Covers every untested branch from the source code audit.
 */
import { describe, expect, test } from "bun:test";
import { normalizeCode, sanitizeToolName } from "../src/codemode/types.js";
import { getAuthContext, getSession } from "../src/context.js";
import { McpEventEmitter } from "../src/events.js";
import { McpServer } from "../src/server.js";
import { MemorySessionStore } from "../src/session/memory.js";
import { isBlockedUrl } from "../src/ssrf.js";
import { isToolResult, normalizeToolResult } from "../src/types.js";
import type { McpSession, ToolResult } from "../src/types.js";

// ── normalizeToolResult edge cases ──────────────────────────────

describe("normalizeToolResult edge cases", () => {
	test("null coerces to empty content", () => {
		const result = normalizeToolResult(null as unknown as undefined);
		expect(result.content).toEqual([]);
	});

	test("number coerces to JSON text", () => {
		const result = normalizeToolResult(42 as unknown as string);
		expect(result.content[0]).toEqual({ type: "text", text: "42" });
	});

	test("boolean coerces to JSON text", () => {
		const result = normalizeToolResult(true as unknown as string);
		expect(result.content[0]).toEqual({ type: "text", text: "true" });
	});

	test("empty array coerces to JSON text", () => {
		const result = normalizeToolResult([]);
		expect(result.content[0]).toEqual({ type: "text", text: "[]" });
	});

	test("ToolResult with empty content array passes through", () => {
		const input: ToolResult = { content: [] };
		const result = normalizeToolResult(input);
		expect(result).toBe(input); // same reference
	});

	test("ToolResult with isError passes through", () => {
		const input: ToolResult = { content: [{ type: "text", text: "err" }], isError: true };
		const result = normalizeToolResult(input);
		expect(result.isError).toBe(true);
	});
});

// ── isToolResult edge cases ─────────────────────────────────────

describe("isToolResult edge cases", () => {
	test("object with content that is not an array", () => {
		expect(isToolResult({ content: "not an array" })).toBe(false);
	});

	test("object with content array of non-ContentPart items", () => {
		expect(isToolResult({ content: [{ notType: "bad" }] })).toBe(false);
	});

	test("null is not a ToolResult", () => {
		expect(isToolResult(null)).toBe(false);
	});

	test("string is not a ToolResult", () => {
		expect(isToolResult("hello")).toBe(false);
	});

	test("array is not a ToolResult", () => {
		expect(isToolResult([1, 2, 3])).toBe(false);
	});
});

// ── parseNameVersion edge cases ─────────────────────────────────

describe("McpServer constructor edge cases", () => {
	test("scoped package name with @", () => {
		// "@scope/name@1.0" — lastIndexOf("@") finds the version @
		const server = new McpServer("@scope/name@1.0.0");
		expect(server.config.name).toBe("@scope/name");
		expect(server.config.version).toBe("1.0.0");
	});

	test("name with no version defaults to 0.0.0", () => {
		const server = new McpServer("simple-name");
		expect(server.config.name).toBe("simple-name");
		expect(server.config.version).toBe("0.0.0");
	});

	test("empty string", () => {
		const server = new McpServer("");
		expect(server.config.name).toBe("");
		expect(server.config.version).toBe("0.0.0");
	});
});

// ── Tool handler without timeout ────────────────────────────────

describe("Tool execution edge cases", () => {
	test("tool without timeout executes normally", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("no_timeout", async () => "works");

		const tool = server.getToolConfig("no_timeout")!;
		expect(tool.timeout).toBeUndefined();

		const handler = server.lambda();
		const result = (await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "no_timeout", arguments: {} },
			}),
		})) as { statusCode: number; body: string };

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content[0].text).toBe("works");
	});

	test("tool handler that throws returns error result", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("explode", async () => {
			throw new Error("boom");
		});

		const handler = server.lambda();
		const result = (await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "explode", arguments: {} },
			}),
		})) as { statusCode: number; body: string };

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content[0].text).toContain("boom");
		expect(body.result.isError).toBe(true);
	});

	test("tool handler returning undefined gives empty content", async () => {
		const server = new McpServer("test@1.0.0");
		server.tool("void_tool", async () => undefined);

		const handler = server.lambda();
		const result = (await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "void_tool", arguments: {} },
			}),
		})) as { statusCode: number; body: string };

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content).toEqual([]);
	});
});

// ── SSRF edge cases ─────────────────────────────────────────────

describe("SSRF edge cases", () => {
	test("IPv6 with brackets", () => {
		expect(isBlockedUrl("http://[::1]:8080/")).toBe(true);
	});

	test("IPv6 fc00 prefix", () => {
		expect(isBlockedUrl("http://[fc00::1]/")).toBe(true);
	});

	test("172.15.x.x is NOT private (just below range)", () => {
		expect(isBlockedUrl("http://172.15.0.1/")).toBe(false);
	});

	test("172.32.x.x is NOT private (just above range)", () => {
		expect(isBlockedUrl("http://172.32.0.1/")).toBe(false);
	});

	test("0.0.0.0 is blocked", () => {
		expect(isBlockedUrl("http://0.0.0.0/")).toBe(true);
	});

	test("URL with credentials is allowed if public", () => {
		expect(isBlockedUrl("https://user:pass@api.example.com/")).toBe(false);
	});

	test("Google metadata endpoint blocked", () => {
		expect(isBlockedUrl("http://metadata.google.internal/")).toBe(true);
	});
});

// ── Context edge cases ──────────────────────────────────────────

describe("Context edge cases", () => {
	test("getAuthContext outside request returns unauthenticated", () => {
		const auth = getAuthContext();
		expect(auth.authenticated).toBe(false);
		expect(auth.roles).toEqual([]);
		expect(auth.claims).toEqual({});
	});

	test("getSession outside request returns undefined", () => {
		expect(getSession()).toBeUndefined();
	});
});

// ── Events edge cases ───────────────────────────────────────────

describe("Events edge cases", () => {
	test("emit with no listeners doesn't throw", () => {
		const emitter = new McpEventEmitter();
		expect(() =>
			emitter.emit("tool:call", {
				toolName: "test",
				params: {},
				auth: { authenticated: false, roles: [], claims: {} },
				sessionId: "s1",
				timestamp: Date.now(),
			}),
		).not.toThrow();
	});

	test("listener that throws doesn't break other listeners", () => {
		const emitter = new McpEventEmitter();
		let secondCalled = false;

		emitter.on("tool:call", () => {
			throw new Error("bad listener");
		});
		emitter.on("tool:call", () => {
			secondCalled = true;
		});

		emitter.emit("tool:call", {
			toolName: "test",
			params: {},
			auth: { authenticated: false, roles: [], claims: {} },
			sessionId: "s1",
			timestamp: Date.now(),
		});

		expect(secondCalled).toBe(true);
	});

	test("off removes only the specified listener", () => {
		const emitter = new McpEventEmitter();
		let count = 0;
		const listener1 = () => count++;
		const listener2 = () => count++;

		emitter.on("tool:call", listener1);
		emitter.on("tool:call", listener2);
		emitter.off("tool:call", listener1);

		emitter.emit("tool:call", {
			toolName: "test",
			params: {},
			auth: { authenticated: false, roles: [], claims: {} },
			sessionId: "s1",
			timestamp: Date.now(),
		});

		expect(count).toBe(1);
	});
});

// ── MemorySessionStore edge cases ───────────────────────────────

describe("MemorySessionStore edge cases", () => {
	test("evictOldest with empty store doesn't crash", async () => {
		const store = new MemorySessionStore({ maxSessions: 0 });
		const session: McpSession = {
			id: "s1",
			visibleTools: new Set(),
			unlockedGates: new Set(),
			toolCallHistory: [],
			auth: { authenticated: false, roles: [], claims: {} },
			metadata: {},
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),
		};
		// maxSessions is 0, so set should try to evict but store is empty
		await expect(store.set(session)).resolves.toBeUndefined();
	});

	test("get updates lastAccessedAt", async () => {
		const store = new MemorySessionStore();
		const now = Date.now();
		const session: McpSession = {
			id: "s1",
			visibleTools: new Set(),
			unlockedGates: new Set(),
			toolCallHistory: [],
			auth: { authenticated: false, roles: [], claims: {} },
			metadata: {},
			createdAt: now,
			lastAccessedAt: now - 1000,
		};
		await store.set(session);

		const retrieved = await store.get("s1");
		expect(retrieved!.lastAccessedAt).toBeGreaterThan(now - 1000);
	});

	test("delete nonexistent key doesn't throw", async () => {
		const store = new MemorySessionStore();
		await expect(store.delete("nonexistent")).resolves.toBeUndefined();
	});
});

// ── normalizeCode edge cases ────────────────────────────────────

describe("normalizeCode edge cases", () => {
	test("code fence with ts language tag", () => {
		const code = "```ts\nasync () => 42\n```";
		const result = normalizeCode(code);
		expect(result).toBe("async () => 42");
	});

	test("code fence with tsx language tag", () => {
		const code = "```tsx\nasync () => 42\n```";
		const result = normalizeCode(code);
		expect(result).toBe("async () => 42");
	});

	test("already an async arrow with params", () => {
		const code = "async (x) => { return x + 1; }";
		expect(normalizeCode(code)).toBe(code);
	});
});

// ── sanitizeToolName edge cases ─────────────────────────────────

describe("sanitizeToolName edge cases", () => {
	test("name with only special characters", () => {
		// $ is a valid JS identifier character, so "@#$%" → "$"
		expect(sanitizeToolName("@#$%")).toBe("$");
	});

	test("name that is 'undefined'", () => {
		expect(sanitizeToolName("undefined")).toBe("undefined_");
	});

	test("name starting with $", () => {
		expect(sanitizeToolName("$tool")).toBe("$tool");
	});
});

// ── Lambda handler edge cases ───────────────────────────────────

describe("Lambda handler edge cases", () => {
	test("base64-encoded body is decoded", async () => {
		const server = new McpServer("test@1.0.0").tool("ping", async () => "pong");
		const handler = server.lambda();

		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "ping", arguments: {} },
		});

		const result = (await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			isBase64Encoded: true,
			body: Buffer.from(body).toString("base64"),
		})) as { statusCode: number; body: string };

		expect(result.statusCode).toBe(200);
		const parsed = JSON.parse(result.body);
		expect(parsed.result.content[0].text).toBe("pong");
	});

	test("missing body treated as empty", async () => {
		const server = new McpServer("test@1.0.0").tool("ping", async () => "pong");
		const handler = server.lambda();

		const result = (await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
		})) as { statusCode: number; body: string };

		// Empty body → MCP SDK returns 400 (bad request)
		expect(result.statusCode).toBe(400);
	});

	test("DELETE returns 405", async () => {
		const server = new McpServer("test@1.0.0").tool("ping", async () => "pong");
		const handler = server.lambda();

		const result = (await handler({
			headers: {},
			httpMethod: "DELETE",
			rawPath: "/",
		})) as { statusCode: number };

		expect(result.statusCode).toBe(405);
	});

	test("API Gateway v2 event format (requestContext.http)", async () => {
		const server = new McpServer("test@1.0.0").tool("ping", async () => "pong");
		const handler = server.lambda();

		const result = (await handler({
			headers: {},
			rawPath: "/mcp",
			requestContext: { http: { method: "POST", path: "/mcp" } },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ping", arguments: {} },
			}),
		})) as { statusCode: number; body: string };

		expect(result.statusCode).toBe(200);
	});

	test("search_tools with zero results", async () => {
		const server = new McpServer("test@1.0.0").tool("only_tool", async () => "ok");

		const handler = server.lambda();
		await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "search_tools", arguments: { query: "xyznonexistent" } },
			}),
		});

		// search_tools is only registered in progressive mode
		// "only_tool" is always-tier, so disclosure mode is "all" (no search_tools)
		// Let's test with a discoverable tool to force progressive mode
		const server2 = new McpServer("test@1.0.0")
			.tool("always_tool", async () => "ok")
			.tool("disc_tool", { tier: "discoverable" }, async () => "ok");

		const handler2 = server2.lambda();
		const result2 = (await handler2({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "search_tools", arguments: { query: "xyzzzzzz" } },
			}),
		})) as { statusCode: number; body: string };

		expect(result2.statusCode).toBe(200);
		const body = JSON.parse(result2.body);
		expect(body.result.content[0].text).toContain("No tools found");
	});
});
