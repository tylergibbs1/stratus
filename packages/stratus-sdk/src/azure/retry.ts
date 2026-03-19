const MAX_RETRY_DELAY_MS = 30_000;

/** Status codes that are safe to retry — transient Azure errors. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

/** Returns true if the HTTP status code is a transient error worth retrying. */
export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Computes how long to wait before retrying a 429'd request.
 *
 * Prefers the more precise `retry-after-ms` header (milliseconds) that Azure
 * returns alongside the standard `retry-after` (seconds). Falls back to
 * exponential backoff with jitter when neither header is present.
 *
 * All values are capped at {@link MAX_RETRY_DELAY_MS} to prevent a misbehaving
 * server from stalling the caller indefinitely.
 */
export function computeRetryDelay(headers: Headers, attempt: number): number {
	// Azure-specific: millisecond precision
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const ms = Number.parseInt(retryAfterMs, 10);
		if (!Number.isNaN(ms) && ms > 0) return Math.min(ms, MAX_RETRY_DELAY_MS);
	}

	// Standard header: seconds
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseInt(retryAfter, 10);
		if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
	}

	// Exponential backoff with jitter, capped at 30s
	return Math.min(1000 * 2 ** attempt + Math.random() * 1000, MAX_RETRY_DELAY_MS);
}

/**
 * Sleeps for `ms` milliseconds, but resolves immediately if `signal` is aborted.
 * This ensures retry backoff doesn't block an aborted request.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
