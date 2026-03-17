import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "../../src/core/utils/zod";

function getProps(result: Record<string, unknown>): Record<string, Record<string, unknown>> {
	return result.properties as Record<string, Record<string, unknown>>;
}

describe("zodToJsonSchema", () => {
	test("converts simple object", () => {
		const schema = z.object({
			name: z.string(),
			age: z.number(),
		});

		const result = zodToJsonSchema(schema);
		expect(result).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
			additionalProperties: false,
			required: ["name", "age"],
		});
	});

	test("handles optional fields", () => {
		const schema = z.object({
			required: z.string(),
			optional: z.string().optional(),
		});

		const result = zodToJsonSchema(schema);
		expect(result.required as string[]).toEqual(["required"]);
	});

	test("converts arrays", () => {
		const schema = z.object({
			items: z.array(z.string()),
		});

		const props = getProps(zodToJsonSchema(schema));
		expect(props.items!.type).toBe("array");
		expect(props.items!.items).toEqual({ type: "string" });
	});

	test("converts enums", () => {
		const schema = z.object({
			color: z.enum(["red", "green", "blue"]),
		});

		const props = getProps(zodToJsonSchema(schema));
		expect(props.color!.enum).toEqual(["red", "green", "blue"]);
	});

	test("converts booleans", () => {
		const schema = z.object({
			active: z.boolean(),
		});

		const props = getProps(zodToJsonSchema(schema));
		expect(props.active!.type).toBe("boolean");
	});

	test("handles descriptions", () => {
		const schema = z.object({
			name: z.string().describe("The user's name"),
		});

		const props = getProps(zodToJsonSchema(schema));
		expect(props.name!.description).toBe("The user's name");
	});

	test("handles nested objects", () => {
		const schema = z.object({
			address: z.object({
				street: z.string(),
				city: z.string(),
			}),
		});

		const props = getProps(zodToJsonSchema(schema));
		expect(props.address!.type).toBe("object");
	});
});
