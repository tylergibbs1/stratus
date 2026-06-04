import { toJSONSchema, type ZodTypeAny } from "zod";

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
	const result = toJSONSchema(schema) as JsonSchema;
	result.$schema = undefined;
	return result;
}
