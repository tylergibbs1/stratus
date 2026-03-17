/**
 * MCP server that simulates a documentation website for agent testing.
 * Tools return different content based on the current URL, so the agent
 * can navigate, discover pages, and compile documentation.
 */
import { z } from "zod";
import { McpServer, apiKey } from "../src/index.js";

// ── Simulated site content ──────────────────────────────────────────

type PageContent = {
	title: string;
	url: string;
	elements: { role: string; name: string; level?: number; href?: string }[];
};

const PAGES: Record<string, PageContent> = {
	"https://docs.example.com": {
		title: "Acme SDK Documentation",
		url: "https://docs.example.com",
		elements: [
			{ role: "heading", name: "Acme SDK", level: 1 },
			{ role: "paragraph", name: "The official SDK for the Acme platform. Build integrations in minutes." },
			{ role: "heading", name: "Quick Links", level: 2 },
			{ role: "link", name: "Getting Started", href: "https://docs.example.com/getting-started" },
			{ role: "link", name: "API Reference", href: "https://docs.example.com/api" },
			{ role: "link", name: "Examples", href: "https://docs.example.com/examples" },
			{ role: "paragraph", name: "Version 3.2.0 | MIT License | 50k+ weekly downloads" },
		],
	},
	"https://docs.example.com/getting-started": {
		title: "Getting Started - Acme SDK",
		url: "https://docs.example.com/getting-started",
		elements: [
			{ role: "heading", name: "Getting Started", level: 1 },
			{ role: "heading", name: "Installation", level: 2 },
			{ role: "code", name: "npm install @acme/sdk" },
			{ role: "heading", name: "Configuration", level: 2 },
			{ role: "paragraph", name: "Set your API key via the ACME_API_KEY environment variable or pass it directly to the constructor." },
			{ role: "code", name: "const client = new AcmeClient({ apiKey: process.env.ACME_API_KEY });" },
			{ role: "heading", name: "First Request", level: 2 },
			{ role: "code", name: "const result = await client.query({ text: 'Hello' });\nconsole.log(result.response);" },
			{ role: "link", name: "Back to Home", href: "https://docs.example.com" },
			{ role: "link", name: "API Reference", href: "https://docs.example.com/api" },
		],
	},
	"https://docs.example.com/api": {
		title: "API Reference - Acme SDK",
		url: "https://docs.example.com/api",
		elements: [
			{ role: "heading", name: "API Reference", level: 1 },
			{ role: "heading", name: "AcmeClient", level: 2 },
			{ role: "paragraph", name: "The main client class. Handles authentication, retries, and connection pooling." },
			{ role: "heading", name: "Constructor", level: 3 },
			{ role: "code", name: "new AcmeClient(options: { apiKey: string, region?: string, timeout?: number })" },
			{ role: "heading", name: "Methods", level: 3 },
			{ role: "paragraph", name: "client.query(input: QueryInput): Promise<QueryResult> — Send a query to the Acme API." },
			{ role: "paragraph", name: "client.batch(inputs: QueryInput[]): Promise<QueryResult[]> — Send multiple queries in a single request." },
			{ role: "paragraph", name: "client.stream(input: QueryInput): AsyncIterable<StreamChunk> — Stream responses token by token." },
			{ role: "heading", name: "Error Handling", level: 3 },
			{ role: "paragraph", name: "All errors extend AcmeError. Specific types: RateLimitError (429), AuthError (401), ValidationError (400)." },
			{ role: "link", name: "Back to Home", href: "https://docs.example.com" },
			{ role: "link", name: "Examples", href: "https://docs.example.com/examples" },
		],
	},
	"https://docs.example.com/examples": {
		title: "Examples - Acme SDK",
		url: "https://docs.example.com/examples",
		elements: [
			{ role: "heading", name: "Examples", level: 1 },
			{ role: "heading", name: "Basic Query", level: 2 },
			{ role: "code", name: "const result = await client.query({ text: 'Summarize this document', context: documentText });" },
			{ role: "heading", name: "Streaming", level: 2 },
			{ role: "code", name: "for await (const chunk of client.stream({ text: 'Tell me a story' })) {\n  process.stdout.write(chunk.text);\n}" },
			{ role: "heading", name: "Batch Processing", level: 2 },
			{ role: "code", name: "const results = await client.batch([\n  { text: 'Query 1' },\n  { text: 'Query 2' },\n  { text: 'Query 3' },\n]);" },
			{ role: "heading", name: "Error Handling", level: 2 },
			{ role: "code", name: "try {\n  await client.query({ text: 'test' });\n} catch (e) {\n  if (e instanceof RateLimitError) {\n    await sleep(e.retryAfter);\n  }\n}" },
			{ role: "link", name: "Back to Home", href: "https://docs.example.com" },
		],
	},
};

let currentUrl = "https://docs.example.com";

// ── Server ──────────────────────────────────────────────────────────

const server = new McpServer("docs-browser@1.0.0")
	.auth(apiKey({ "demo-key": { subject: "agent", roles: ["user"] } }))

	.tool(
		"browser_navigate",
		{
			description: "Navigate the browser to a URL. Returns the page title and URL.",
			params: z.object({ url: z.string().describe("URL to navigate to") }),
		},
		async ({ url }) => {
			currentUrl = url;
			const page = PAGES[url];
			if (!page) {
				return { error: `Page not found: ${url}`, navigated: false };
			}
			return { navigated: true, title: page.title, url: page.url };
		},
	)

	.tool(
		"browser_snapshot",
		{ description: "Get an accessibility snapshot of the current page. Returns the page structure including headings, paragraphs, links, and code blocks." },
		async () => {
			const page = PAGES[currentUrl];
			if (!page) {
				return { error: `No page loaded at ${currentUrl}` };
			}
			return page;
		},
	)

	.tool(
		"browser_click",
		{
			description: "Click a link on the current page. Use the link text from browser_snapshot.",
			params: z.object({ element: z.string().describe("The link text to click") }),
			tier: "discoverable",
			tags: ["navigation", "click", "link"],
		},
		async ({ element }) => {
			const page = PAGES[currentUrl];
			if (!page) return { error: "No page loaded" };

			const link = page.elements.find(
				(e) => e.role === "link" && e.name.toLowerCase().includes(element.toLowerCase()),
			);
			if (!link?.href) return { error: `Link "${element}" not found on current page` };

			currentUrl = link.href;
			const target = PAGES[currentUrl];
			if (!target) return { error: `Page not found: ${link.href}` };

			return { clicked: element, navigatedTo: target.url, title: target.title };
		},
	)

	.tool(
		"browser_get_text",
		{
			description: "Get all text content from the current page as a single string.",
			tier: "discoverable",
			tags: ["text", "content", "extract"],
		},
		async () => {
			const page = PAGES[currentUrl];
			if (!page) return { error: "No page loaded" };

			const text = page.elements
				.map((e) => {
					if (e.role === "heading") return `${"#".repeat(e.level ?? 1)} ${e.name}`;
					if (e.role === "code") return `\`\`\`\n${e.name}\n\`\`\``;
					if (e.role === "link") return `[${e.name}](${e.href})`;
					return e.name;
				})
				.join("\n\n");

			return { url: currentUrl, title: page.title, text };
		},
	);

export const handler = server.lambda();
export { server };
