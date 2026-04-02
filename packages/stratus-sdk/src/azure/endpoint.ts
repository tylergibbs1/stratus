export type AzureEndpointKind = "standard" | "foundry" | "full_url";

/**
 * Detect the kind of Azure endpoint from a URL string.
 *
 * - If the URL path contains `/openai/deployments/`, `/openai/responses`, or `/openai/v1/` → full_url
 * - If the hostname ends with `.services.ai.azure.com` → foundry
 * - Everything else (openai.azure.com, cognitiveservices.azure.com, unknown) → standard
 */
export function detectEndpointKind(endpoint: string): AzureEndpointKind {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "standard";
	}

	const path = url.pathname;
	if (
		path.includes("/openai/deployments/") ||
		path.includes("/openai/responses") ||
		path.includes("/openai/v1/") ||
		path.includes("/models/")
	) {
		return "full_url";
	}

	if (url.hostname.endsWith(".services.ai.azure.com")) {
		return "foundry";
	}

	return "standard";
}

/**
 * Resolve the full URL for Azure Chat Completions API.
 */
export function resolveChatCompletionsUrl(
	endpoint: string,
	deployment: string,
	apiVersion: string,
): string {
	const normalized = endpoint.replace(/\/$/, "");
	const kind = detectEndpointKind(normalized);

	switch (kind) {
		case "full_url":
			return normalized;
		case "standard":
		case "foundry":
			return `${normalized}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
	}
}

/**
 * Resolve the full URL for Azure Responses API.
 */
export function resolveResponsesUrl(endpoint: string, apiVersion: string): string {
	const normalized = endpoint.replace(/\/$/, "");
	const kind = detectEndpointKind(normalized);

	switch (kind) {
		case "full_url":
			return normalized;
		case "foundry":
			return `${normalized}/openai/responses?api-version=${apiVersion}`;
		case "standard":
			return `${normalized}/openai/v1/responses`;
	}
}

/**
 * Resolve the base URL prefix for Responses API sub-endpoints (compact, retrieve, delete, etc.).
 * Returns the base without a trailing path so callers can append `/compact`, `/{id}`, etc.
 */
export function resolveResponsesBaseUrl(endpoint: string, apiVersion: string): string {
	const normalized = endpoint.replace(/\/$/, "");
	const kind = detectEndpointKind(normalized);

	switch (kind) {
		case "full_url":
			// Strip any trailing sub-path so we get back to the /responses root
			return normalized.replace(/\/responses.*$/, "/responses");
		case "foundry":
			return `${normalized}/openai/responses?api-version=${apiVersion}`;
		case "standard":
			return `${normalized}/openai/v1/responses`;
	}
}
