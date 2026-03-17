/**
 * Example: Playwright MCP tools served via @stratus/mcp-aws
 *
 * 59 tools → progressive disclosure with 3 tiers:
 * - always: core navigation + snapshot (3 tools)
 * - discoverable: interaction, forms, tabs (20+ tools)
 * - hidden: advanced debugging, network, cookies (30+ tools)
 *
 * Usage:
 *   Local:  bun run examples/playwright-server.ts
 *   Lambda: export default server.lambda()
 */
import { z } from "zod";
import { McpServer, apiKey, role } from "../src/index.js";

const server = new McpServer("playwright-mcp@1.0.0")
	.auth(apiKey({ "demo-key": { subject: "demo", roles: ["user"] } }))

	// ── Always tier: core browser operations ────────────────────────
	.tool(
		"browser_navigate",
		{
			description: "Navigate to a URL in the browser",
			params: z.object({
				url: z.string().describe("URL to navigate to"),
			}),
		},
		async ({ url }) => {
			return { navigated: true, url, timestamp: Date.now() };
		},
	)
	.tool(
		"browser_snapshot",
		{
			description: "Take an accessibility snapshot of the current page",
		},
		async () => {
			return {
				title: "Example Page",
				url: "https://example.com",
				elements: [
					{ role: "heading", name: "Example Domain", level: 1 },
					{ role: "paragraph", name: "This domain is for use in illustrative examples." },
					{
						role: "link",
						name: "More information...",
						href: "https://www.iana.org/domains/example",
					},
				],
			};
		},
	)
	.tool("browser_close", { description: "Close the browser" }, async () => {
		return "Browser closed";
	})

	// ── Discoverable tier: interaction tools ─────────────────────────
	.tool(
		"browser_click",
		{
			description: "Click an element on the page",
			params: z.object({ element: z.string().describe("Human-readable element description") }),
			tier: "discoverable",
			tags: ["interaction", "click"],
		},
		async ({ element }) => `Clicked: ${element}`,
	)
	.tool(
		"browser_fill_form",
		{
			description: "Fill a form field with a value",
			params: z.object({
				element: z.string().describe("Form field description"),
				value: z.string().describe("Value to fill"),
			}),
			tier: "discoverable",
			tags: ["interaction", "form", "input"],
		},
		async ({ element, value }) => `Filled "${element}" with "${value}"`,
	)
	.tool(
		"browser_type",
		{
			description: "Type text into an element",
			params: z.object({
				element: z.string(),
				text: z.string(),
			}),
			tier: "discoverable",
			tags: ["interaction", "keyboard"],
		},
		async ({ element, text }) => `Typed "${text}" into "${element}"`,
	)
	.tool(
		"browser_hover",
		{
			description: "Hover over an element",
			params: z.object({ element: z.string() }),
			tier: "discoverable",
			tags: ["interaction", "mouse"],
		},
		async ({ element }) => `Hovered over: ${element}`,
	)
	.tool(
		"browser_select_option",
		{
			description: "Select an option from a dropdown",
			params: z.object({
				element: z.string(),
				values: z.array(z.string()),
			}),
			tier: "discoverable",
			tags: ["interaction", "form", "select"],
		},
		async ({ element, values }) => `Selected [${values.join(", ")}] in "${element}"`,
	)
	.tool(
		"browser_press_key",
		{
			description: "Press a keyboard key",
			params: z.object({ key: z.string() }),
			tier: "discoverable",
			tags: ["interaction", "keyboard"],
		},
		async ({ key }) => `Pressed key: ${key}`,
	)
	.tool(
		"browser_tabs",
		{
			description: "List all open browser tabs",
			tier: "discoverable",
			tags: ["tabs", "navigation"],
		},
		async () => [{ id: 0, url: "https://example.com", title: "Example Domain", active: true }],
	)
	.tool(
		"browser_take_screenshot",
		{
			description: "Take a screenshot of the current page",
			tier: "discoverable",
			tags: ["screenshot", "visual"],
		},
		async () => ({ screenshot: "base64-data-here", format: "png" }),
	)
	.tool(
		"browser_navigate_back",
		{
			description: "Navigate back in browser history",
			tier: "discoverable",
			tags: ["navigation"],
		},
		async () => "Navigated back",
	)
	.tool(
		"browser_wait_for",
		{
			description: "Wait for text to appear or disappear on the page",
			params: z.object({
				text: z.string().describe("Text to wait for"),
				state: z.enum(["attached", "detached"]).optional(),
			}),
			tier: "discoverable",
			tags: ["wait", "assertion"],
		},
		async ({ text, state }) => `Waited for "${text}" to be ${state ?? "attached"}`,
	)

	// ── Hidden tier: advanced/admin tools ────────────────────────────
	.tool(
		"browser_console_messages",
		{
			description: "Get browser console messages",
			tier: "hidden",
			gate: role("user"),
			tags: ["debug", "console"],
		},
		async () => [
			{ level: "log", text: "Page loaded" },
			{ level: "warn", text: "Deprecated API used" },
		],
	)
	.tool(
		"browser_network_requests",
		{
			description: "Get network requests made by the page",
			tier: "hidden",
			gate: role("user"),
			tags: ["debug", "network"],
		},
		async () => [{ method: "GET", url: "https://example.com", status: 200, duration: 42 }],
	)
	.tool(
		"browser_evaluate",
		{
			description: "Execute JavaScript in the browser page",
			params: z.object({ expression: z.string() }),
			tier: "hidden",
			gate: role("user"),
			tags: ["debug", "javascript", "eval"],
		},
		async ({ expression }) => `eval result: ${expression}`,
	)
	.tool(
		"browser_cookie_list",
		{
			description: "List all cookies for the current page",
			tier: "hidden",
			gate: role("user"),
			tags: ["cookies", "storage"],
		},
		async () => [{ name: "session_id", value: "abc123", domain: "example.com" }],
	)
	.tool(
		"browser_cookie_clear",
		{
			description: "Clear all cookies",
			tier: "hidden",
			gate: role("user"),
			tags: ["cookies", "storage"],
		},
		async () => "All cookies cleared",
	)
	.tool(
		"browser_resize",
		{
			description: "Resize the browser window",
			params: z.object({ width: z.number(), height: z.number() }),
			tier: "hidden",
			gate: role("user"),
			tags: ["viewport", "resize"],
		},
		async ({ width, height }) => `Resized to ${width}x${height}`,
	);

// Export Lambda handler — this is what gets deployed
export const handler = server.lambda();

// Export server for testing
export { server };
