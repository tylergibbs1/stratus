import type { z } from "zod";

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
	return convertSchema(schema);
}

function convertSchema(schema: z.ZodTypeAny): JsonSchema {
	const def = schema._def;
	const typeName = def.typeName as string;

	switch (typeName) {
		case "ZodObject":
			return convertObject(schema as z.ZodObject<z.ZodRawShape>);
		case "ZodString":
			return withDescription({ type: "string" }, def.description);
		case "ZodNumber":
			return withDescription({ type: "number" }, def.description);
		case "ZodBoolean":
			return withDescription({ type: "boolean" }, def.description);
		case "ZodArray":
			return withDescription(
				{ type: "array", items: convertSchema(def.type) },
				def.description,
			);
		case "ZodEnum":
			return withDescription(
				{ type: "string", enum: def.values as string[] },
				def.description,
			);
		case "ZodNativeEnum":
			return withDescription(
				{ type: "string", enum: Object.values(def.values as Record<string, string>) },
				def.description,
			);
		case "ZodOptional":
			return convertSchema(def.innerType);
		case "ZodNullable":
			return { ...convertSchema(def.innerType), nullable: true };
		case "ZodDefault":
			return convertSchema(def.innerType);
		case "ZodLiteral":
			return withDescription({ type: typeof def.value, const: def.value }, def.description);
		case "ZodUnion": {
			const options = (def.options as z.ZodTypeAny[]).map(convertSchema);
			return withDescription({ anyOf: options }, def.description);
		}
		default:
			return {};
	}
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
	const shape = schema.shape;
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];

	for (const [key, value] of Object.entries(shape)) {
		const fieldSchema = value as z.ZodTypeAny;
		properties[key] = convertSchema(fieldSchema);

		if (!isOptional(fieldSchema)) {
			required.push(key);
		}
	}

	const result: JsonSchema = {
		type: "object",
		properties,
		additionalProperties: false,
	};

	if (required.length > 0) {
		result.required = required;
	}

	return withDescription(result, schema._def.description);
}

function isOptional(schema: z.ZodTypeAny): boolean {
	const typeName = schema._def.typeName as string;
	if (typeName === "ZodOptional") return true;
	if (typeName === "ZodDefault") return true;
	return false;
}

function withDescription(schema: JsonSchema, description?: string): JsonSchema {
	if (description) {
		return { ...schema, description };
	}
	return schema;
}
