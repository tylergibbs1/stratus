import type { AuthContext } from "../types.js";
import type { AuthProvider, AuthRequest } from "./types.js";

export type ApiKeyEntry = {
	subject?: string;
	roles?: string[];
	claims?: Record<string, unknown>;
};

export type ApiKeyAuthConfig = {
	keys: Record<string, ApiKeyEntry>;
	headerName?: string;
};

const UNAUTHENTICATED: AuthContext = {
	authenticated: false,
	roles: [],
	claims: {},
};

/**
 * Factory: create an API key auth provider.
 *
 * @example
 * ```ts
 * server.auth(apiKey({ "sk-123": { roles: ["admin"] } }));
 * ```
 */
export function apiKey(
	keys: Record<string, ApiKeyEntry>,
	opts?: { headerName?: string },
): AuthProvider {
	return new ApiKeyAuth({ keys, headerName: opts?.headerName });
}

export class ApiKeyAuth implements AuthProvider {
	private readonly keys: Record<string, ApiKeyEntry>;
	private readonly headerName: string;

	constructor(config: ApiKeyAuthConfig) {
		this.keys = config.keys;
		this.headerName = config.headerName ?? "x-api-key";
	}

	async authenticate(request: AuthRequest): Promise<AuthContext> {
		const raw = request.headers[this.headerName];
		const value = Array.isArray(raw) ? raw[0] : raw;

		if (!value) {
			return UNAUTHENTICATED;
		}

		const entry = this.keys[value];
		if (!entry) {
			return UNAUTHENTICATED;
		}

		return {
			authenticated: true,
			subject: entry.subject,
			roles: entry.roles ?? [],
			claims: entry.claims ?? {},
		};
	}
}
