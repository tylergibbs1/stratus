/**
 * Full-featured MCP server for AWS E2E testing.
 * Exercises: DynamoDB sessions, auth, gating, progressive disclosure, code mode.
 */
import { z } from "zod";
import { McpServer, apiKey, role, requires, rateLimit, all } from "../src/index.js";
import { DynamoSessionStore } from "../src/session/dynamo.js";

const server = new McpServer({
	name: "full-test",
	version: "1.0.0",
	codeMode: { enabled: true },
})
	.auth(
		apiKey({
			"admin-key": { subject: "admin", roles: ["admin", "user"] },
			"user-key": { subject: "user", roles: ["user"] },
			"noauth-key": { subject: "nobody", roles: [] },
		}),
	)

	// ── Always tier ─────────────────────────────────────────────────
	.tool("ping", async () => "pong")

	.tool(
		"get_time",
		{ description: "Get current server time" },
		async () => ({ time: new Date().toISOString(), epoch: Date.now() }),
	)

	.tool(
		"echo",
		{
			description: "Echo back the input",
			params: z.object({ message: z.string() }),
		},
		async ({ message }) => message,
	)

	// ── Discoverable tier ───────────────────────────────────────────
	.tool(
		"add",
		{
			description: "Add two numbers",
			params: z.object({ a: z.number(), b: z.number() }),
			tier: "discoverable",
			tags: ["math", "calculator"],
		},
		async ({ a, b }) => ({ result: a + b }),
	)

	.tool(
		"multiply",
		{
			description: "Multiply two numbers",
			params: z.object({ a: z.number(), b: z.number() }),
			tier: "discoverable",
			tags: ["math", "calculator"],
		},
		async ({ a, b }) => ({ result: a * b }),
	)

	// ── Gated tools ─────────────────────────────────────────────────
	.tool(
		"admin_action",
		{
			description: "Admin-only action",
			gate: role("admin"),
		},
		async () => "admin action executed",
	)

	.tool(
		"review_step",
		{
			description: "Review step — prerequisite for execute_step",
		},
		async () => "reviewed and approved",
	)

	.tool(
		"execute_step",
		{
			description: "Execute step — requires review_step first",
			tier: "hidden",
			gate: requires("review_step"),
		},
		async () => "executed successfully",
	)

	.tool(
		"rate_limited_tool",
		{
			description: "Rate limited to 2 calls per minute",
			gate: rateLimit({ max: 2, windowMs: 60_000 }),
		},
		async () => "ok",
	);

export const handler = server.lambda({
	sessionStore: new DynamoSessionStore({
		tableName: "stratus-mcp-test-sessions",
		region: "us-east-1",
		ttlSeconds: 300,
	}),
});

export { server };
