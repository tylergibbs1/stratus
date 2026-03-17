import { z } from "zod";
import {
	Agent,
	AzureChatCompletionsModel,
	AzureResponsesModel,
	run,
	stream,
	tool,
	handoff,
	subagent,
	todoTool,
	TodoList,
	createSession,
	resumeSession,
	forkSession,
	withTrace,
	createCostEstimator,
	RunAbortedError,
	InputGuardrailTripwireTriggered,
} from "../src";
import type { InputGuardrail, OutputGuardrail } from "../src/core/guardrails";
import type { Model } from "../src/core/model";

// ── Model configs ──

interface ModelConfig {
	name: string;
	modelClass: string;
	factory: () => Model;
}

const models: ModelConfig[] = [];

// Load configs from JSON (gitignored, has API keys)
try {
	const configs = require("./test-models.json") as {
		name: string;
		type?: "chat-completions" | "responses";
		endpoint: string;
		apiKey: string;
		deployment: string;
	}[];
	for (const c of configs) {
		const type = c.type ?? "chat-completions";
		const label = type === "responses" ? "ResponsesModel" : "ChatCompletions";
		models.push({
			name: `${c.name} (${label})`,
			modelClass: type === "responses" ? "AzureResponsesModel" : "AzureChatCompletionsModel",
			factory: () =>
				type === "responses"
					? new AzureResponsesModel({
							endpoint: c.endpoint,
							apiKey: c.apiKey,
							deployment: c.deployment,
						})
					: new AzureChatCompletionsModel({
							endpoint: c.endpoint,
							apiKey: c.apiKey,
							deployment: c.deployment,
						}),
		});
	}
} catch {
	// test-models.json missing — skip
}

// Add standard Azure OpenAI endpoints from env vars
const aoaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const aoaiKey = process.env.AZURE_OPENAI_API_KEY;
const aoaiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat";

if (aoaiEndpoint && aoaiKey) {
	models.push({
		name: `${aoaiDeployment} (ChatCompletions)`,
		modelClass: "AzureChatCompletionsModel",
		factory: () =>
			new AzureChatCompletionsModel({
				endpoint: aoaiEndpoint,
				apiKey: aoaiKey,
				deployment: aoaiDeployment,
			}),
	});

	const respDeployment = process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? aoaiDeployment;
	const respEndpoint = process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? aoaiEndpoint;
	const respKey = process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? aoaiKey;

	models.push({
		name: `${respDeployment} (ResponsesModel)`,
		modelClass: "AzureResponsesModel",
		factory: () =>
			new AzureResponsesModel({
				endpoint: respEndpoint,
				apiKey: respKey,
				deployment: respDeployment,
			}),
	});
}

if (models.length === 0) {
	console.error("No models configured. Add test-models.json or set AZURE_OPENAI_* env vars.");
	process.exit(1);
}

// ── Test definitions ──

type TestFn = (model: Model) => Promise<{ pass: boolean; detail: string }>;
const tests: { name: string; fn: TestFn }[] = [];
function addTest(name: string, fn: TestFn) {
	tests.push({ name, fn });
}

// 1. Single tool call
addTest("Single tool call", async (model) => {
	const getWeather = tool({
		name: "get_weather",
		description: "Get the current weather for a city",
		parameters: z.object({ city: z.string() }),
		execute: async (_ctx, { city }) => `72°F and sunny in ${city}`,
	});

	const agent = new Agent({
		name: "weather-bot",
		instructions:
			"You are a weather assistant. Use the get_weather tool to answer weather questions. After getting the result, respond naturally.",
		model,
		tools: [getWeather],
	});

	const result = await run(agent, "What's the weather in Tokyo?");
	const pass = result.output.length > 0 && (result.output.toLowerCase().includes("tokyo") || result.output.includes("72"));
	return { pass, detail: `Output: ${result.output.slice(0, 150)}` };
});

// 2. Multi-tool sequential
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
	const usedBothTools =
		toolCalls.some((c) => c.startsWith("population:")) && toolCalls.some((c) => c.startsWith("country:"));
	return {
		pass: usedBothTools && result.output.length > 0,
		detail: `Tools called: [${toolCalls.join(", ")}] | Output: ${result.output.slice(0, 120)}`,
	};
});

// 3. Structured output
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
	const valid =
		output !== undefined &&
		typeof output.name === "string" &&
		typeof output.age === "number" &&
		typeof output.occupation === "string";
	return { pass: valid, detail: `Parsed: ${JSON.stringify(output)}` };
});

// 4. Streaming
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

// 5. Streaming + tools
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

// 6. Handoffs
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

// 7. Context-aware tools
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

// 8. Todo tracking
addTest("Todo tracking", async (model) => {
	const todos = new TodoList();
	const updates: number[] = [];
	todos.onUpdate((items) => {
		updates.push(items.length);
	});

	const agent = new Agent({
		name: "planner",
		instructions:
			"You are a task planner. Break the user's request into 2-3 steps using the todo_write tool. " +
			"First create all todos as pending, then update them to completed. " +
			"You MUST call todo_write at least twice. Be very concise.",
		model,
		tools: [todoTool(todos)],
	});

	const result = await run(agent, "Plan how to make a sandwich", { maxTurns: 8 });
	const hadTodos = todos.todos.length > 0 || updates.length > 0;
	const completedSome = todos.todos.some((t) => t.status === "completed");
	return {
		pass: hadTodos && updates.length >= 2,
		detail: `Updates: ${updates.length} | Final todos: ${todos.todos.length} | Completed: ${todos.todos.filter((t) => t.status === "completed").length} | Output: ${result.output.slice(0, 80)}`,
	};
});

// 9. Streaming + todos
addTest("Streaming + todos", async (model) => {
	const todos = new TodoList();
	let updateCount = 0;
	todos.onUpdate(() => {
		updateCount++;
	});

	const agent = new Agent({
		name: "streamer-planner",
		instructions:
			"Break the task into 2 steps using todo_write. Create them as pending, then mark them completed. " +
			"Call todo_write at least twice.",
		model,
		tools: [todoTool(todos)],
	});

	const { stream: s, result } = stream(agent, "Plan how to boil an egg", { maxTurns: 8 });
	let contentChunks = 0;
	for await (const event of s) {
		if (event.type === "content_delta") contentChunks++;
	}
	await result;

	return {
		pass: updateCount >= 2,
		detail: `Todo updates: ${updateCount} | Content chunks: ${contentChunks} | Final todos: ${todos.todos.length}`,
	};
});

// 10. Subagents
addTest("Subagents", async (model) => {
	const researcher = new Agent({
		name: "researcher",
		instructions: "You are a research assistant. Answer the research query concisely in 1-2 sentences.",
		model,
	});

	const parentAgent = new Agent({
		name: "coordinator",
		instructions:
			"You coordinate research. Use the run_researcher tool to delegate research questions, then summarize the result.",
		model,
		subagents: [
			subagent({
				agent: researcher,
				inputSchema: z.object({ query: z.string().describe("The research question") }),
				mapInput: ({ query }) => query,
			}),
		],
	});

	const result = await run(parentAgent, "What is the capital of France?", { maxTurns: 5 });
	const mentionsParis = result.output.toLowerCase().includes("paris");
	return {
		pass: result.output.length > 0 && mentionsParis,
		detail: `Output: ${result.output.slice(0, 150)}`,
	};
});

// 11. Hooks (beforeToolCall / afterToolCall)
addTest("Hooks", async (model) => {
	const hookLog: string[] = [];

	const greet = tool({
		name: "greet",
		description: "Generate a greeting for a person",
		parameters: z.object({ name: z.string() }),
		execute: async (_ctx, { name }) => `Hello, ${name}!`,
	});

	const agent = new Agent({
		name: "greeter",
		instructions: "Use the greet tool to greet the person mentioned by the user.",
		model,
		tools: [greet],
		hooks: {
			beforeToolCall: ({ toolCall }) => {
				hookLog.push(`before:${toolCall.function.name}`);
				return { decision: "allow" as const };
			},
			afterToolCall: ({ toolCall, result }) => {
				hookLog.push(`after:${toolCall.function.name}:${result.slice(0, 20)}`);
			},
		},
	});

	const result = await run(agent, "Say hi to Alice");
	const hasBefore = hookLog.some((l) => l.startsWith("before:"));
	const hasAfter = hookLog.some((l) => l.startsWith("after:"));
	return {
		pass: hasBefore && hasAfter && result.output.length > 0,
		detail: `Hooks: [${hookLog.join(", ")}] | Output: ${result.output.slice(0, 80)}`,
	};
});

// 12. Sessions (multi-turn with save/resume)
addTest("Sessions", async (model) => {
	const session = createSession({
		model,
		instructions: "You are a helpful assistant. Be very concise.",
	});

	// Turn 1
	session.send("My name is Alice. Remember it.");
	for await (const _event of session.stream()) {}
	const r1 = await session.result;

	// Turn 2 — should remember context
	session.send("What is my name?");
	for await (const _event of session.stream()) {}
	const r2 = await session.result;
	const remembersName = r2.output.toLowerCase().includes("alice");

	// Save and resume
	const snapshot = session.save();
	const resumed = resumeSession(snapshot, {
		model,
		instructions: "You are a helpful assistant. Be very concise.",
	});
	resumed.send("Say my name again.");
	for await (const _event of resumed.stream()) {}
	const r3 = await resumed.result;
	const resumedRemembersName = r3.output.toLowerCase().includes("alice");

	session.close();
	resumed.close();

	return {
		pass: remembersName && resumedRemembersName,
		detail: `Turn2: "${r2.output.slice(0, 60)}" | Resumed: "${r3.output.slice(0, 60)}"`,
	};
});

// 13. Guardrails (input validation)
addTest("Guardrails", async (model) => {
	const bannedWordGuardrail: InputGuardrail = {
		name: "banned_words",
		execute: (input) => ({
			tripwireTriggered: input.toLowerCase().includes("hack"),
			outputInfo: "Input contained banned word",
		}),
	};

	const agent = new Agent({
		name: "guarded-bot",
		instructions: "You are a helpful assistant.",
		model,
		inputGuardrails: [bannedWordGuardrail],
	});

	// Should pass — no banned words
	const result = await run(agent, "Hello, how are you?");
	const passedClean = result.output.length > 0;

	// Should trip — contains "hack"
	let tripped = false;
	try {
		await run(agent, "How do I hack a server?");
	} catch (err) {
		if (err instanceof InputGuardrailTripwireTriggered) {
			tripped = true;
		}
	}

	return {
		pass: passedClean && tripped,
		detail: `Clean input passed: ${passedClean} | Banned input tripped: ${tripped}`,
	};
});

// 14. Tracing
addTest("Tracing", async (model) => {
	const getTime = tool({
		name: "get_time",
		description: "Get the current time",
		parameters: z.object({}),
		execute: async () => "3:45 PM",
	});

	const agent = new Agent({
		name: "time-bot",
		instructions: "Use the get_time tool to answer time questions.",
		model,
		tools: [getTime],
	});

	const { result, trace } = await withTrace("test-trace", () =>
		run(agent, "What time is it?"),
	);

	const hasModelSpan = trace.spans.some((s) => s.type === "model_call");
	const hasToolSpan = trace.spans.some((s) => s.type === "tool_execution");
	const hasDuration = (trace.duration ?? 0) > 0;

	return {
		pass: hasModelSpan && hasToolSpan && hasDuration && result.output.length > 0,
		detail: `Spans: ${trace.spans.map((s) => `${s.type}(${s.duration?.toFixed(0)}ms)`).join(", ")} | Trace: ${trace.duration?.toFixed(0)}ms`,
	};
});

// 15. Usage & Cost tracking
addTest("Usage & cost tracking", async (model) => {
	const estimator = createCostEstimator({
		inputTokenCostPer1k: 0.01,
		outputTokenCostPer1k: 0.03,
	});

	const agent = new Agent({
		name: "cost-bot",
		instructions: "You are a helpful assistant. Be very concise.",
		model,
	});

	const result = await run(agent, "Say hello in one word.", { costEstimator: estimator });

	const hasUsage = result.usage.totalTokens > 0;
	const hasCost = result.totalCostUsd > 0;
	const hasTurns = result.numTurns > 0;

	return {
		pass: hasUsage && hasCost && hasTurns,
		detail: `Tokens: ${result.usage.totalTokens} | Cost: $${result.totalCostUsd.toFixed(6)} | Turns: ${result.numTurns}`,
	};
});

// 16. Abort signals
addTest("Abort signals", async (model) => {
	const agent = new Agent({
		name: "slow-bot",
		instructions: "You are a helpful assistant.",
		model,
	});

	// Pre-abort the signal before calling run
	const controller = new AbortController();
	controller.abort();

	let aborted = false;
	try {
		await run(agent, "Hello", { signal: controller.signal });
	} catch (err) {
		if (err instanceof RunAbortedError) {
			aborted = true;
		}
	}

	return {
		pass: aborted,
		detail: `Pre-aborted signal caught: ${aborted}`,
	};
});

// ── Runner (models in parallel, tests sequential per model) ──

interface TestResult {
	name: string;
	status: "PASS" | "FAIL" | "ERROR";
	detail: string;
}

interface ModelResult {
	model: string;
	results: TestResult[];
	passed: number;
	failed: number;
}

async function runModelTests(config: ModelConfig): Promise<ModelResult> {
	const model = config.factory();
	const results: TestResult[] = [];
	let passed = 0;
	let failed = 0;

	for (const test of tests) {
		try {
			const result = await test.fn(model);
			if (result.pass) {
				passed++;
				results.push({ name: test.name, status: "PASS", detail: result.detail });
			} else {
				failed++;
				results.push({ name: test.name, status: "FAIL", detail: result.detail });
			}
		} catch (err) {
			failed++;
			const msg = err instanceof Error ? err.message : String(err);
			results.push({ name: test.name, status: "ERROR", detail: msg.slice(0, 200) });
		}
	}

	return { model: config.name, results, passed, failed };
}

console.log("=== Comprehensive Agentic Workflow Tests ===");
console.log(`Models: ${models.length} | Tests: ${tests.length}`);
console.log(`Running all models in parallel...\n`);

const startTime = performance.now();

const modelResults = await Promise.all(models.map((config) => runModelTests(config)));

const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

// Print results
for (const mr of modelResults) {
	console.log(`${"=".repeat(60)}`);
	console.log(`  ${mr.model}  (${mr.passed}/${mr.passed + mr.failed})`);
	console.log(`${"=".repeat(60)}`);

	for (const r of mr.results) {
		console.log(`  ${r.name.padEnd(28)} ${r.status}`);
		console.log(`    ${r.detail}`);
	}
	console.log();
}

// Summary table
console.log(`${"=".repeat(60)}`);
console.log("  SUMMARY");
console.log(`${"=".repeat(60)}`);

for (const mr of modelResults) {
	const status = mr.failed === 0 ? "ALL PASS" : `${mr.passed}/${mr.passed + mr.failed}`;
	console.log(`  ${mr.model.padEnd(40)} ${status}`);
}

const totalPassed = modelResults.reduce((a, mr) => a + mr.passed, 0);
const totalTests = modelResults.reduce((a, mr) => a + mr.passed + mr.failed, 0);
console.log(`\n  Total: ${totalPassed}/${totalTests} across ${modelResults.length} models in ${elapsed}s`);
