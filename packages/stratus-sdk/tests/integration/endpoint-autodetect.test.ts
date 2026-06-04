import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { Agent } from "../../src/core/agent";
import { handoff } from "../../src/core/handoff";
import { run, stream } from "../../src/core/run";
import { createSession } from "../../src/core/session";
import { tool } from "../../src/core/tool";

// ─── Env ────────────────────────────────────────────────────────────────

const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
const apiKey = process.env.AZURE_OPENAI_API_KEY!;
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat";
const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
const responsesDeployment = process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? deployment;

// ─── Helpers: build model from different URL shapes ─────────────────────

function chatModel(ep: string) {
	return new AzureChatCompletionsModel({ endpoint: ep, apiKey, deployment, apiVersion });
}
function responsesModel(ep: string) {
	return new AzureResponsesModel({ endpoint: ep, apiKey, deployment: responsesDeployment });
}

const fullChatUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
const fullResponsesUrl = `${endpoint}/openai/v1/responses`;

// ─── Shared tools ───────────────────────────────────────────────────────

const getWeather = tool({
	name: "get_weather",
	description: "Get the current weather for a city",
	parameters: z.object({ city: z.string().describe("The city name") }),
	execute: async (_ctx, { city }) => {
		const data: Record<string, string> = {
			"New York": "72°F, sunny",
			London: "55°F, cloudy",
			Tokyo: "85°F, humid",
		};
		return data[city] ?? `No weather data for ${city}`;
	},
});

const calculate = tool({
	name: "calculate",
	description: "Evaluate a math expression and return the result",
	parameters: z.object({ expression: z.string().describe("e.g. '2 + 2'") }),
	execute: async (_ctx, { expression }) => {
		try {
			const result = new Function(`return (${expression})`)();
			return String(result);
		} catch {
			return `Error evaluating "${expression}"`;
		}
	},
});

// ─── Chat Completions: bare endpoint ────────────────────────────────────

describe("Chat Completions — bare endpoint", () => {
	const model = chatModel(endpoint);

	test("simple run", async () => {
		const agent = new Agent({ name: "test", model, instructions: "Reply in one sentence." });
		const result = await run(agent, "What is the capital of France?");
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.finishReason).toBe("stop");
	}, 30000);

	test("tool call round-trip", async () => {
		const agent = new Agent({
			name: "weather",
			model,
			tools: [getWeather],
			instructions: "Use get_weather to answer. Be concise.",
		});
		const result = await run(agent, "What's the weather in Tokyo?");
		expect(result.output).toContain("85");
	}, 30000);

	test("streaming", async () => {
		const agent = new Agent({ name: "test", model, instructions: "Reply briefly." });
		const { stream: s, result } = stream(agent, "Say hello.");
		const types: string[] = [];
		for await (const event of s) {
			types.push(event.type);
		}
		const r = await result;
		expect(types).toContain("content_delta");
		expect(types).toContain("done");
		expect(r.output.length).toBeGreaterThan(0);
	}, 30000);

	test("session multi-turn", async () => {
		const session = createSession({ model, instructions: "You are a helpful assistant." });
		session.send("My name is Alice.");
		for await (const _ of session.stream()) {
			/* drain */
		}
		session.send("What is my name?");
		const events: string[] = [];
		for await (const event of session.stream()) {
			events.push(event.type);
		}
		const r = await session.result;
		expect(r.output.toLowerCase()).toContain("alice");
	}, 60000);

	test("structured output", async () => {
		const agent = new Agent({
			name: "extractor",
			model,
			instructions: "Extract the city and country from the user's message.",
			outputType: z.object({
				city: z.string(),
				country: z.string(),
			}),
		});
		const result = await run(agent, "I live in Paris, France.");
		expect(result.finalOutput).toEqual({ city: "Paris", country: "France" });
	}, 30000);

	test("handoff between agents", async () => {
		const spanishAgent = new Agent({
			name: "spanish_agent",
			model,
			instructions: "You only speak Spanish. Reply in Spanish.",
		});
		const triageAgent = new Agent({
			name: "triage",
			model,
			instructions:
				"You are a triage agent. If the user asks for Spanish, hand off to the spanish_agent.",
			handoffs: [handoff({ agent: spanishAgent })],
		});
		const result = await run(triageAgent, "I'd like to speak Spanish please.", { maxTurns: 5 });
		expect(result.lastAgent.name).toBe("spanish_agent");
		expect(result.output.length).toBeGreaterThan(0);
	}, 60000);
});

// ─── Chat Completions — trailing slash ──────────────────────────────────

describe("Chat Completions — trailing slash", () => {
	const model = chatModel(`${endpoint}/`);

	test("tool call + streaming", async () => {
		const agent = new Agent({
			name: "weather",
			model,
			tools: [getWeather],
			instructions: "Use get_weather to answer. Be concise.",
		});
		const { stream: s, result } = stream(agent, "Weather in London?");
		const types: string[] = [];
		for await (const event of s) {
			types.push(event.type);
		}
		const r = await result;
		expect(types).toContain("content_delta");
		expect(r.output).toContain("55");
	}, 30000);
});

// ─── Chat Completions — full URL ────────────────────────────────────────

describe("Chat Completions — full URL", () => {
	const model = chatModel(fullChatUrl);

	test("run with tool ignores deployment/apiVersion config", async () => {
		const m = new AzureChatCompletionsModel({
			endpoint: fullChatUrl,
			apiKey,
			deployment: "this-is-ignored",
			apiVersion: "also-ignored",
		});
		const agent = new Agent({
			name: "weather",
			model: m,
			tools: [getWeather],
			instructions: "Use get_weather to answer. Be concise.",
		});
		const result = await run(agent, "What's the weather in New York?");
		expect(result.output).toContain("72");
	}, 30000);

	test("structured output via full URL", async () => {
		const agent = new Agent({
			name: "extractor",
			model,
			instructions: "Extract numbers from the user's message.",
			outputType: z.object({ numbers: z.array(z.number()) }),
		});
		const result = await run(agent, "I have 3 cats and 7 dogs.");
		expect(result.finalOutput!.numbers).toContain(3);
		expect(result.finalOutput!.numbers).toContain(7);
	}, 30000);
});

// ─── Responses API — bare endpoint ──────────────────────────────────────

describe("Responses API — bare endpoint", () => {
	const model = responsesModel(endpoint);

	test("simple run with usage", async () => {
		const agent = new Agent({ name: "test", model, instructions: "Reply in one sentence." });
		const result = await run(agent, "What is 2 + 2?");
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.usage.promptTokens).toBeGreaterThan(0);
		expect(result.usage.completionTokens).toBeGreaterThan(0);
	}, 30000);

	test("tool call round-trip", async () => {
		const agent = new Agent({
			name: "calc",
			model,
			tools: [calculate],
			instructions: "Use the calculate tool. Reply with just the number.",
		});
		const result = await run(agent, "What is 15 * 23?");
		expect(result.output).toContain("345");
	}, 30000);

	test("streaming with tool calls", async () => {
		const agent = new Agent({
			name: "weather",
			model,
			tools: [getWeather],
			instructions: "Use get_weather to answer. Be concise.",
		});
		const { stream: s, result } = stream(agent, "Weather in New York?");
		const types = new Set<string>();
		for await (const event of s) {
			types.add(event.type);
		}
		const r = await result;
		expect(types.has("content_delta")).toBe(true);
		expect(types.has("done")).toBe(true);
		expect(r.output).toContain("72");
	}, 30000);

	test("session multi-turn", async () => {
		const session = createSession({ model, instructions: "You are a helpful assistant." });
		session.send("Remember: the secret word is pineapple.");
		for await (const _ of session.stream()) {
			/* drain */
		}
		session.send("What is the secret word?");
		for await (const _ of session.stream()) {
			/* drain */
		}
		const r = await session.result;
		expect(r.output.toLowerCase()).toContain("pineapple");
	}, 60000);

	test("structured output", async () => {
		const agent = new Agent({
			name: "extractor",
			model,
			instructions: "Extract the person's name and age from the message.",
			outputType: z.object({ name: z.string(), age: z.number() }),
		});
		const result = await run(agent, "Bob is 42 years old.");
		expect(result.finalOutput).toEqual({ name: "Bob", age: 42 });
	}, 30000);

	test("handoff between agents", async () => {
		const mathAgent = new Agent({
			name: "math_agent",
			model,
			tools: [calculate],
			instructions: "You are a math expert. Use the calculate tool to solve problems.",
		});
		const triageAgent = new Agent({
			name: "triage",
			model,
			instructions: "You are a triage agent. Hand off math questions to the math_agent.",
			handoffs: [handoff({ agent: mathAgent })],
		});
		const result = await run(triageAgent, "What is 99 * 101?", { maxTurns: 6 });
		expect(result.lastAgent.name).toBe("math_agent");
		expect(result.output).toContain("9999");
	}, 60000);
});

// ─── Responses API — trailing slash ─────────────────────────────────────

describe("Responses API — trailing slash", () => {
	const model = responsesModel(`${endpoint}/`);

	test("tool call + streaming", async () => {
		const agent = new Agent({
			name: "weather",
			model,
			tools: [getWeather],
			instructions: "Use get_weather to answer. Be concise.",
		});
		const { stream: s, result } = stream(agent, "Weather in Tokyo?");
		const types = new Set<string>();
		for await (const event of s) {
			types.add(event.type);
		}
		const r = await result;
		expect(types.has("content_delta")).toBe(true);
		expect(r.output).toContain("85");
	}, 30000);
});

// ─── Responses API — full URL ───────────────────────────────────────────

describe("Responses API — full URL", () => {
	const model = responsesModel(fullResponsesUrl);

	test("run with tool ignores apiVersion config", async () => {
		const m = new AzureResponsesModel({
			endpoint: fullResponsesUrl,
			apiKey,
			deployment: responsesDeployment,
			apiVersion: "this-is-ignored",
		});
		const agent = new Agent({
			name: "weather",
			model: m,
			tools: [getWeather],
			instructions: "Use get_weather to answer. Be concise.",
		});
		const result = await run(agent, "What's the weather in London?");
		expect(result.output).toContain("55");
	}, 30000);

	test("structured output via full URL", async () => {
		const agent = new Agent({
			name: "classifier",
			model,
			instructions: "Classify the sentiment of the message.",
			outputType: z.object({
				sentiment: z.enum(["positive", "negative", "neutral"]),
				confidence: z.number(),
			}),
		});
		const result = await run(agent, "I absolutely love this product, best purchase ever!");
		expect(result.finalOutput!.sentiment).toBe("positive");
		expect(result.finalOutput!.confidence).toBeGreaterThan(0);
	}, 30000);
});
