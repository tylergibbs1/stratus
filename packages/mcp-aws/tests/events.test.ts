import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpServer } from "../src/server.js";

describe("McpServer events", () => {
	test("on() returns this for chaining", () => {
		const server = new McpServer("test@1.0.0");
		const result = server.on("tool:call", () => {});
		expect(result).toBe(server);
	});

	test("tool:call event fires with correct data", async () => {
		const events: unknown[] = [];
		const server = new McpServer("test@1.0.0")
			.on("tool:call", (e) => events.push(e))
			.tool("ping", async () => "pong");

		// Trigger via Lambda handler
		const handler = server.lambda();
		await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ping", arguments: {} },
			}),
		});

		expect(events.length).toBe(1);
		const e = events[0] as { toolName: string; timestamp: number };
		expect(e.toolName).toBe("ping");
		expect(e.timestamp).toBeGreaterThan(0);
	});

	test("tool:result event fires after tool completes", async () => {
		const results: unknown[] = [];
		const server = new McpServer("test@1.0.0")
			.on("tool:result", (e) => results.push(e))
			.tool("add", z.object({ a: z.number(), b: z.number() }), async ({ a, b }) => String(a + b));

		const handler = server.lambda();
		await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "add", arguments: { a: 1, b: 2 } },
			}),
		});

		expect(results.length).toBe(1);
		const e = results[0] as { toolName: string; durationMs: number; isError: boolean };
		expect(e.toolName).toBe("add");
		expect(e.isError).toBe(false);
		expect(e.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("multiple listeners receive events", async () => {
		let count = 0;
		const server = new McpServer("test@1.0.0")
			.on("tool:call", () => count++)
			.on("tool:call", () => count++)
			.tool("ping", async () => "pong");

		const handler = server.lambda();
		await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ping", arguments: {} },
			}),
		});

		expect(count).toBe(2);
	});

	test("off() removes listener", async () => {
		let count = 0;
		const listener = () => count++;
		const server = new McpServer("test@1.0.0")
			.on("tool:call", listener)
			.tool("ping", async () => "pong");

		server.off("tool:call", listener);

		const handler = server.lambda();
		await handler({
			headers: {},
			httpMethod: "POST",
			rawPath: "/",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ping", arguments: {} },
			}),
		});

		expect(count).toBe(0);
	});
});
