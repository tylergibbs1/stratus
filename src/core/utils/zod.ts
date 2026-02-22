import { type ZodTypeAny, toJSONSchema } from "zod";

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
	const result = toJSONSchema(schema) as JsonSchema;
	delete result.$schema;
	return result;
}
