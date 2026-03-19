/**
 * Computes how long to wait before retrying a 429'd request.
 *
 * Prefers the more precise `retry-after-ms` header (milliseconds) that Azure
 * returns alongside the standard `retry-after` (seconds). Falls back to
 * exponential backoff with jitter when neither header is present.
 */
export function computeRetryDelay(headers: Headers, attempt: number): number {
	// Azure-specific: millisecond precision
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const ms = Number.parseInt(retryAfterMs, 10);
		if (!Number.isNaN(ms) && ms > 0) return ms;
	}

	// Standard header: seconds
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseInt(retryAfter, 10);
		if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
	}

	// Exponential backoff with jitter, capped at 30s
	return Math.min(1000 * 2 ** attempt + Math.random() * 1000, 30000);
}
