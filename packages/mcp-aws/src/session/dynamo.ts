import type { McpSession, SessionStore } from "../types.js";

type DynamoClient = {
	send(command: unknown): Promise<unknown>;
};

export type DynamoSessionStoreConfig = {
	tableName: string;
	region?: string;
	ttlSeconds?: number;
	client?: DynamoClient;
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

/** Strip non-JSON-serializable values (AbortSignal, functions, etc.) */
function safeClone<T>(obj: T): T {
	try {
		return JSON.parse(JSON.stringify(obj));
	} catch {
		return {} as T;
	}
}

function serializeSession(session: McpSession): SerializedSession {
	return {
		id: session.id,
		visibleTools: [...session.visibleTools],
		unlockedGates: [...session.unlockedGates],
		toolCallHistory: safeClone(session.toolCallHistory),
		auth: safeClone(session.auth),
		metadata: safeClone(session.metadata),
		createdAt: session.createdAt,
		lastAccessedAt: session.lastAccessedAt,
	};
}

function deserializeSession(data: SerializedSession): McpSession {
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

export class DynamoSessionStore implements SessionStore {
	private readonly tableName: string;
	private readonly ttlSeconds: number;
	private client: DynamoClient | undefined;
	private readonly region?: string;

	constructor(config: DynamoSessionStoreConfig) {
		this.tableName = config.tableName;
		this.ttlSeconds = config.ttlSeconds ?? 3600;
		this.client = config.client;
		this.region = config.region;
	}

	private async getClient(): Promise<DynamoClient> {
		if (this.client) return this.client;

		// Lazy import to keep optional dependency truly optional
		const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
		const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
		const base = new DynamoDBClient({ region: this.region });
		this.client = DynamoDBDocumentClient.from(base);
		return this.client;
	}

	async get(sessionId: string): Promise<McpSession | undefined> {
		const client = await this.getClient();
		const { GetCommand } = await import("@aws-sdk/lib-dynamodb");

		const result = (await client.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: sessionId },
			}),
		)) as { Item?: { data: SerializedSession } };

		if (!result.Item) return undefined;

		const session = deserializeSession(result.Item.data);
		session.lastAccessedAt = Date.now();

		// Update lastAccessedAt + TTL
		await this.set(session);
		return session;
	}

	async set(session: McpSession): Promise<void> {
		const client = await this.getClient();
		const { PutCommand } = await import("@aws-sdk/lib-dynamodb");

		const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;

		await client.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: session.id,
					data: serializeSession(session),
					expiresAt,
				},
			}),
		);
	}

	async delete(sessionId: string): Promise<void> {
		const client = await this.getClient();
		const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");

		await client.send(
			new DeleteCommand({
				TableName: this.tableName,
				Key: { pk: sessionId },
			}),
		);
	}
}
