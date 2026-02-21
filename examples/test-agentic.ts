import { z } from "zod";
import {
	Agent,
	AzureChatCompletionsModel,
	run,
	stream,
	tool,
	handoff,
} from "../src";
import type { Model } from "../src/core/model";
import configs from "./test-models.json";

// ── Helpers ──

function makeModel(config: (typeof configs)[number]): Model {
	return new AzureChatCompletionsModel({
		endpoint: config.endpoint,
		apiKey: config.apiKey,
		deployment: config.deployment,
	});
}

type TestFn = (model: Model) => Promise<{ pass: boolean; detail: string }>;

const tests: { name: string; fn: TestFn }[] = [];
function addTest(name: string, fn: TestFn) {
	tests.push({ name, fn });
}

// ── Test 1: Single tool call ──

addTest("Single tool call", async (model) => {
	const getWeather = tool({
		name: "get_weather",
		description: "Get the current weather for a city",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, { city }) => `72°F and sunny in ${city}`,
	});

	const agent = new Agent({
		name: "weather-bot",
		instructions: "You are a weather assistant. Use the get_weather tool to answer weather questions. After getting the result, respond naturally.",
		model,
		tools: [getWeather],
	});

	const result = await run(agent, "What's the weather in Tokyo?");
	const hasContent = result.output.length > 0;
	const mentionsTokyo = result.output.toLowerCase().includes("tokyo");
	const mentions72 = result.output.includes("72");
	return {
		pass: hasContent && (mentionsTokyo || mentions72),
		detail: `Output: ${result.output.slice(0, 150)}`,
	};
});

// ── Test 2: Multi-tool call (sequential) ──

addTest("Multi-tool sequential", async (model) => {
	const toolCalls: string[] = [];

	const getPopulation = tool({
		name: "get_population",
		description: "Get the population of a city",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, { city }) => {
			toolCalls.push(`population:${city}`);
			const pops: Record<string, string> = { Paris: "2.1 million", London: "8.9 million" };
			return pops[city] ?? "unknown";
		},
	});

	const getCountry = tool({
		name: "get_country",
		description: "Get the country a city is in",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, { city }) => {
			toolCalls.push(`country:${city}`);
			const countries: Record<string, string> = { Paris: "France", London: "United Kingdom" };
			return countries[city] ?? "unknown";
		},
	});

	const agent = new Agent({
		name: "city-bot",
		instructions: "Answer questions about cities. Use tools to look up facts. Use both tools for each city asked about.",
		model,
		tools: [getPopulation, getCountry],
	});

	const result = await run(agent, "What country is Paris in and what's its population?", { maxTurns: 5 });
	const usedBothTools = toolCalls.some((c) => c.startsWith("population:")) && toolCalls.some((c) => c.startsWith("country:"));
	return {
		pass: usedBothTools && result.output.length > 0,
		detail: `Tools called: [${toolCalls.join(", ")}] | Output: ${result.output.slice(0, 120)}`,
	};
});

// ── Test 3: Structured output ──

addTest("Structured output", async (model) => {
	const PersonSchema = z.object({
		name: z.string(),
		age: z.number(),
		occupation: z.string(),
	});

	const agent = new Agent({
		name: "extractor",
		instructions: "Extract person information from the text. Return JSON matching the schema.",
		model,
		outputType: PersonSchema,
	});

	const result = await run(agent, "Marie Curie was a 66-year-old physicist and chemist.");
	const output = result.finalOutput;
	const valid = output !== undefined && typeof output.name === "string" && typeof output.age === "number" && typeof output.occupation === "string";
	return {
		pass: valid,
		detail: `Parsed: ${JSON.stringify(output)}`,
	};
});

// ── Test 4: Streaming ──

addTest("Streaming", async (model) => {
	const agent = new Agent({
		name: "storyteller",
		instructions: "You are a helpful assistant. Be very brief.",
		model,
	});

	const { stream: s, result } = stream(agent, "Say hello in exactly 5 words.");
	let chunks = 0;
	let content = "";
	for await (const event of s) {
		if (event.type === "content_delta") {
			chunks++;
			content += event.content;
		}
	}
	const finalResult = await result;
	return {
		pass: chunks > 1 && content.length > 0 && finalResult.output.length > 0,
		detail: `${chunks} chunks | Streamed: "${content.slice(0, 80)}" | Final: "${finalResult.output.slice(0, 80)}"`,
	};
});

// ── Test 5: Streaming with tool calls ──

addTest("Streaming + tools", async (model) => {
	let toolExecuted = false;

	const calculator = tool({
		name: "calculate",
		description: "Evaluate a math expression",
		parameters: z.object({ expression: z.string() }),
		execute: async (_ctx, { expression }) => {
			toolExecuted = true;
			try {
				return String(eval(expression));
			} catch {
				return "error";
			}
		},
	});

	const agent = new Agent({
		name: "math-bot",
		instructions: "You are a math assistant. Always use the calculate tool for math. Respond with the result.",
		model,
		tools: [calculator],
	});

	const { stream: s, result } = stream(agent, "What is 137 * 29?");
	const events: string[] = [];
	for await (const event of s) {
		if (!events.includes(event.type)) events.push(event.type);
	}
	const finalResult = await result;
	return {
		pass: toolExecuted && finalResult.output.length > 0,
		detail: `Events: [${events.join(", ")}] | Tool ran: ${toolExecuted} | Output: ${finalResult.output.slice(0, 100)}`,
	};
});

// ── Test 6: Handoffs ──

addTest("Handoffs", async (model) => {
	const spanishAgent = new Agent({
		name: "spanish_translator",
		instructions: "You are a Spanish translator. Translate the user's message to Spanish. Only output the translation.",
		model,
		handoffDescription: "Transfer to translate text to Spanish",
	});

	const triageAgent = new Agent({
		name: "triage",
		instructions: "You are a router. If the user wants a translation, hand off to the spanish_translator.",
		model,
		handoffs: [spanishAgent],
	});

	const result = await run(triageAgent, "Translate 'hello world' to Spanish", { maxTurns: 5 });
	const handedOff = result.lastAgent.name === "spanish_translator";
	return {
		pass: handedOff && result.output.length > 0,
		detail: `Last agent: ${result.lastAgent.name} | Output: ${result.output.slice(0, 100)}`,
	};
});

// ── Test 7: Context-aware tools ──

addTest("Context-aware tools", async (model) => {
	type UserCtx = { userId: string; permissions: string[] };

	const getProfile = tool({
		name: "get_profile",
		description: "Get the current user's profile",
		parameters: z.object({}),
		execute: async (ctx: UserCtx) => {
			return `User ${ctx.userId} with permissions: ${ctx.permissions.join(", ")}`;
		},
	});

	const agent = new Agent<UserCtx>({
		name: "profile-bot",
		instructions: "Look up the user's profile using the tool and summarize it.",
		model,
		tools: [getProfile],
	});

	const context: UserCtx = { userId: "usr_123", permissions: ["read", "write", "admin"] };
	const result = await run(agent, "What's my profile?", { context });
	const mentionsUser = result.output.includes("123") || result.output.toLowerCase().includes("user");
	return {
		pass: result.output.length > 0 && mentionsUser,
		detail: `Output: ${result.output.slice(0, 150)}`,
	};
});

// ── Runner ──

console.log("=== Agentic Workflow Tests ===\n");

for (const config of configs) {
	const model = makeModel(config);
	console.log(`\n${"=".repeat(50)}`);
	console.log(`MODEL: ${config.name}`);
	console.log(`${"=".repeat(50)}`);

	let passed = 0;
	let failed = 0;

	for (const test of tests) {
		process.stdout.write(`  ${test.name}... `);
		try {
			const result = await test.fn(model);
			if (result.pass) {
				passed++;
				console.log(`PASS`);
				console.log(`    ${result.detail}`);
			} else {
				failed++;
				console.log(`FAIL`);
				console.log(`    ${result.detail}`);
			}
		} catch (err) {
			failed++;
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`ERROR`);
			console.log(`    ${msg.slice(0, 200)}`);
		}
	}

	console.log(`\n  Result: ${passed}/${passed + failed} passed`);
}
