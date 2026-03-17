import { describe, expect, test } from "bun:test";
import { assertSafeUrl, isBlockedUrl } from "../src/ssrf.js";

describe("isBlockedUrl", () => {
	test("blocks localhost", () => {
		expect(isBlockedUrl("http://localhost/api")).toBe(true);
		expect(isBlockedUrl("http://localhost:8080/api")).toBe(true);
	});

	test("blocks 127.0.0.1", () => {
		expect(isBlockedUrl("http://127.0.0.1/")).toBe(true);
		expect(isBlockedUrl("http://127.0.0.1:3000/")).toBe(true);
	});

	test("blocks 10.x.x.x (RFC 1918)", () => {
		expect(isBlockedUrl("http://10.0.0.1/")).toBe(true);
		expect(isBlockedUrl("http://10.255.255.255/")).toBe(true);
	});

	test("blocks 172.16-31.x.x (RFC 1918)", () => {
		expect(isBlockedUrl("http://172.16.0.1/")).toBe(true);
		expect(isBlockedUrl("http://172.31.255.255/")).toBe(true);
	});

	test("blocks 192.168.x.x (RFC 1918)", () => {
		expect(isBlockedUrl("http://192.168.1.1/")).toBe(true);
		expect(isBlockedUrl("http://192.168.0.100/")).toBe(true);
	});

	test("blocks AWS metadata endpoint", () => {
		expect(isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
	});

	test("blocks link-local (169.254.x.x)", () => {
		expect(isBlockedUrl("http://169.254.0.1/")).toBe(true);
	});

	test("blocks IPv6 loopback", () => {
		expect(isBlockedUrl("http://[::1]/")).toBe(true);
	});

	test("blocks non-HTTP schemes", () => {
		expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
		expect(isBlockedUrl("ftp://internal.server/")).toBe(true);
		expect(isBlockedUrl("gopher://evil.com/")).toBe(true);
	});

	test("blocks malformed URLs", () => {
		expect(isBlockedUrl("not-a-url")).toBe(true);
		expect(isBlockedUrl("")).toBe(true);
	});

	test("allows public HTTPS URLs", () => {
		expect(isBlockedUrl("https://api.example.com/data")).toBe(false);
		expect(isBlockedUrl("https://www.google.com/")).toBe(false);
		expect(isBlockedUrl("https://github.com/api/v3")).toBe(false);
	});

	test("allows public HTTP URLs", () => {
		expect(isBlockedUrl("http://httpbin.org/get")).toBe(false);
	});

	test("allows public IPs", () => {
		expect(isBlockedUrl("http://8.8.8.8/")).toBe(false);
		expect(isBlockedUrl("https://1.1.1.1/")).toBe(false);
	});
});

describe("assertSafeUrl", () => {
	test("throws for blocked URLs", () => {
		expect(() => assertSafeUrl("http://localhost/")).toThrow("SSRF blocked");
	});

	test("does not throw for safe URLs", () => {
		expect(() => assertSafeUrl("https://api.example.com/")).not.toThrow();
	});
});
