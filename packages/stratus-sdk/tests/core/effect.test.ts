import { describe, expect, test } from "bun:test";
import { Context, Data, Effect, Layer } from "effect";
import { z } from "zod";
import { Agent } from "../../src/core/agent";
import {
	effectModel,
	effectTool,
	runEffect,
	StratusEffectError,
	streamEffect,
} from "../../src/effect/index";
import { textResponse, toolCallResponse } from "../../src/testing/index";

class Multiplier extends Context.Tag("Multiplier")<
	Multiplier,
	{ readonly multiply: (value: number) => Effect.Effect<number> }
>() {}

class ToolFailure extends Data.TaggedError("ToolFailure")<{
	readonly message: string;
}> {}

describe("effect integration", () => {
	test("runs an Effect-backed tool with a provided service layer", async () => {
		const multiply = effectTool({
			name: "multiply",
			description: "Multiply a number",
			parameters: z.object({ value: z.number() }),
			layer: Layer.succeed(Multiplier, {
				multiply: (value) => Effect.succeed(value * 3),
			}),
			execute: (_context, { value }) =>
				Effect.gen(function* () {
					const multiplier = yield* Multiplier;
					const result = yield* multiplier.multiply(value);
					return String(result);
				}),
		});

		const model = effectModel({
			getResponse: () =>
				Effect.succeed(toolCallResponse([{ name: "multiply", args: { value: 7 } }])),
		});
		const agent = new Agent({
			name: "calculator",
			model,
			tools: [multiply],
			toolUseBehavior: "stop_on_first_tool",
		});

		const result = await Effect.runPromise(runEffect(agent, "multiply 7"));

		expect(result.output).toBe("21");
	});

	test("wraps promise runner failures in a tagged Effect error", async () => {
		const agent = new Agent({ name: "missing-model" });

		const error = await Effect.runPromise(Effect.flip(runEffect(agent, "hello")));

		expect(error).toBeInstanceOf(StratusEffectError);
		expect(error.message).toContain("No model provided");
	});

	test("Effect-backed model can stream from a normal response", async () => {
		const model = effectModel({
			getResponse: () => Effect.succeed(textResponse("streamed from effect")),
		});
		const agent = new Agent({ name: "streamer", model });

		const streamed = Effect.runSync(streamEffect(agent, "hi"));
		const events = [];
		for await (const event of streamed.stream) {
			events.push(event);
		}
		const result = await streamed.result;

		expect(events.map((event) => event.type)).toEqual(["content_delta", "done"]);
		expect(result.output).toBe("streamed from effect");
	});

	test("Effect tool failures still use Stratus tool error formatting", async () => {
		const failingTool = effectTool({
			name: "fail",
			description: "Fail intentionally",
			parameters: z.object({}),
			execute: () => Effect.fail(new ToolFailure({ message: "nope" })),
		});
		const model = effectModel({
			getResponse: () => Effect.succeed(toolCallResponse([{ name: "fail", args: {} }])),
		});
		const agent = new Agent({
			name: "failure-agent",
			model,
			tools: [failingTool],
			toolUseBehavior: "stop_on_first_tool",
		});

		const result = await Effect.runPromise(
			runEffect(agent, "fail", {
				toolErrorFormatter: (toolName, error) => `${toolName}: ${String(error)}`,
			}),
		);

		expect(result.output).toContain("fail:");
		expect(result.output).toContain("nope");
	});
});
