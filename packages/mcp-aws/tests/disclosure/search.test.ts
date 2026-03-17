import { describe, expect, test } from "bun:test";
import { SearchIndex } from "../../src/disclosure/search.js";
import type { ToolConfig } from "../../src/types.js";

function makeTool(name: string, description: string, tags: string[] = []): ToolConfig {
	return {
		name,
		description,
		tier: "discoverable",
		tags,
		handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

describe("SearchIndex", () => {
	test("finds exact name match", () => {
		const index = new SearchIndex();
		index.build([
			makeTool("search_web", "Search the web for information"),
			makeTool("read_file", "Read a file from disk"),
		]);

		const results = index.search("search web");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.name).toBe("search_web");
	});

	test("ranks by relevance", () => {
		const index = new SearchIndex();
		index.build([
			makeTool("list_users", "List all users in the database"),
			makeTool("create_user", "Create a new user account"),
			makeTool("send_email", "Send an email notification"),
		]);

		const results = index.search("users list");
		expect(results.length).toBeGreaterThanOrEqual(1);
		// The list_users tool should rank highest for "users list"
		expect(results[0]!.name).toBe("list_users");
	});

	test("searches tags", () => {
		const index = new SearchIndex();
		index.build([
			makeTool("get_weather", "Get current weather", ["weather", "api"]),
			makeTool("get_stocks", "Get stock prices", ["finance", "api"]),
		]);

		const results = index.search("weather");
		expect(results.length).toBe(1);
		expect(results[0]!.name).toBe("get_weather");
	});

	test("returns empty for no match", () => {
		const index = new SearchIndex();
		index.build([makeTool("search_web", "Search the web")]);

		const results = index.search("xyznonexistent");
		expect(results.length).toBe(0);
	});

	test("respects maxResults", () => {
		const index = new SearchIndex();
		const tools = Array.from({ length: 20 }, (_, i) =>
			makeTool(`tool_${i}`, `Tool number ${i} for data processing`),
		);
		index.build(tools);

		const results = index.search("data processing", 5);
		expect(results.length).toBe(5);
	});

	test("handles empty query", () => {
		const index = new SearchIndex();
		index.build([makeTool("test", "A test tool")]);
		const results = index.search("");
		expect(results.length).toBe(0);
	});

	test("handles empty index", () => {
		const index = new SearchIndex();
		index.build([]);
		const results = index.search("anything");
		expect(results.length).toBe(0);
	});

	test("result includes score and tags", () => {
		const index = new SearchIndex();
		index.build([makeTool("test_tool", "A test tool", ["testing", "dev"])]);

		const results = index.search("test");
		expect(results.length).toBe(1);
		expect(results[0]!.score).toBeGreaterThan(0);
		expect(results[0]!.tags).toEqual(["testing", "dev"]);
	});
});
