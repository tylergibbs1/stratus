import { describe, expect, test } from "bun:test";
import { computeRetryDelay } from "../../src/azure/retry";

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

	test("ignores invalid retry-after-ms values", () => {
		const headers = new Headers({ "retry-after-ms": "not-a-number" });
		const delay = computeRetryDelay(headers, 0);
		// Should fall through to exponential backoff
		expect(delay).toBeGreaterThanOrEqual(1000);
		expect(delay).toBeLessThanOrEqual(2000);
	});

	test("ignores zero or negative retry-after-ms", () => {
		const headers = new Headers({ "retry-after-ms": "0" });
		const delay = computeRetryDelay(headers, 0);
		expect(delay).toBeGreaterThanOrEqual(1000);
	});
});
