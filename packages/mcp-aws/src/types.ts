import type { z } from "zod";

// ── Tool Tiers ──────────────────────────────────────────────────────────────

export type ToolTier = "always" | "discoverable" | "hidden";

// ── Content ─────────────────────────────────────────────────────────────────

export type TextContent = {
	type: "text";
	text: string;
};

export type ImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

export type ContentPart = TextContent | ImageContent;

export type ToolResult = {
	content: ContentPart[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

// ── Handler Return Coercion ─────────────────────────────────────────────────

/**
 * What tool handlers can return. The server auto-coerces:
 * - `string` → text content
 * - plain object → JSON-serialized text content
 * - `ToolResult` → pass-through
 * - `void/undefined` → empty content
 */
export type ToolHandlerReturn =
	| string
	| Record<string, unknown>
	| unknown[]
	| ToolResult
	| undefined;

function isContentPart(v: unknown): v is ContentPart {
	return (
		typeof v === "object" && v !== null && "type" in v && (v.type === "text" || v.type === "image")
	);
}

export function isToolResult(v: unknown): v is ToolResult {
	return (
		typeof v === "object" &&
		v !== null &&
		"content" in v &&
		Array.isArray((v as ToolResult).content) &&
		((v as ToolResult).content.length === 0 || isContentPart((v as ToolResult).content[0]))
	);
}

export function normalizeToolResult(raw: ToolHandlerReturn): ToolResult {
	if (raw === undefined || raw === null) return { content: [] };
	if (typeof raw === "string") return { content: [{ type: "text", text: raw }] };
	if (isToolResult(raw)) return raw;
	// Array or plain object → JSON
	return { content: [{ type: "text", text: JSON.stringify(raw) }] };
}

// ── Auth ────────────────────────────────────────────────────────────────────

export type AuthContext = {
	authenticated: boolean;
	subject?: string;
	roles: string[];
	claims: Record<string, unknown>;
};

// ── Tool Context & Handler ──────────────────────────────────────────────────

export type ToolContext = {
	session: McpSession;
	auth: AuthContext;
	signal?: AbortSignal;
};

export type ToolHandler<TParams = unknown> = (
	params: TParams,
	ctx: ToolContext,
) => ToolHandlerReturn | Promise<ToolHandlerReturn>;

// ── Gate ────────────────────────────────────────────────────────────────────

export type GateContext = {
	auth: AuthContext;
	toolName: string;
	sessionId: string;
	metadata: Record<string, unknown>;
};

export type GateResult = { allowed: true } | { allowed: false; reason: string; hint?: string };

export type Gate = (ctx: GateContext) => GateResult | Promise<GateResult>;

// ── Tool Options (user-facing) ──────────────────────────────────────────────

export type ToolOptions<T extends z.ZodType = z.ZodType> = {
	description?: string;
	params?: T;
	tier?: ToolTier;
	tags?: string[];
	gate?: Gate;
	timeout?: number;
};

// ── Tool Config (internal) ──────────────────────────────────────────────────

export type ToolConfig<TParams = unknown> = {
	name: string;
	description: string;
	inputSchema?: z.ZodType<TParams>;
	outputSchema?: z.ZodType;
	tier: ToolTier;
	tags?: string[];
	gate?: Gate;
	timeout?: number;
	handler: ToolHandler<TParams>;
};

// ── Session ─────────────────────────────────────────────────────────────────

export type ToolCallRecord = {
	toolName: string;
	params: unknown;
	timestamp: number;
	durationMs: number;
};

export type McpSession = {
	id: string;
	visibleTools: Set<string>;
	unlockedGates: Set<string>;
	toolCallHistory: ToolCallRecord[];
	auth: AuthContext;
	metadata: Record<string, unknown>;
	createdAt: number;
	lastAccessedAt: number;
};

// ── Session Store ───────────────────────────────────────────────────────────

export type SessionStore = {
	get(sessionId: string): Promise<McpSession | undefined>;
	set(session: McpSession): Promise<void>;
	delete(sessionId: string): Promise<void>;
};

// ── Disclosure ──────────────────────────────────────────────────────────────

export type DisclosureMode = "all" | "progressive" | "code-first";

export type DisclosureConfig = {
	mode: DisclosureMode;
	searchMode?: "bm25";
	maxResults?: number;
};

// ── Code Mode ───────────────────────────────────────────────────────────────

export type CodeModeConfig = {
	enabled: boolean;
	executor?: "function" | "worker";
};

// ── Server Config ───────────────────────────────────────────────────────────

export type McpServerConfig = {
	name: string;
	version: string;
	disclosure?: DisclosureConfig;
	codeMode?: CodeModeConfig;
};
