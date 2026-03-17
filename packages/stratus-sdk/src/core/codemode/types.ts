/**
 * Code mode: type generation and code normalization utilities.
 * Adapted from @cloudflare/codemode for the Stratus SDK.
 */

import type { FunctionTool } from "../tool";
import { zodToJsonSchema } from "../utils/zod";

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

/**
 * Sanitize a tool name into a valid JavaScript identifier.
 * Replaces hyphens, dots, and spaces with `_`, strips other invalid chars,
 * prefixes digit-leading names with `_`, and appends `_` to JS reserved words.
 */
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

// ── String escaping ────────────────────────────────────────────────

function escapeControlChar(ch: string): string {
	const code = ch.charCodeAt(0);
	if (code <= 31 || code === 127) return `\\u${code.toString(16).padStart(4, "0")}`;
	return ch;
}

function escapeStringLiteral(s: string): string {
	let out = "";
	for (const ch of s) {
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\u2028") out += "\\u2028";
		else if (ch === "\u2029") out += "\\u2029";
		else out += escapeControlChar(ch);
	}
	return out;
}

function escapeJsDoc(text: string): string {
	return text.replace(/\*\//g, "*\\/");
}

function needsQuotes(name: string): boolean {
	return !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

function quoteProp(name: string): string {
	if (needsQuotes(name)) {
		let escaped = "";
		for (const ch of name) {
			if (ch === "\\") escaped += "\\\\";
			else if (ch === '"') escaped += '\\"';
			else if (ch === "\n") escaped += "\\n";
			else if (ch === "\r") escaped += "\\r";
			else if (ch === "\t") escaped += "\\t";
			else if (ch === "\u2028") escaped += "\\u2028";
			else if (ch === "\u2029") escaped += "\\u2029";
			else escaped += escapeControlChar(ch);
		}
		return `"${escaped}"`;
	}
	return name;
}

// ── JSON Schema → TypeScript ───────────────────────────────────────

interface JsonSchemaNode {
	$ref?: string;
	type?: string | string[];
	properties?: Record<string, JsonSchemaNode | boolean>;
	required?: string[];
	additionalProperties?: boolean | JsonSchemaNode;
	items?: JsonSchemaNode | JsonSchemaNode[];
	prefixItems?: JsonSchemaNode[];
	anyOf?: JsonSchemaNode[];
	oneOf?: JsonSchemaNode[];
	allOf?: JsonSchemaNode[];
	enum?: unknown[];
	const?: unknown;
	description?: string;
	format?: string;
	nullable?: boolean;
	[key: string]: unknown;
}

interface ConvertCtx {
	root: JsonSchemaNode;
	depth: number;
	seen: Set<JsonSchemaNode>;
	maxDepth: number;
}

function resolveRef(ref: string, root: JsonSchemaNode): JsonSchemaNode | boolean | null {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return null;
	const segments = ref
		.slice(2)
		.split("/")
		.map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
	let current: unknown = root;
	for (const seg of segments) {
		if (current === null || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[seg];
		if (current === undefined) return null;
	}
	if (typeof current === "boolean") return current;
	if (current === null || typeof current !== "object") return null;
	return current as JsonSchemaNode;
}

function applyNullable(result: string, schema?: JsonSchemaNode): string {
	if (result !== "unknown" && result !== "never" && schema?.nullable === true)
		return `${result} | null`;
	return result;
}

function jsonSchemaToTypeString(
	schema: JsonSchemaNode | boolean,
	indent: string,
	ctx: ConvertCtx,
): string {
	if (typeof schema === "boolean") return schema ? "unknown" : "never";
	if (ctx.depth >= ctx.maxDepth) return "unknown";
	if (ctx.seen.has(schema)) return "unknown";
	ctx.seen.add(schema);
	const nextCtx: ConvertCtx = { ...ctx, depth: ctx.depth + 1 };
	try {
		if (schema.$ref) {
			const resolved = resolveRef(schema.$ref, ctx.root);
			if (!resolved) return "unknown";
			return applyNullable(jsonSchemaToTypeString(resolved, indent, nextCtx), schema);
		}
		if (schema.anyOf)
			return applyNullable(
				schema.anyOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(" | "),
				schema,
			);
		if (schema.oneOf)
			return applyNullable(
				schema.oneOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(" | "),
				schema,
			);
		if (schema.allOf)
			return applyNullable(
				schema.allOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(" & "),
				schema,
			);
		if (schema.enum) {
			if (schema.enum.length === 0) return "never";
			return applyNullable(
				schema.enum
					.map((v) => {
						if (v === null) return "null";
						if (typeof v === "string") return `"${escapeStringLiteral(v)}"`;
						if (typeof v === "object") return JSON.stringify(v) ?? "unknown";
						return String(v);
					})
					.join(" | "),
				schema,
			);
		}
		if (schema.const !== undefined) {
			return applyNullable(
				schema.const === null
					? "null"
					: typeof schema.const === "string"
						? `"${escapeStringLiteral(schema.const)}"`
						: typeof schema.const === "object"
							? (JSON.stringify(schema.const) ?? "unknown")
							: String(schema.const),
				schema,
			);
		}
		const type = schema.type;
		if (type === "string") return applyNullable("string", schema);
		if (type === "number" || type === "integer") return applyNullable("number", schema);
		if (type === "boolean") return applyNullable("boolean", schema);
		if (type === "null") return "null";
		if (type === "array") {
			const prefixItems = schema.prefixItems;
			if (Array.isArray(prefixItems))
				return applyNullable(
					`[${prefixItems.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(", ")}]`,
					schema,
				);
			if (Array.isArray(schema.items))
				return applyNullable(
					`[${schema.items.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(", ")}]`,
					schema,
				);
			if (schema.items)
				return applyNullable(
					`${jsonSchemaToTypeString(schema.items as JsonSchemaNode, indent, nextCtx)}[]`,
					schema,
				);
			return applyNullable("unknown[]", schema);
		}
		if (type === "object" || schema.properties) {
			const props = schema.properties || {};
			const required = new Set(schema.required || []);
			const lines: string[] = [];
			for (const [propName, propSchema] of Object.entries(props)) {
				if (typeof propSchema === "boolean") {
					const boolType = propSchema ? "unknown" : "never";
					const optionalMark = required.has(propName) ? "" : "?";
					lines.push(`${indent}    ${quoteProp(propName)}${optionalMark}: ${boolType};`);
					continue;
				}
				const isRequired = required.has(propName);
				const propType = jsonSchemaToTypeString(propSchema, `${indent}    `, nextCtx);
				const desc = propSchema.description;
				const format = propSchema.format;
				if (desc || format) {
					const descText = desc
						? escapeJsDoc(desc.replace(/\r?\n/g, " "))
						: undefined;
					const formatTag = format ? `@format ${escapeJsDoc(format)}` : undefined;
					if (descText && formatTag) {
						lines.push(`${indent}    /**`);
						lines.push(`${indent}     * ${descText}`);
						lines.push(`${indent}     * ${formatTag}`);
						lines.push(`${indent}     */`);
					} else {
						lines.push(`${indent}    /** ${descText ?? formatTag} */`);
					}
				}
				const quotedName = quoteProp(propName);
				const optionalMark = isRequired ? "" : "?";
				lines.push(`${indent}    ${quotedName}${optionalMark}: ${propType};`);
			}
			if (schema.additionalProperties) {
				const valueType =
					schema.additionalProperties === true
						? "unknown"
						: jsonSchemaToTypeString(schema.additionalProperties, `${indent}    `, nextCtx);
				lines.push(`${indent}    [key: string]: ${valueType};`);
			}
			if (lines.length === 0) {
				if (schema.additionalProperties === false) return applyNullable("{}", schema);
				return applyNullable("Record<string, unknown>", schema);
			}
			return applyNullable(`{\n${lines.join("\n")}\n${indent}}`, schema);
		}
		if (Array.isArray(type)) {
			return applyNullable(
				type
					.map((t) => {
						if (t === "string") return "string";
						if (t === "number" || t === "integer") return "number";
						if (t === "boolean") return "boolean";
						if (t === "null") return "null";
						if (t === "array") return "unknown[]";
						if (t === "object") return "Record<string, unknown>";
						return "unknown";
					})
					.join(" | "),
				schema,
			);
		}
		return "unknown";
	} finally {
		ctx.seen.delete(schema);
	}
}

// ── Public: generateTypes ──────────────────────────────────────────

/**
 * Generate TypeScript type definitions from an array of FunctionTools.
 * These types are included in the LLM's system prompt so it can write
 * correct code against the `codemode.*` API.
 */
export function generateTypes(tools: FunctionTool[]): string {
	let availableTools = "";
	let availableTypes = "";

	for (const t of tools) {
		const safeName = sanitizeToolName(t.name);
		const camelName = toCamelCase(safeName);

		try {
			const jsonSchema = zodToJsonSchema(t.parameters) as JsonSchemaNode;
			const inputType = `type ${camelName}Input = ${jsonSchemaToTypeString(jsonSchema, "", {
				root: jsonSchema,
				depth: 0,
				seen: new Set(),
				maxDepth: 20,
			})}`;
			const outputType = `type ${camelName}Output = unknown`;

			availableTypes += `\n${inputType.trim()}`;
			availableTypes += `\n${outputType.trim()}`;

			const jsdocLines: string[] = [];
			if (t.description?.trim()) {
				jsdocLines.push(escapeJsDoc(t.description.trim().replace(/\r?\n/g, " ")));
			} else {
				jsdocLines.push(escapeJsDoc(t.name));
			}

			// Extract param descriptions from JSON Schema properties
			if (jsonSchema.properties) {
				for (const [fieldName, propSchema] of Object.entries(jsonSchema.properties)) {
					if (
						typeof propSchema === "object" &&
						propSchema !== null &&
						"description" in propSchema &&
						propSchema.description
					) {
						jsdocLines.push(
							escapeJsDoc(
								`@param input.${fieldName} - ${String(propSchema.description).replace(/\r?\n/g, " ")}`,
							),
						);
					}
				}
			}

			const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
			availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
			availableTools += `\n\t${safeName}: (input: ${camelName}Input) => Promise<${camelName}Output>;`;
			availableTools += "\n";
		} catch {
			availableTypes += `\ntype ${camelName}Input = unknown`;
			availableTypes += `\ntype ${camelName}Output = unknown`;
			availableTools += `\n\t/**\n\t * ${escapeJsDoc(t.name)}\n\t */`;
			availableTools += `\n\t${safeName}: (input: ${camelName}Input) => Promise<${camelName}Output>;`;
			availableTools += "\n";
		}
	}

	availableTools = `\ndeclare const codemode: {${availableTools}}`;
	return `\n${availableTypes}\n${availableTools}\n`.trim();
}

// ── Public: normalizeCode ──────────────────────────────────────────

/**
 * Strip markdown code fences that LLMs commonly wrap code in.
 */
function stripCodeFences(code: string): string {
	const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
	return match ? match[1]! : code;
}

/**
 * Normalize LLM-generated code into an async arrow function.
 * Handles common LLM patterns: bare statements, function declarations,
 * code fences, and expression statements.
 */
export function normalizeCode(code: string): string {
	const trimmed = stripCodeFences(code.trim());
	if (!trimmed.trim()) return "async () => {}";
	const source = trimmed.trim();

	// Check if it's already an async arrow function
	if (/^async\s*\(/.test(source) && source.includes("=>")) {
		return source;
	}

	// Wrap bare code in an async arrow function
	return `async () => {\n${source}\n}`;
}
