import { describe, expect, test } from "bun:test";
import {
	AuthenticationError,
	GateDeniedError,
	McpAwsError,
	SessionNotFoundError,
	ToolExecutionError,
	ToolTimeoutError,
} from "../src/errors.js";

describe("errors", () => {
	test("McpAwsError has correct name and message", () => {
		const err = new McpAwsError("test error");
		expect(err.name).toBe("McpAwsError");
		expect(err.message).toBe("test error");
		expect(err).toBeInstanceOf(Error);
	});

	test("GateDeniedError exposes fields", () => {
		const err = new GateDeniedError({
			toolName: "secret_tool",
			reason: "no access",
			hint: "try logging in",
		});
		expect(err.name).toBe("GateDeniedError");
		expect(err.toolName).toBe("secret_tool");
		expect(err.reason).toBe("no access");
		expect(err.hint).toBe("try logging in");
		expect(err).toBeInstanceOf(McpAwsError);
	});

	test("AuthenticationError", () => {
		const err = new AuthenticationError("bad token");
		expect(err.name).toBe("AuthenticationError");
		expect(err.message).toBe("bad token");
	});

	test("SessionNotFoundError exposes sessionId", () => {
		const err = new SessionNotFoundError("abc123");
		expect(err.sessionId).toBe("abc123");
		expect(err.message).toContain("abc123");
	});

	test("ToolExecutionError wraps cause", () => {
		const cause = new Error("disk full");
		const err = new ToolExecutionError("write_file", cause);
		expect(err.toolName).toBe("write_file");
		expect(err.cause).toBe(cause);
		expect(err.message).toContain("disk full");
	});

	test("ToolTimeoutError exposes timeout", () => {
		const err = new ToolTimeoutError("slow_tool", 5000);
		expect(err.toolName).toBe("slow_tool");
		expect(err.timeoutMs).toBe(5000);
		expect(err.message).toContain("5000ms");
	});
});
