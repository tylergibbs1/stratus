import { describe, expect, test } from "bun:test";
import {
	detectEndpointKind,
	resolveChatCompletionsUrl,
	resolveResponsesBaseUrl,
	resolveResponsesUrl,
} from "../../src/azure/endpoint";

describe("detectEndpointKind", () => {
	test("openai.azure.com → standard", () => {
		expect(detectEndpointKind("https://myresource.openai.azure.com")).toBe("standard");
	});

	test("cognitiveservices.azure.com → standard", () => {
		expect(detectEndpointKind("https://myresource.cognitiveservices.azure.com")).toBe("standard");
	});

	test("services.ai.azure.com → foundry", () => {
		expect(
			detectEndpointKind("https://myproject.services.ai.azure.com/api/projects/my-project"),
		).toBe("foundry");
	});

	test("full URL with /openai/deployments/ → full_url", () => {
		expect(
			detectEndpointKind(
				"https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-03-01-preview",
			),
		).toBe("full_url");
	});

	test("full URL with /openai/v1/responses → full_url", () => {
		expect(detectEndpointKind("https://myresource.openai.azure.com/openai/v1/responses")).toBe(
			"full_url",
		);
	});

	test("full URL with /openai/responses → full_url", () => {
		expect(
			detectEndpointKind(
				"https://myproject.services.ai.azure.com/api/projects/my-project/openai/responses?api-version=2025-03-01-preview",
			),
		).toBe("full_url");
	});

	test("unknown hostname → standard", () => {
		expect(detectEndpointKind("https://my-custom-proxy.example.com")).toBe("standard");
	});
});

describe("resolveChatCompletionsUrl", () => {
	test("standard endpoint", () => {
		const url = resolveChatCompletionsUrl(
			"https://myresource.openai.azure.com",
			"gpt-4o",
			"2025-03-01-preview",
		);
		expect(url).toBe(
			"https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-03-01-preview",
		);
	});

	test("foundry endpoint", () => {
		const url = resolveChatCompletionsUrl(
			"https://myproject.services.ai.azure.com/api/projects/my-project",
			"gpt-4o",
			"2025-03-01-preview",
		);
		expect(url).toBe(
			"https://myproject.services.ai.azure.com/api/projects/my-project/openai/deployments/gpt-4o/chat/completions?api-version=2025-03-01-preview",
		);
	});

	test("full URL passed through as-is", () => {
		const fullUrl =
			"https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-03-01-preview";
		const url = resolveChatCompletionsUrl(fullUrl, "ignored", "ignored");
		expect(url).toBe(fullUrl);
	});

	test("trailing slash normalized", () => {
		const url = resolveChatCompletionsUrl(
			"https://myresource.openai.azure.com/",
			"gpt-4o",
			"2025-03-01-preview",
		);
		expect(url).toBe(
			"https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-03-01-preview",
		);
	});
});

describe("resolveResponsesUrl", () => {
	test("standard endpoint", () => {
		const url = resolveResponsesUrl("https://myresource.openai.azure.com", "2025-04-01-preview");
		expect(url).toBe("https://myresource.openai.azure.com/openai/v1/responses");
	});

	test("cognitiveservices endpoint", () => {
		const url = resolveResponsesUrl(
			"https://myresource.cognitiveservices.azure.com",
			"2025-04-01-preview",
		);
		expect(url).toBe("https://myresource.cognitiveservices.azure.com/openai/v1/responses");
	});

	test("foundry endpoint", () => {
		const url = resolveResponsesUrl(
			"https://myproject.services.ai.azure.com/api/projects/my-project",
			"2025-04-01-preview",
		);
		expect(url).toBe(
			"https://myproject.services.ai.azure.com/api/projects/my-project/openai/responses?api-version=2025-04-01-preview",
		);
	});

	test("full URL passed through as-is", () => {
		const fullUrl = "https://myresource.openai.azure.com/openai/v1/responses";
		const url = resolveResponsesUrl(fullUrl, "ignored");
		expect(url).toBe(fullUrl);
	});

	test("trailing slash normalized", () => {
		const url = resolveResponsesUrl("https://myresource.openai.azure.com/", "2025-04-01-preview");
		expect(url).toBe("https://myresource.openai.azure.com/openai/v1/responses");
	});
});

describe("resolveResponsesBaseUrl", () => {
	test("standard endpoint", () => {
		const url = resolveResponsesBaseUrl(
			"https://myresource.openai.azure.com",
			"2025-04-01-preview",
		);
		expect(url).toBe("https://myresource.openai.azure.com/openai/v1/responses");
	});

	test("foundry endpoint includes api-version", () => {
		const url = resolveResponsesBaseUrl(
			"https://myproject.services.ai.azure.com",
			"2025-04-01-preview",
		);
		expect(url).toContain("api-version=2025-04-01-preview");
		expect(url).toContain("/openai/responses");
	});

	test("full_url with /responses strips trailing path", () => {
		const url = resolveResponsesBaseUrl(
			"https://myresource.openai.azure.com/openai/v1/responses",
			"ignored",
		);
		expect(url).toBe("https://myresource.openai.azure.com/openai/v1/responses");
	});

	test("full_url without /responses falls back to standard format", () => {
		const url = resolveResponsesBaseUrl(
			"https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
			"ignored",
		);
		expect(url).toBe("https://myresource.openai.azure.com/openai/v1/responses");
	});

	test("full_url with /openai/deployments/ but no /responses falls back", () => {
		const url = resolveResponsesBaseUrl(
			"https://myresource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-03-01",
			"ignored",
		);
		expect(url).toBe("https://myresource.openai.azure.com/openai/v1/responses");
	});
});
