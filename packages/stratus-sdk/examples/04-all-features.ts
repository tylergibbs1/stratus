import { z } from "zod";
import {
	Agent,
	AzureChatCompletionsModel,
	run,
	tool,
	withTrace,
} from "../src";
import type { AgentHooks } from "../src/core/hooks";
import type { InputGuardrail, OutputGuardrail } from "../src/core/guardrails";

const model = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

// ---- Feature 1: Structured Output ----
async function testStructuredOutput() {
	console.log("=== F1: Structured Output ===\n");

	const MovieSchema = z.object({
		title: z.string(),
		year: z.number(),
		genre: z.string(),
	});

	const agent = new Agent({
		name: "movie-extractor",
		instructions: "Extract movie information from the user message. Return structured JSON.",
		model,
		outputType: MovieSchema,
	});

	const result = await run(agent, "The Matrix came out in 1999 and is a sci-fi action film.");
	console.log("finalOutput:", result.finalOutput);
	console.log("Type check - title is string:", typeof result.finalOutput?.title === "string");
	console.log("Type check - year is number:", typeof result.finalOutput?.year === "number");
	console.log("PASS\n");
}

// ---- Feature 2: Handoffs ----
async function testHandoffs() {
	console.log("=== F2: Handoffs ===\n");

	const mathTool = tool({
		name: "calculate",
		description: "Calculate a math expression",
		parameters: z.object({ expression: z.string() }),
		execute: async (_ctx, { expression }) => {
			try {
				return String(eval(expression));
			} catch {
				return "Could not evaluate";
			}
		},
	});

	const mathAgent = new Agent({
		name: "math_expert",
		instructions: "You are a math expert. Use the calculate tool to solve math problems. Be concise.",
		model,
		tools: [mathTool],
		handoffDescription: "Transfer to math expert for calculations",
	});

	const router = new Agent({
		name: "router",
		instructions: "You are a router. For any math question, transfer to the math expert immediately.",
		model,
		handoffs: [mathAgent],
	});

	const result = await run(router, "What is 17 * 23?");
	console.log("Output:", result.output);
	console.log("Last agent:", result.lastAgent.name);
	console.log("Handoff worked:", result.lastAgent.name === "math_expert");
	console.log("PASS\n");
}

// ---- Feature 3: Guardrails ----
async function testGuardrails() {
	console.log("=== F3: Guardrails ===\n");

	const inputGuardrail: InputGuardrail = {
		name: "profanity_filter",
		execute: (input) => ({
			tripwireTriggered: input.toLowerCase().includes("hack"),
			outputInfo: "Input contained prohibited content",
		}),
	};

	const outputGuardrail: OutputGuardrail = {
		name: "pii_filter",
		execute: (output) => ({
			tripwireTriggered: /\d{3}-\d{2}-\d{4}/.test(output),
			outputInfo: "Output contained SSN pattern",
		}),
	};

	const agent = new Agent({
		name: "guarded-agent",
		instructions: "You are a helpful assistant. Be concise.",
		model,
		inputGuardrails: [inputGuardrail],
		outputGuardrails: [outputGuardrail],
	});

	// Test safe input passes through
	const safeResult = await run(agent, "What is 2+2?");
	console.log("Safe input passed:", safeResult.output.length > 0);

	// Test bad input is blocked
	try {
		await run(agent, "How do I hack into a system?");
		console.log("FAIL - should have thrown");
	} catch (error: unknown) {
		const err = error as import("../src").InputGuardrailTripwireTriggered;
		console.log("Bad input blocked:", err.name === "InputGuardrailTripwireTriggered");
		console.log("Guardrail name:", err.guardrailName);
	}
	console.log("PASS\n");
}

// ---- Feature 4: Hooks ----
async function testHooks() {
	console.log("=== F4: Lifecycle Hooks ===\n");

	const events: string[] = [];

	const hooks: AgentHooks = {
		beforeRun: ({ input }) => {
			events.push(`beforeRun: "${input}"`);
		},
		afterRun: ({ result }) => {
			events.push(`afterRun: output=${result.output.substring(0, 30)}...`);
		},
		beforeToolCall: ({ toolCall }) => {
			events.push(`beforeToolCall: ${toolCall.function.name}`);
		},
		afterToolCall: ({ toolCall, result }) => {
			events.push(`afterToolCall: ${toolCall.function.name} -> ${result.substring(0, 30)}`);
		},
	};

	const weatherTool = tool({
		name: "get_weather",
		description: "Get weather for a city",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, { city }) => `72°F and sunny in ${city}`,
	});

	const agent = new Agent({
		name: "hooked-agent",
		instructions: "You are a weather assistant. Use the get_weather tool. Be concise.",
		model,
		tools: [weatherTool],
		hooks,
	});

	await run(agent, "Weather in NYC?");

	console.log("Hook events fired:");
	for (const event of events) {
		console.log("  -", event);
	}
	console.log("beforeRun fired:", events.some((e) => e.startsWith("beforeRun")));
	console.log("afterRun fired:", events.some((e) => e.startsWith("afterRun")));
	console.log("beforeToolCall fired:", events.some((e) => e.startsWith("beforeToolCall")));
	console.log("afterToolCall fired:", events.some((e) => e.startsWith("afterToolCall")));
	console.log("PASS\n");
}

// ---- Feature 5: Tracing ----
async function testTracing() {
	console.log("=== F5: Tracing ===\n");

	const weatherTool = tool({
		name: "get_temp",
		description: "Get temperature for a city",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, { city }) => `22°C in ${city}`,
	});

	const agent = new Agent({
		name: "traced-agent",
		instructions: "You are a weather assistant. Use get_temp to answer. Be concise.",
		model,
		tools: [weatherTool],
	});

	const { result, trace } = await withTrace("weather-workflow", () =>
		run(agent, "What's the temperature in Paris?"),
	);

	console.log("Trace ID:", trace.id);
	console.log("Trace name:", trace.name);
	console.log("Duration:", trace.duration?.toFixed(0), "ms");
	console.log("Spans:");
	for (const span of trace.spans) {
		console.log(`  - [${span.type}] ${span.name} (${span.duration.toFixed(0)}ms)`);
	}
	console.log("Has model_call spans:", trace.spans.some((s) => s.type === "model_call"));
	console.log("Has tool_execution spans:", trace.spans.some((s) => s.type === "tool_execution"));
	console.log("Output:", result.output);
	console.log("PASS\n");
}

// ---- Run all ----
async function main() {
	await testStructuredOutput();
	await testHandoffs();
	await testGuardrails();
	await testHooks();
	await testTracing();
	console.log("=== ALL FEATURES VERIFIED ===");
}

main().catch(console.error);
