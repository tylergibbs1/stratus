import type { McpSession, SessionStore } from "../types.js";

export type MemorySessionStoreConfig = {
	maxSessions?: number;
	ttlMs?: number;
};

export class MemorySessionStore implements SessionStore {
	private readonly sessions = new Map<string, McpSession>();
	private readonly maxSessions: number;
	private readonly ttlMs: number;

	constructor(config?: MemorySessionStoreConfig) {
		this.maxSessions = config?.maxSessions ?? 10_000;
		this.ttlMs = config?.ttlMs ?? 3_600_000; // 1 hour
	}

	async get(sessionId: string): Promise<McpSession | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;

		if (Date.now() - session.lastAccessedAt > this.ttlMs) {
			this.sessions.delete(sessionId);
			return undefined;
		}

		session.lastAccessedAt = Date.now();
		return session;
	}

	async set(session: McpSession): Promise<void> {
		if (!this.sessions.has(session.id) && this.sessions.size >= this.maxSessions) {
			this.evictOldest();
		}
		this.sessions.set(session.id, session);
	}

	async delete(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}

	private evictOldest(): void {
		let oldestKey: string | undefined;
		let oldestTime = Number.POSITIVE_INFINITY;

		for (const [key, session] of this.sessions) {
			if (session.lastAccessedAt < oldestTime) {
				oldestTime = session.lastAccessedAt;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this.sessions.delete(oldestKey);
		}
	}
}
