/**
 * Code mode: type generation and code normalization for MCP tools.
 * Adapted from stratus-sdk codemode, uses JSON Schema directly
 * instead of depending on Zod/zodToJsonSchema.
 */

import type { z } from "zod";
import type { ToolConfig } from "../types.js";

// ── JS reserved words ──────────────────────────────────────────────

const JS_RESERVED = new Set([
	"abstract",
	"arguments",
	"await",
	"boolean",
	"break",
	"byte",
	"case",
	"catch",
	"char",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"double",
	"else",
	"enum",
	"eval",
	"export",
	"extends",
	"false",
	"final",
	"finally",
	"float",
	"for",
	"function",
	"goto",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"int",
	"interface",
	"let",
	"long",
	"native",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"short",
	"static",
	"super",
	"switch",
	"synchronized",
	"this",
	"throw",
	"throws",
	"transient",
	"true",
	"try",
	"typeof",
	"undefined",
	"var",
	"void",
	"volatile",
	"while",
	"with",
	"yield",
]);

// ── Name sanitization ──────────────────────────────────────────────

export function sanitizeToolName(name: string): string {
	if (!name) return "_";
	let sanitized = name.replace(/[-.\s]/g, "_");
	sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
	if (!sanitized) return "_";
	if (/^[0-9]/.test(sanitized)) sanitized = `_${sanitized}`;
	if (JS_RESERVED.has(sanitized)) sanitized = `${sanitized}_`;
	return sanitized;
}

function toCamelCase(str: string): string {
	return str
		.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
		.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

// ── Zod → JSON Schema (minimal) ───────────────────────────────────

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	// Zod v4 has .toJsonSchema(), fall back to a basic conversion
	if ("toJsonSchema" in schema && typeof schema.toJsonSchema === "function") {
		return schema.toJsonSchema() as Record<string, unknown>;
	}
	// Fallback: try to get shape from ZodObject
	return { type: "object" };
}

// ── JSON Schema → TypeScript ───────────────────────────────────────

type JsonSchemaNode = Record<string, unknown>;

function jsonSchemaToTypeString(schema: JsonSchemaNode, indent: string, depth: number): string {
	if (depth > 15) return "unknown";

	const type = schema.type as string | undefined;

	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";

	if (type === "array") {
		const items = schema.items as JsonSchemaNode | undefined;
		if (items) return `${jsonSchemaToTypeString(items, indent, depth + 1)}[]`;
		return "unknown[]";
	}

	if (type === "object" || schema.properties) {
		const props = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
		const required = new Set((schema.required as string[]) ?? []);
		const lines: string[] = [];

		for (const [propName, propSchema] of Object.entries(props)) {
			const propType = jsonSchemaToTypeString(propSchema, `${indent}    `, depth + 1);
			const opt = required.has(propName) ? "" : "?";
			const desc = propSchema.description as string | undefined;
			if (desc) {
				lines.push(`${indent}    /** ${desc} */`);
			}
			lines.push(`${indent}    ${propName}${opt}: ${propType};`);
		}

		if (lines.length === 0) return "Record<string, unknown>";
		return `{\n${lines.join("\n")}\n${indent}}`;
	}

	if (schema.enum) {
		const vals = schema.enum as unknown[];
		return vals
			.map((v) => {
				if (v === null) return "null";
				if (typeof v === "string") return `"${v}"`;
				return String(v);
			})
			.join(" | ");
	}

	return "unknown";
}

// ── Public: generateTypes ──────────────────────────────────────────

export function generateTypes(tools: ToolConfig[]): string {
	let availableTools = "";
	let availableTypes = "";

	for (const t of tools) {
		const safeName = sanitizeToolName(t.name);
		const camelName = toCamelCase(safeName);

		try {
			const jsonSchema = t.inputSchema ? zodToJsonSchema(t.inputSchema) : { type: "object" };
			const inputType = `type ${camelName}Input = ${jsonSchemaToTypeString(jsonSchema as JsonSchemaNode, "", 0)}`;
			const outputType = `type ${camelName}Output = unknown`;

			availableTypes += `\n${inputType.trim()}`;
			availableTypes += `\n${outputType.trim()}`;

			const desc = t.description?.trim() ?? t.name;
			availableTools += `\n\t/** ${desc} */`;
			availableTools += `\n\t${safeName}: (input: ${camelName}Input) => Promise<${camelName}Output>;`;
			availableTools += "\n";
		} catch {
			availableTypes += `\ntype ${camelName}Input = unknown`;
			availableTypes += `\ntype ${camelName}Output = unknown`;
			availableTools += `\n\t/** ${t.name} */`;
			availableTools += `\n\t${safeName}: (input: ${camelName}Input) => Promise<${camelName}Output>;`;
			availableTools += "\n";
		}
	}

	availableTools = `\ndeclare const codemode: {${availableTools}}`;
	return `\n${availableTypes}\n${availableTools}\n`.trim();
}

// ── Public: normalizeCode ──────────────────────────────────────────

function stripCodeFences(code: string): string {
	const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
	return match?.[1] ?? code;
}

export function normalizeCode(code: string): string {
	const trimmed = stripCodeFences(code.trim());
	if (!trimmed.trim()) return "async () => {}";
	const source = trimmed.trim();

	if (/^async\s*\(/.test(source) && source.includes("=>")) {
		return source;
	}

	return `async () => {\n${source}\n}`;
}
