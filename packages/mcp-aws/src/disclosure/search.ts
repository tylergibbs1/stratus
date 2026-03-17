import type { ToolConfig } from "../types.js";

export type SearchResult = {
	name: string;
	description: string;
	score: number;
	tags: string[];
};

type IndexEntry = {
	name: string;
	description: string;
	tags: string[];
	terms: string[];
	termFrequencies: Map<string, number>;
	length: number;
};

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

export class SearchIndex {
	private readonly entries: IndexEntry[] = [];
	private readonly docFrequencies = new Map<string, number>();
	private avgDocLength = 0;

	build(tools: ToolConfig[]): void {
		this.entries.length = 0;
		this.docFrequencies.clear();

		for (const tool of tools) {
			const parts = [tool.name, tool.description, ...(tool.tags ?? [])];
			const terms = tokenize(parts.join(" "));

			const tf = new Map<string, number>();
			for (const term of terms) {
				tf.set(term, (tf.get(term) ?? 0) + 1);
			}

			this.entries.push({
				name: tool.name,
				description: tool.description,
				tags: tool.tags ?? [],
				terms,
				termFrequencies: tf,
				length: terms.length,
			});

			const seen = new Set<string>();
			for (const term of terms) {
				if (!seen.has(term)) {
					seen.add(term);
					this.docFrequencies.set(term, (this.docFrequencies.get(term) ?? 0) + 1);
				}
			}
		}

		const total = this.entries.reduce((sum, e) => sum + e.length, 0);
		this.avgDocLength = this.entries.length > 0 ? total / this.entries.length : 0;
	}

	search(query: string, maxResults = 10): SearchResult[] {
		const queryTerms = tokenize(query);
		if (queryTerms.length === 0 || this.entries.length === 0) return [];

		const n = this.entries.length;
		const k1 = 1.5;
		const b = 0.75;

		const scored: { entry: IndexEntry; score: number }[] = [];

		for (const entry of this.entries) {
			let score = 0;
			for (const term of queryTerms) {
				const tf = entry.termFrequencies.get(term) ?? 0;
				if (tf === 0) continue;

				const df = this.docFrequencies.get(term) ?? 0;
				const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);

				const tfNorm =
					(tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * entry.length) / this.avgDocLength));
				score += idf * tfNorm;
			}

			if (score > 0) {
				scored.push({ entry, score });
			}
		}

		scored.sort((a, b) => b.score - a.score);

		return scored.slice(0, maxResults).map((s) => ({
			name: s.entry.name,
			description: s.entry.description,
			score: s.score,
			tags: s.entry.tags,
		}));
	}
}
