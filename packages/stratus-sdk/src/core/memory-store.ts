import type { SessionSnapshot, SessionStore } from "./session";

export class MemorySessionStore implements SessionStore {
	private store = new Map<string, SessionSnapshot>();

	async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
		this.store.set(sessionId, snapshot);
	}

	async load(sessionId: string): Promise<SessionSnapshot | undefined> {
		return this.store.get(sessionId);
	}

	async delete(sessionId: string): Promise<void> {
		this.store.delete(sessionId);
	}

	async list(): Promise<string[]> {
		return Array.from(this.store.keys());
	}
}
