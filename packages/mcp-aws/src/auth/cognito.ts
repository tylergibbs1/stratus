import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthContext } from "../types.js";
import type { AuthProvider, AuthRequest } from "./types.js";

export type CognitoAuthConfig = {
	userPoolId: string;
	region: string;
	audience?: string;
	rolesClaim?: string;
};

const UNAUTHENTICATED: AuthContext = {
	authenticated: false,
	roles: [],
	claims: {},
};

/**
 * Factory: create a Cognito JWT auth provider.
 *
 * @example
 * ```ts
 * server.auth(cognito({ userPoolId: "us-east-1_abc", region: "us-east-1" }));
 * ```
 */
export function cognito(config: CognitoAuthConfig): AuthProvider {
	return new CognitoAuth(config);
}

export class CognitoAuth implements AuthProvider {
	private readonly issuer: string;
	private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
	private readonly audience?: string;
	private readonly rolesClaim: string;

	constructor(config: CognitoAuthConfig) {
		this.issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
		const jwksUrl = new URL(`${this.issuer}/.well-known/jwks.json`);
		this.jwks = createRemoteJWKSet(jwksUrl);
		this.audience = config.audience;
		this.rolesClaim = config.rolesClaim ?? "cognito:groups";
	}

	async authenticate(request: AuthRequest): Promise<AuthContext> {
		const raw = request.headers.authorization ?? request.headers.Authorization;
		const value = Array.isArray(raw) ? raw[0] : raw;

		if (!value) {
			return UNAUTHENTICATED;
		}

		const token = value.startsWith("Bearer ") ? value.slice(7) : value;

		try {
			const { payload } = await jwtVerify(token, this.jwks, {
				issuer: this.issuer,
				audience: this.audience,
			});

			const rolesClaim = payload[this.rolesClaim];
			const roles = Array.isArray(rolesClaim)
				? rolesClaim.filter((r): r is string => typeof r === "string")
				: [];

			return {
				authenticated: true,
				subject: payload.sub,
				roles,
				claims: payload as Record<string, unknown>,
			};
		} catch {
			return UNAUTHENTICATED;
		}
	}
}
