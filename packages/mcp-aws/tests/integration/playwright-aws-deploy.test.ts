/**
 * Real-world test: Playwright MCP server deployed via @stratus/mcp-aws
 *
 * Tests the FULL stack:
 * 1. server.lambda() produces a working handler
 * 2. initialize → tools/list → tools/call through the Lambda handler
 * 3. Progressive disclosure: only 3 always-tier tools returned initially
 * 4. search_tools promotes discoverable tools
 * 5. Auth: API key required
 * 6. 18 tools across 3 tiers
 */
import { describe, expect, test } from "bun:test";
import { handler, server } from "../../examples/playwright-server.js";

type LambdaResult = {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
};

function post(body: unknown, headers?: Record<string, string>): unknown {
	return {
		headers: {
			"content-type": "application/json",
			"x-api-key": "demo-key",
			"x-session-id": "test-session-1",
			...headers,
		},
		httpMethod: "POST",
		rawPath: "/mcp",
		body: JSON.stringify(body),
		requestContext: { http: { method: "POST", path: "/mcp" } },
	};
}

const INIT_REQUEST = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "test-client", version: "1.0.0" },
	},
};

describe("Playwright MCP via server.lambda()", () => {
	test("server has 19 tools across 3 tiers", () => {
		expect(server.toolCount).toBe(19);
	});

	test("initialize returns server info", async () => {
		const result = (await handler(post(INIT_REQUEST))) as LambdaResult;
		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.serverInfo.name).toBe("playwright-mcp");
		expect(body.result.serverInfo.version).toBe("1.0.0");
	});

	test("tools/list returns ONLY always-tier tools + search_tools (progressive mode)", async () => {
		const result = (await handler(
			post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		)) as LambdaResult;
		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		const names: string[] = body.result.tools.map((t: { name: string }) => t.name).sort();

		// Progressive mode: should have 3 always tools + search_tools meta-tool
		expect(names).toContain("browser_navigate");
		expect(names).toContain("browser_snapshot");
		expect(names).toContain("browser_close");
		expect(names).toContain("search_tools");
		// Should NOT contain discoverable or hidden tools
		expect(names).not.toContain("browser_click");
		expect(names).not.toContain("browser_console_messages");
		expect(names).not.toContain("browser_evaluate");
	});

	test("tools/call browser_navigate returns structured result", async () => {
		const result = (await handler(
			post({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "browser_navigate", arguments: { url: "https://example.com" } },
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		const content = body.result.content[0];
		expect(content.type).toBe("text");
		const data = JSON.parse(content.text);
		expect(data.navigated).toBe(true);
		expect(data.url).toBe("https://example.com");
	});

	test("tools/call browser_snapshot returns page structure", async () => {
		const result = (await handler(
			post({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "browser_snapshot", arguments: {} },
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		const data = JSON.parse(body.result.content[0].text);
		expect(data.title).toBe("Example Page");
		expect(data.elements.length).toBe(3);
	});

	test("search_tools finds discoverable tools", async () => {
		const result = (await handler(
			post({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "search_tools", arguments: { query: "click form input" } },
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		const text: string = body.result.content[0].text;
		expect(text).toContain("Found");
		expect(text).toContain("browser_click");
	});

	test("after search, promoted tools appear in tools/list", async () => {
		// Search first to promote tools
		await handler(
			post({
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: { name: "search_tools", arguments: { query: "click" } },
			}),
		);

		// Now tools/list should include promoted tools
		const result = (await handler(
			post({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
		// browser_click should now be visible after search promoted it
		expect(names).toContain("browser_click");
	});

	test("auth required: missing API key returns 401", async () => {
		const result = (await handler({
			headers: { "content-type": "application/json" },
			httpMethod: "POST",
			rawPath: "/mcp",
			body: JSON.stringify(INIT_REQUEST),
			requestContext: { http: { method: "POST", path: "/mcp" } },
		})) as LambdaResult;

		expect(result.statusCode).toBe(401);
	});

	test("auth required: wrong API key returns 401", async () => {
		const result = (await handler(
			post(INIT_REQUEST, { "x-api-key": "wrong-key" }),
		)) as LambdaResult;
		expect(result.statusCode).toBe(401);
	});

	test("tools/call on discoverable tool after search works", async () => {
		// Search to promote browser_fill_form
		await handler(
			post({
				jsonrpc: "2.0",
				id: 20,
				method: "tools/call",
				params: { name: "search_tools", arguments: { query: "fill form" } },
			}),
		);

		// Now call the promoted tool
		const result = (await handler(
			post({
				jsonrpc: "2.0",
				id: 21,
				method: "tools/call",
				params: {
					name: "browser_fill_form",
					arguments: { element: "Email input", value: "test@example.com" },
				},
			}),
		)) as LambdaResult;

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.result.content[0].text).toContain("Filled");
		expect(body.result.content[0].text).toContain("test@example.com");
	});
});
