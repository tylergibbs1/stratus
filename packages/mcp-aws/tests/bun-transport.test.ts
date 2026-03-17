import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpServer } from "../src/server.js";

describe("Bun.serve() transport", () => {
	let bunServer: { stop: () => void; url: string } | undefined;

	afterAll(() => {
		bunServer?.stop();
	});

	test("server.bun() starts and responds to MCP requests", async () => {
		const server = new McpServer("bun-test@1.0.0")
			.tool("ping", async () => "pong")
			.tool("add", z.object({ a: z.number(), b: z.number() }), async ({ a, b }) => String(a + b));

		bunServer = server.bun({ port: 0 }); // port 0 = random available port
		// Bun.serve with port 0 picks a random port — get it from the URL
		// Actually Bun.serve doesn't support port 0 like Node. Use a fixed port.
		bunServer.stop();

		bunServer = server.bun({ port: 9876 });
		const url = bunServer.url;
		expect(url).toContain("9876");

		// Initialize
		const initRes = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0" },
				},
			}),
		});
		expect(initRes.status).toBe(200);
		const init = await initRes.json();
		expect(init.result.serverInfo.name).toBe("bun-test");

		// List tools
		const listRes = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		});
		const list = await listRes.json();
		const names = list.result.tools.map((t: { name: string }) => t.name).sort();
		expect(names).toEqual(["add", "ping"]);

		// Call tool
		const callRes = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "add", arguments: { a: 17, b: 25 } },
			}),
		});
		const call = await callRes.json();
		expect(call.result.content[0].text).toBe("42");
	});

	test("GET returns 405", async () => {
		if (!bunServer) return;
		const res = await fetch(bunServer.url, { method: "GET" });
		expect(res.status).toBe(405);
	});

	test("wrong path returns 404", async () => {
		if (!bunServer) return;
		const res = await fetch(bunServer.url.replace("/mcp", "/wrong"), { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("auth blocks unauthenticated requests", async () => {
		const authServer = new McpServer("auth-test@1.0.0")
			.auth({ authenticate: async () => ({ authenticated: false, roles: [], claims: {} }) })
			.tool("ping", async () => "pong");

		const bs = authServer.bun({ port: 9877 });

		try {
			const res = await fetch(bs.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			});
			expect(res.status).toBe(401);
		} finally {
			bs.stop();
		}
	});
});
