import { describe, expect, test } from "bun:test";
import {
	codeInterpreterTool,
	imageGenerationTool,
	mcpTool,
	webSearchTool,
} from "../../src/core/builtin-tools";

describe("webSearchTool", () => {
	test("returns hosted tool with correct defaults", () => {
		const t = webSearchTool();
		expect(t.type).toBe("hosted");
		expect(t.name).toBe("web_search_preview");
		expect(t.definition).toEqual({ type: "web_search_preview" });
	});

	test("accepts userLocation config", () => {
		const t = webSearchTool({
			userLocation: {
				type: "approximate",
				city: "Seattle",
				state: "WA",
				country: "US",
			},
		});
		expect(t.definition).toEqual({
			type: "web_search_preview",
			user_location: {
				type: "approximate",
				city: "Seattle",
				state: "WA",
				country: "US",
			},
		});
	});

	test("accepts searchContextSize config", () => {
		const t = webSearchTool({ searchContextSize: "high" });
		expect(t.definition).toEqual({
			type: "web_search_preview",
			search_context_size: "high",
		});
	});
});

describe("codeInterpreterTool", () => {
	test("returns hosted tool with default container", () => {
		const t = codeInterpreterTool();
		expect(t.type).toBe("hosted");
		expect(t.name).toBe("code_interpreter");
		expect(t.definition).toEqual({
			type: "code_interpreter",
			container: { type: "auto" },
		});
	});

	test("accepts custom container config", () => {
		const t = codeInterpreterTool({ container: { type: "custom-id" } });
		expect(t.definition).toEqual({
			type: "code_interpreter",
			container: { type: "custom-id" },
		});
	});
});

describe("mcpTool", () => {
	test("returns hosted tool with required config", () => {
		const t = mcpTool({
			serverLabel: "my-server",
			serverUrl: "https://example.com/mcp",
		});
		expect(t.type).toBe("hosted");
		expect(t.name).toBe("mcp:my-server");
		expect(t.definition).toEqual({
			type: "mcp",
			server_label: "my-server",
			server_url: "https://example.com/mcp",
		});
	});

	test("accepts requireApproval string", () => {
		const t = mcpTool({
			serverLabel: "srv",
			serverUrl: "https://example.com/mcp",
			requireApproval: "never",
		});
		expect(t.definition.require_approval).toBe("never");
	});

	test("accepts requireApproval object", () => {
		const t = mcpTool({
			serverLabel: "srv",
			serverUrl: "https://example.com/mcp",
			requireApproval: { always: ["dangerous_tool"], never: ["safe_tool"] },
		});
		expect(t.definition.require_approval).toEqual({
			always: ["dangerous_tool"],
			never: ["safe_tool"],
		});
	});

	test("accepts headers config", () => {
		const t = mcpTool({
			serverLabel: "srv",
			serverUrl: "https://example.com/mcp",
			headers: { Authorization: "Bearer token" },
		});
		expect(t.definition.headers).toEqual({ Authorization: "Bearer token" });
	});
});

describe("imageGenerationTool", () => {
	test("returns hosted tool", () => {
		const t = imageGenerationTool();
		expect(t.type).toBe("hosted");
		expect(t.name).toBe("image_generation");
		expect(t.definition).toEqual({ type: "image_generation" });
	});
});
