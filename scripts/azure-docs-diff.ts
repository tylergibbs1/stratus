#!/usr/bin/env bun
/**
 * Fetches Azure docs pages, stores snapshots in SQLite, and diffs against the previous version.
 *
 * Usage:
 *   bun scripts/azure-docs-diff.ts          # fetch all tracked pages
 *   bun scripts/azure-docs-diff.ts --list   # show stored snapshots
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { diffLines } from "diff"; // bun add diff

const DB_PATH = join(import.meta.dirname, "azure-docs.sqlite");

const PAGES: { slug: string; url: string }[] = [
	{
		slug: "responses-api",
		url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses?tabs=rest-api",
	},
	{
		slug: "generate-responses",
		url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/generate-responses?tabs=javascript",
	},
	{
		slug: "structured-outputs",
		url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs?tabs=python-secure%2Cdotnet-entra-id&pivots=programming-language-rest",
	},
];

// ── DB setup ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    slug      TEXT    NOT NULL,
    url       TEXT    NOT NULL,
    fetched   TEXT    NOT NULL DEFAULT (datetime('now')),
    content   TEXT    NOT NULL
  )
`);
db.run(
	"CREATE INDEX IF NOT EXISTS idx_snapshots_slug ON snapshots(slug, fetched DESC)",
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Strip HTML to readable text — good enough for diffing docs pages. */
function htmlToText(html: string): string {
	// Remove script/style blocks
	let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
	// Convert common block elements to newlines
	text = text.replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote)>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	// Strip remaining tags
	text = text.replace(/<[^>]+>/g, "");
	// Decode common entities
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
	// Collapse whitespace per line, drop empty lines
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join("\n");
}

function getPrevious(slug: string): string | null {
	const row = db
		.query<{ content: string }, [string]>(
			"SELECT content FROM snapshots WHERE slug = ? ORDER BY fetched DESC LIMIT 1",
		)
		.get(slug);
	return row?.content ?? null;
}

function save(slug: string, url: string, content: string) {
	db.run(
		"INSERT INTO snapshots (slug, url, content) VALUES (?, ?, ?)",
		slug,
		url,
		content,
	);
}

function printDiff(slug: string, oldText: string, newText: string) {
	const changes = diffLines(oldText, newText);
	const hasChanges = changes.some((c) => c.added || c.removed);

	if (!hasChanges) {
		console.log(`\n✔ ${slug}: no changes`);
		return;
	}

	console.log(`\n━━━ ${slug} ━━━`);
	for (const part of changes) {
		if (part.added) {
			for (const line of part.value.split("\n").filter(Boolean)) {
				console.log(`\x1b[32m+ ${line}\x1b[0m`);
			}
		} else if (part.removed) {
			for (const line of part.value.split("\n").filter(Boolean)) {
				console.log(`\x1b[31m- ${line}\x1b[0m`);
			}
		}
	}
}

// ── Commands ────────────────────────────────────────────────────────────────

if (process.argv.includes("--list")) {
	const rows = db
		.query<
			{ slug: string; fetched: string; len: number },
			[]
		>("SELECT slug, fetched, length(content) as len FROM snapshots ORDER BY fetched DESC LIMIT 30")
		.all();
	console.log("Recent snapshots:");
	for (const r of rows) {
		console.log(`  ${r.fetched}  ${r.slug}  (${r.len} chars)`);
	}
	process.exit(0);
}

// ── Main: fetch, diff, store ────────────────────────────────────────────────

console.log(`Fetching ${PAGES.length} pages...\n`);

const results = await Promise.all(
	PAGES.map(async ({ slug, url }) => {
		const res = await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) stratus-docs-tracker/1.0",
			},
		});
		if (!res.ok) {
			console.error(`✗ ${slug}: HTTP ${res.status}`);
			return null;
		}
		const html = await res.text();
		const content = htmlToText(html);
		return { slug, url, content };
	}),
);

for (const result of results) {
	if (!result) continue;
	const { slug, url, content } = result;

	const previous = getPrevious(slug);
	if (previous) {
		printDiff(slug, previous, content);
	} else {
		console.log(`● ${slug}: first snapshot (${content.length} chars)`);
	}

	save(slug, url, content);
}

console.log("\nDone. Snapshots saved to", DB_PATH);
db.close();
