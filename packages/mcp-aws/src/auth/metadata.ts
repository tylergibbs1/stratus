/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata.
 * Lets MCP clients discover which authorization server to use.
 */

export type ProtectedResourceMetadata = {
	resource: string;
	authorization_servers: string[];
	bearer_methods_supported?: string[];
	scopes_supported?: string[];
};

export type ResourceMetadataConfig = {
	/** The base URL of this MCP server (e.g. "https://api.example.com") */
	baseUrl: string;
	/** The MCP endpoint path (default: "/mcp") */
	mcpPath?: string;
	/** Authorization server URLs (e.g. Cognito issuer URL) */
	authorizationServers: string[];
	/** Supported scopes (default: ["openid"]) */
	scopes?: string[];
};

/**
 * Build the RFC 9728 Protected Resource Metadata document.
 */
export function buildResourceMetadata(config: ResourceMetadataConfig): ProtectedResourceMetadata {
	const mcpPath = config.mcpPath ?? "/mcp";
	return {
		resource: `${config.baseUrl}${mcpPath}`,
		authorization_servers: config.authorizationServers,
		bearer_methods_supported: ["header"],
		scopes_supported: config.scopes ?? ["openid"],
	};
}

/**
 * Build the WWW-Authenticate header value for a 401 response.
 * Includes the resource_metadata URL per RFC 9728.
 */
export function buildWwwAuthenticateHeader(baseUrl: string): string {
	const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
	return `Bearer realm="mcp-server", resource_metadata="${metadataUrl}"`;
}
