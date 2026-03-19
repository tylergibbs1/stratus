import { describe, expect, test } from "bun:test";
import { McpClient } from "../../src/core/mcp-client";

describe("McpClient", () => {
	test("can be instantiated with minimal config", () => {
		const client = new McpClient({ command: "echo" });
		expect(client).toBeDefined();
	});

	test("can be instantiated with full config", () => {
		const client = new McpClient({
			command: "node",
			args: ["mcp-server.js"],
			env: { DEBUG: "true" },
			cwd: "/tmp",
		});
		expect(client).toBeDefined();
	});

	test("disconnect is safe to call without connect", async () => {
		const client = new McpClient({ command: "echo" });
		await client.disconnect();
	});

	test("disconnect can be called multiple times", async () => {
		const client = new McpClient({ command: "echo" });
		await client.disconnect();
		await client.disconnect();
	});

	test("listTools throws when not connected", async () => {
		const client = new McpClient({ command: "echo" });
		await expect(client.listTools()).rejects.toThrow("not connected");
	});

	test("callTool throws when not connected", async () => {
		const client = new McpClient({ command: "echo" });
		await expect(client.callTool("test", {})).rejects.toThrow("not connected");
	});

	test("getTools throws when not connected", async () => {
		const client = new McpClient({ command: "echo" });
		await expect(client.getTools()).rejects.toThrow("not connected");
	});

	test("Symbol.asyncDispose calls disconnect", async () => {
		const client = new McpClient({ command: "echo" });
		// Should not throw
		await client[Symbol.asyncDispose]();
	});
});
