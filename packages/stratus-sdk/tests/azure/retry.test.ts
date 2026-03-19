import { describe, expect, test } from "bun:test";
import { abortableSleep, computeRetryDelay, isRetryableStatus } from "../../src/azure/retry";

describe("computeRetryDelay", () => {
	test("prefers retry-after-ms header", () => {
		const headers = new Headers({
			"retry-after-ms": "1500",
			"retry-after": "10",
		});
		expect(computeRetryDelay(headers, 0)).toBe(1500);
	});

	test("falls back to retry-after header (seconds → ms)", () => {
		const headers = new Headers({ "retry-after": "5" });
		expect(computeRetryDelay(headers, 0)).toBe(5000);
	});

	test("uses exponential backoff when no headers present", () => {
		const headers = new Headers();
		const delay0 = computeRetryDelay(headers, 0);
		// 1000 * 2^0 + jitter(0..1000) = 1000..2000
		expect(delay0).toBeGreaterThanOrEqual(1000);
		expect(delay0).toBeLessThanOrEqual(2000);

		const delay2 = computeRetryDelay(headers, 2);
		// 1000 * 2^2 + jitter(0..1000) = 4000..5000
		expect(delay2).toBeGreaterThanOrEqual(4000);
		expect(delay2).toBeLessThanOrEqual(5000);
	});

	test("caps exponential backoff at 30s", () => {
		const headers = new Headers();
		const delay = computeRetryDelay(headers, 20);
		expect(delay).toBeLessThanOrEqual(30000);
	});

	test("caps server-provided retry-after-ms at 30s", () => {
		const headers = new Headers({ "retry-after-ms": "120000" });
		expect(computeRetryDelay(headers, 0)).toBe(30000);
	});

	test("caps server-provided retry-after at 30s", () => {
		const headers = new Headers({ "retry-after": "86400" });
		expect(computeRetryDelay(headers, 0)).toBe(30000);
	});

	test("ignores invalid retry-after-ms values", () => {
		const headers = new Headers({ "retry-after-ms": "not-a-number" });
		const delay = computeRetryDelay(headers, 0);
		// Should fall through to exponential backoff
		expect(delay).toBeGreaterThanOrEqual(1000);
		expect(delay).toBeLessThanOrEqual(2000);
	});

	test("ignores zero or negative retry-after-ms", () => {
		const headersZero = new Headers({ "retry-after-ms": "0" });
		expect(computeRetryDelay(headersZero, 0)).toBeGreaterThanOrEqual(1000);

		const headersNeg = new Headers({ "retry-after-ms": "-500" });
		expect(computeRetryDelay(headersNeg, 0)).toBeGreaterThanOrEqual(1000);
	});
});

describe("abortableSleep", () => {
	test("resolves after delay", async () => {
		const start = Date.now();
		await abortableSleep(50);
		expect(Date.now() - start).toBeGreaterThanOrEqual(40);
	});

	test("resolves immediately if already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const start = Date.now();
		await abortableSleep(5000, controller.signal);
		expect(Date.now() - start).toBeLessThan(50);
	});

	test("resolves early when signal aborts during sleep", async () => {
		const controller = new AbortController();
		const start = Date.now();
		setTimeout(() => controller.abort(), 30);
		await abortableSleep(5000, controller.signal);
		expect(Date.now() - start).toBeLessThan(200);
	});
});

describe("isRetryableStatus", () => {
	test("returns true for transient error codes", () => {
		expect(isRetryableStatus(429)).toBe(true);
		expect(isRetryableStatus(500)).toBe(true);
		expect(isRetryableStatus(502)).toBe(true);
		expect(isRetryableStatus(503)).toBe(true);
	});

	test("returns false for non-retryable codes", () => {
		expect(isRetryableStatus(200)).toBe(false);
		expect(isRetryableStatus(400)).toBe(false);
		expect(isRetryableStatus(401)).toBe(false);
		expect(isRetryableStatus(403)).toBe(false);
		expect(isRetryableStatus(404)).toBe(false);
		expect(isRetryableStatus(501)).toBe(false);
	});
});
