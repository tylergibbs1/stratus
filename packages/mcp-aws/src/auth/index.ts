import type { AuthContext } from "../types.js";
import type { AuthProvider, AuthRequest } from "./types.js";

export { apiKey, ApiKeyAuth, type ApiKeyAuthConfig, type ApiKeyEntry } from "./api-key.js";
export { cognito, CognitoAuth, type CognitoAuthConfig } from "./cognito.js";
export {
	buildResourceMetadata,
	buildWwwAuthenticateHeader,
	type ProtectedResourceMetadata,
	type ResourceMetadataConfig,
} from "./metadata.js";
export type { AuthProvider, AuthRequest } from "./types.js";

/**
 * Tries each provider in order. Returns the first successful (authenticated) result.
 * If none succeed, returns unauthenticated.
 */
export function chainAuth(...providers: AuthProvider[]): AuthProvider {
	return {
		async authenticate(request: AuthRequest): Promise<AuthContext> {
			for (const provider of providers) {
				const result = await provider.authenticate(request);
				if (result.authenticated) {
					return result;
				}
			}
			return { authenticated: false, roles: [], claims: {} };
		},
	};
}
