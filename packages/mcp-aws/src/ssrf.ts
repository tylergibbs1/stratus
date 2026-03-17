/**
 * SSRF protection: block requests to private/internal IP ranges.
 * Prevents tools from accessing internal infrastructure via user-controlled URLs.
 */

const BLOCKED_RANGES = [
	// Loopback
	/^127\./,
	/^0\./,
	// Private networks (RFC 1918)
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	// Link-local
	/^169\.254\./,
	// IPv6
	/^::1$/,
	/^fc00:/i,
	/^fd[0-9a-f]{2}:/i,
	/^fe80:/i,
];

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.google",
	// AWS metadata
	"169.254.169.254",
	"fd00:ec2::254",
	// Azure metadata
	"169.254.169.253",
	// GCP metadata
	"metadata.google.internal",
]);

/**
 * Check if a URL targets a private/internal address.
 * Returns true if the URL should be blocked.
 *
 * @example
 * ```ts
 * import { isBlockedUrl } from "@stratus/mcp-aws";
 *
 * server.tool("fetch_url", z.object({ url: z.string() }), async ({ url }) => {
 *   if (isBlockedUrl(url)) return "Blocked: cannot access internal addresses";
 *   const res = await fetch(url);
 *   return res.text();
 * });
 * ```
 */
export function isBlockedUrl(url: string): boolean {
	try {
		const parsed = new URL(url);

		// Block non-HTTP(S) schemes
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return true;
		}

		const hostname = parsed.hostname.toLowerCase();

		// Check blocked hostnames
		if (BLOCKED_HOSTNAMES.has(hostname)) {
			return true;
		}

		// Check IP ranges
		for (const pattern of BLOCKED_RANGES) {
			if (pattern.test(hostname)) {
				return true;
			}
		}

		// Block if hostname resolves to a private range (bracket-stripped IPv6)
		const stripped = hostname.replace(/^\[|\]$/g, "");
		for (const pattern of BLOCKED_RANGES) {
			if (pattern.test(stripped)) {
				return true;
			}
		}

		return false;
	} catch {
		// Malformed URL — block it
		return true;
	}
}

/**
 * Validate a URL and throw if it targets a private/internal address.
 */
export function assertSafeUrl(url: string): void {
	if (isBlockedUrl(url)) {
		throw new Error(`SSRF blocked: "${url}" targets a private or internal address`);
	}
}
