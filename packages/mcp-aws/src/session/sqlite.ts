/**
 * SQLite session store using Bun's native bun:sqlite.
 * Zero dependencies. Great for ECS/Fargate/EC2 deployments.
 */
import { Database } from "bun:sqlite";
import type { McpSession, SessionStore } from "../types.js";

export type SqliteSessionStoreConfig = {
	/** Path to the SQLite database file. Default: ":memory:" */
	path?: string;
	/** TTL in milliseconds. Default: 3600000 (1 hour) */
	ttlMs?: number;
};

type SerializedSession = {
	id: string;
	visibleTools: string[];
	unlockedGates: string[];
	toolCallHistory: McpSession["toolCallHistory"];
	auth: McpSession["auth"];
	metadata: Record<string, unknown>;
	createdAt: number;
	lastAccessedAt: number;
};

function serialize(session: McpSession): string {
	const data: SerializedSession = {
		id: session.id,
		visibleTools: [...session.visibleTools],
		unlockedGates: [...session.unlockedGates],
		toolCallHistory: session.toolCallHistory,
		auth: session.auth,
		metadata: session.metadata,
		createdAt: session.createdAt,
		lastAccessedAt: session.lastAccessedAt,
	};
	return JSON.stringify(data);
}

function deserialize(json: string): McpSession {
	const data: SerializedSession = JSON.parse(json);
	return {
		id: data.id,
		visibleTools: new Set(data.visibleTools),
		unlockedGates: new Set(data.unlockedGates),
		toolCallHistory: data.toolCallHistory,
		auth: data.auth,
		metadata: data.metadata,
		createdAt: data.createdAt,
		lastAccessedAt: data.lastAccessedAt,
	};
}

export class SqliteSessionStore implements SessionStore {
	readonly #db: Database;
	readonly #ttlMs: number;

	constructor(config?: SqliteSessionStoreConfig) {
		this.#db = new Database(config?.path ?? ":memory:");
		this.#ttlMs = config?.ttlMs ?? 3_600_000;

		this.#db.run(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			)
		`);
	}

	async get(sessionId: string): Promise<McpSession | undefined> {
		const now = Date.now();

		// Clean expired
		this.#db.run("DELETE FROM sessions WHERE expires_at < ?", [now]);

		const row = this.#db.query("SELECT data FROM sessions WHERE id = ?").get(sessionId) as {
			data: string;
		} | null;

		if (!row) return undefined;

		const session = deserialize(row.data);
		session.lastAccessedAt = now;

		// Refresh TTL
		this.#db.run("UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?", [
			serialize(session),
			now + this.#ttlMs,
			sessionId,
		]);

		return session;
	}

	async set(session: McpSession): Promise<void> {
		const expiresAt = Date.now() + this.#ttlMs;
		this.#db.run("INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)", [
			session.id,
			serialize(session),
			expiresAt,
		]);
	}

	async delete(sessionId: string): Promise<void> {
		this.#db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
	}

	/** Close the database connection. */
	close(): void {
		this.#db.close();
	}
}
