/**
 * Tests that server.lambda() actually processes MCP JSON-RPC requests.
 * Simulates Lambda Function URL events with real JSON-RPC payloads.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpServer } from "../../src/server.js";

type LambdaResult = {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
};

function lambdaEvent(body: unknown, headers?: Record<string, string>) {
	return {
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		httpMethod: "POST",
		rawPath: "/mcp",
		requestContext: {
			requestId: "test-req-1",
			http: { method: "POST", path: "/mcp" },
		},
	};
}

describe("Lambda JSON-RPC handler", () => {
	function createServer() {
		return new McpServer("lambda-test@1.0.0")
			.tool("greet", z.object({ name: z.string() }), async ({ name }) => `Hello, ${name}!`)
			.tool("add", z.object({ a: z.number(), b: z.number() }), async ({ a, b }) => String(a + b))
			.tool("ping", async () => "pong");
	}

	test("initialize request returns server info", async () => {
		const server = createServer();
		const handler = server.lambda();

		const result = (await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		expect(body.result.serverInfo.name).toBe("lambda-test");
	});

	test("tools/list returns registered tools", async () => {
		const server = createServer();
		const handler = server.lambda();

		// Must initialize first
		await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		);

		const result = (await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.tools.length).toBe(3);
		const names = body.result.tools.map((t: { name: string }) => t.name).sort();
		expect(names).toEqual(["add", "greet", "ping"]);
	});

	test("tools/call executes tool and returns result", async () => {
		const server = createServer();
		const handler = server.lambda();

		// Initialize
		await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		);

		// Call greet tool
		const result = (await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "greet",
					arguments: { name: "Stratus" },
				},
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content).toEqual([{ type: "text", text: "Hello, Stratus!" }]);
	});

	test("tools/call with add tool returns computation", async () => {
		const server = createServer();
		const handler = server.lambda();

		await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		);

		const result = (await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: {
					name: "add",
					arguments: { a: 17, b: 25 },
				},
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content).toEqual([{ type: "text", text: "42" }]);
	});

	test("tools/call with no-arg tool works", async () => {
		const server = createServer();
		const handler = server.lambda();

		await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		);

		const result = (await handler(
			lambdaEvent({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "ping", arguments: {} },
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content).toEqual([{ type: "text", text: "pong" }]);
	});

	test("GET returns 405", async () => {
		const server = createServer();
		const handler = server.lambda();
		const result = (await handler({
			headers: {},
			httpMethod: "GET",
			rawPath: "/mcp",
		})) as LambdaResult;
		expect(result.statusCode).toBe(405);
	});

	test("auth failure returns 401 with WWW-Authenticate", async () => {
		const { apiKey } = await import("../../src/auth/api-key.js");
		const server = createServer().auth(apiKey({ "valid-key": {} }));
		const handler = server.lambda({ baseUrl: "https://example.com" });

		const result = (await handler(
			lambdaEvent(
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{ "x-api-key": "wrong" },
			),
		)) as LambdaResult;

		expect(result.statusCode).toBe(401);
		expect(result.headers["WWW-Authenticate"]).toContain("resource_metadata");
	});
});
