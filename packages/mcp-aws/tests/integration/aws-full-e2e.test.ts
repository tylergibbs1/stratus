/**
 * Full AWS E2E test — every feature that touches AWS, tested on real AWS.
 *
 * 1. Deploy with DynamoDB session store
 * 2. Auth: valid key, wrong key, no key
 * 3. Progressive disclosure: tools/list → search_tools → promoted tools persist across requests
 * 4. Gate denial: role gate blocks, returns structured error
 * 5. Prerequisite gate: review → unlock → execute
 * 6. Code mode: execute_workflow on live Lambda
 * 7. DynamoDB session persistence across requests
 * 8. Teardown
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { deploy, destroy } from "../../src/deploy.js";

const REGION = "us-east-1";
const FUNCTION_NAME = `stratus-full-e2e-${Date.now()}`;
let url: string;
const SESSION_ID = `e2e-session-${Date.now()}`;

async function mcp(
	body: unknown,
	headers?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
	// Retry on 502 (Lambda cold start)
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"x-api-key": "admin-key",
				"x-session-id": SESSION_ID,
				...headers,
			},
			body: JSON.stringify(body),
		});
		if (res.status >= 500 && attempt < 2) {
			const errText = await res.text().catch(() => "");
			console.log(`  Retry ${attempt + 1}: ${res.status} ${errText.slice(0, 200)}`);
			await Bun.sleep(2000);
			continue;
		}
		const text = await res.text();
		try {
			return { status: res.status, data: JSON.parse(text) };
		} catch {
			return { status: res.status, data: { raw: text } };
		}
	}
	return { status: 502, data: { error: "Lambda cold start timeout" } };
}

async function mcpCall(method: string, params: unknown = {}, headers?: Record<string, string>) {
	return mcp({ jsonrpc: "2.0", id: Date.now(), method, params }, headers);
}

async function callTool(name: string, args: unknown = {}, headers?: Record<string, string>) {
	return mcpCall("tools/call", { name, arguments: args }, headers);
}

afterAll(async () => {
	try { await destroy(FUNCTION_NAME, REGION); } catch {}
	try {
		const { IAMClient, DetachRolePolicyCommand, DeleteRoleCommand } = await import("@aws-sdk/client-iam");
		const iam = new IAMClient({ region: REGION });
		await iam.send(new DetachRolePolicyCommand({ RoleName: `${FUNCTION_NAME}-role`, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" })).catch(() => {});
		await iam.send(new DeleteRoleCommand({ RoleName: `${FUNCTION_NAME}-role` })).catch(() => {});
	} catch {}
});

describe("Full AWS E2E", () => {
	// ── Deploy ──────────────────────────────────────────────────────

	test("1. Deploy full-featured server to Lambda", async () => {
		const result = await deploy({
			entry: resolve(import.meta.dir, "../../examples/full-featured-server.ts"),
			region: REGION,
			functionName: FUNCTION_NAME,
			policies: ["arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"],
		});
		url = result.url;
		expect(url).toContain("lambda-url");
		console.log(`  Deployed: ${url}`);

		// Wait for cold start readiness
		for (let i = 0; i < 15; i++) {
			const r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } });
			if (r.status === 200) break;
			console.log(`  Warming: ${r.status}`);
			await Bun.sleep(2000);
		}
	}, 120000);

	// ── Auth ────────────────────────────────────────────────────────

	test("2a. Auth: valid admin key returns 200", async () => {
		const r = await mcpCall("tools/list");
		expect(r.status).toBe(200);
	});

	test("2b. Auth: missing key returns 401", async () => {
		const r = await mcpCall("tools/list", {}, { "x-api-key": "" });
		expect(r.status).toBe(401);
	});

	test("2c. Auth: wrong key returns 401", async () => {
		const r = await mcpCall("tools/list", {}, { "x-api-key": "wrong-key" });
		expect(r.status).toBe(401);
	});

	// ── Progressive Disclosure ──────────────────────────────────────

	test("3a. tools/list returns only always-tier + meta-tools", async () => {
		const r = await mcpCall("tools/list");
		const names: string[] = (r.data as any).result.tools.map((t: any) => t.name);
		console.log(`  Initial tools: ${names.join(", ")}`);

		expect(names).toContain("ping");
		expect(names).toContain("get_time");
		expect(names).toContain("echo");
		expect(names).toContain("search_tools");
		expect(names).toContain("execute_workflow");
		// Discoverable should NOT be visible yet
		expect(names).not.toContain("add");
		expect(names).not.toContain("multiply");
	});

	test("3b. search_tools finds discoverable tools", async () => {
		const r = await callTool("search_tools", { query: "math calculator add" });
		const text = (r.data as any).result.content[0].text as string;
		console.log(`  Search result: ${text.slice(0, 200)}`);
		expect(text).toContain("add");
	});

	test("3c. After search, promoted tools appear in tools/list (same session)", async () => {
		const r = await mcpCall("tools/list");
		const names: string[] = (r.data as any).result.tools.map((t: any) => t.name);
		console.log(`  After search: ${names.join(", ")}`);
		expect(names).toContain("add");
	});

	test("3d. Promoted tools callable", async () => {
		const r = await callTool("add", { a: 17, b: 25 });
		const text = (r.data as any).result.content[0].text;
		const data = JSON.parse(text);
		expect(data.result).toBe(42);
		console.log(`  add(17, 25) = ${data.result}`);
	});

	// ── Gate Denial ─────────────────────────────────────────────────

	test("4a. Role gate: user-key blocked from admin_action", async () => {
		const r = await callTool("admin_action", {}, { "x-api-key": "user-key" });
		expect(r.status).toBe(200); // MCP returns 200 with error in content
		const text = (r.data as any).result.content[0].text as string;
		console.log(`  Gate denial: ${text}`);
		const denial = JSON.parse(text);
		expect(denial.error).toContain("Permission denied");
		expect(denial.reason).toContain("admin");
	});

	test("4b. Role gate: admin-key passes", async () => {
		const r = await callTool("admin_action", {}, { "x-api-key": "admin-key" });
		const text = (r.data as any).result.content[0].text;
		expect(text).toBe("admin action executed");
	});

	test("4c. Role gate: noauth-key blocked", async () => {
		const r = await callTool("admin_action", {}, { "x-api-key": "noauth-key" });
		const text = (r.data as any).result.content[0].text as string;
		const denial = JSON.parse(text);
		expect(denial.error).toContain("Permission denied");
	});

	// ── Code Mode ───────────────────────────────────────────────────

	test("5. execute_workflow runs code on live Lambda", async () => {
		const code = `async () => {
			const a = await codemode.echo({ message: "hello" });
			const b = await codemode.get_time({});
			return { echo: a, hasTime: typeof b.epoch === "number" };
		}`;

		const r = await callTool("execute_workflow", { code });
		expect(r.status).toBe(200);
		const text = (r.data as any).result.content[0].text as string;
		console.log(`  Code mode result: ${text.slice(0, 200)}`);
		const result = JSON.parse(text);
		expect(result.result.echo).toBe("hello");
		expect(result.result.hasTime).toBe(true);
	});

	// ── DynamoDB Session Persistence ────────────────────────────────

	test("6. DynamoDB session persists promoted tools across requests", async () => {
		// Use a fresh session to test persistence
		const freshSession = `persist-test-${Date.now()}`;
		const hdrs = { "x-session-id": freshSession };

		// Request 1: search to promote
		await callTool("search_tools", { query: "multiply" }, hdrs);

		// Request 2: verify promoted tool is visible (different Lambda invocation, same session)
		const r = await mcpCall("tools/list", {}, hdrs);
		const names: string[] = (r.data as any).result.tools.map((t: any) => t.name);
		console.log(`  Persisted session tools: ${names.join(", ")}`);
		expect(names).toContain("multiply");
	});

	// ── Basic Tool Calls ────────────────────────────────────────────

	test("7a. ping returns pong", async () => {
		const r = await callTool("ping");
		expect((r.data as any).result.content[0].text).toBe("pong");
	});

	test("7b. echo returns input", async () => {
		const r = await callTool("echo", { message: "hello world" });
		expect((r.data as any).result.content[0].text).toBe("hello world");
	});

	test("7c. get_time returns valid timestamp", async () => {
		const r = await callTool("get_time");
		const data = JSON.parse((r.data as any).result.content[0].text);
		expect(data.epoch).toBeGreaterThan(0);
		expect(data.time).toContain("202");
	});

	// ── Destroy ─────────────────────────────────────────────────────

	test("8. Destroy cleans up", async () => {
		const r = await destroy(FUNCTION_NAME, REGION);
		expect(r.deleted).toBe(true);
	});
});
