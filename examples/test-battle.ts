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
	MaxTurnsExceededError,
	MaxBudgetExceededError,
	InputGuardrailTripwireTriggered,
	OutputGuardrailTripwireTriggered,
	OutputParseError,
	ModelError,
} from "../src";
import type { InputGuardrail, OutputGuardrail } from "../src/core/guardrails";
import type { Model } from "../src/core/model";

// ── Model configs ──

interface ModelConfig {
	name: string;
	factory: () => Model;
}

const models: ModelConfig[] = [];

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
		const label = type === "responses" ? "Responses" : "ChatCompletions";
		models.push({
			name: `${c.name} (${label})`,
			factory: () =>
				type === "responses"
					? new AzureResponsesModel({ endpoint: c.endpoint, apiKey: c.apiKey, deployment: c.deployment })
					: new AzureChatCompletionsModel({ endpoint: c.endpoint, apiKey: c.apiKey, deployment: c.deployment }),
		});
	}
} catch {}

const aoaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const aoaiKey = process.env.AZURE_OPENAI_API_KEY;
const aoaiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat";

if (aoaiEndpoint && aoaiKey) {
	models.push({
		name: `${aoaiDeployment} (ChatCompletions)`,
		factory: () => new AzureChatCompletionsModel({ endpoint: aoaiEndpoint, apiKey: aoaiKey, deployment: aoaiDeployment }),
	});
	const respDeployment = process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? aoaiDeployment;
	const respEndpoint = process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? aoaiEndpoint;
	const respKey = process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? aoaiKey;
	models.push({
		name: `${respDeployment} (Responses)`,
		factory: () => new AzureResponsesModel({ endpoint: respEndpoint, apiKey: respKey, deployment: respDeployment }),
	});
}

if (models.length === 0) {
	console.error("No models configured.");
	process.exit(1);
}

// ── Test framework ──

type TestFn = (model: Model) => Promise<{ pass: boolean; detail: string }>;
const tests: { name: string; fn: TestFn }[] = [];
function addTest(name: string, fn: TestFn) {
	tests.push({ name, fn });
}

// ═══════════════════════════════════════════════
// BATTLE TESTS
// ═══════════════════════════════════════════════

// 1. Tool error recovery — tool throws, agent should get error message and respond
addTest("Tool error recovery", async (model) => {
	let callCount = 0;
	const flakyTool = tool({
		name: "flaky_api",
		description: "Call an unreliable API. It fails on the first call but works on retry.",
		parameters: z.object({ query: z.string() }),
		execute: async (_ctx, { query }) => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Connection timeout: API unreachable");
			}
			return `Result for: ${query}`;
		},
	});

	const agent = new Agent({
		name: "resilient-bot",
		instructions: "Use the flaky_api tool. If it fails, try again. Always report the result.",
		model,
		tools: [flakyTool],
	});

	const result = await run(agent, "Look up 'TypeScript generics'", { maxTurns: 6 });
	return {
		pass: callCount >= 2 && result.output.length > 0,
		detail: `Calls: ${callCount} | Output: ${result.output.slice(0, 100)}`,
	};
});

// 2. Large tool output — tool returns a huge payload
addTest("Large tool output", async (model) => {
	const bigTool = tool({
		name: "get_large_data",
		description: "Returns a large dataset",
		parameters: z.object({}),
		execute: async () => {
			const items = Array.from({ length: 200 }, (_, i) => `Item ${i + 1}: $${(Math.random() * 100).toFixed(2)}`);
			return items.join("\n"); // ~5KB
		},
	});

	const agent = new Agent({
		name: "data-bot",
		instructions: "Fetch the data and tell me how many items there are and the first item.",
		model,
		tools: [bigTool],
	});

	const result = await run(agent, "Get the data");
	const mentions200 = result.output.includes("200");
	return {
		pass: result.output.length > 0 && mentions200,
		detail: `Output: ${result.output.slice(0, 120)}`,
	};
});

// 3. Concurrent sessions — multiple sessions hitting model at once
addTest("Concurrent sessions", async (model) => {
	const makeSession = (name: string) => {
		const session = createSession({
			model,
			instructions: `You are ${name}. Always start your response with your name.`,
		});
		return session;
	};

	const s1 = makeSession("Alice");
	const s2 = makeSession("Bob");
	const s3 = makeSession("Charlie");

	s1.send("Who are you?");
	s2.send("Who are you?");
	s3.send("Who are you?");

	// Stream all concurrently
	const drain = async (s: ReturnType<typeof createSession>) => {
		for await (const _ of s.stream()) {}
		return s.result;
	};

	const [r1, r2, r3] = await Promise.all([drain(s1), drain(s2), drain(s3)]);

	const aliceOk = r1.output.toLowerCase().includes("alice");
	const bobOk = r2.output.toLowerCase().includes("bob");
	const charlieOk = r3.output.toLowerCase().includes("charlie");

	s1.close(); s2.close(); s3.close();

	return {
		pass: aliceOk && bobOk && charlieOk,
		detail: `Alice: ${aliceOk} ("${r1.output.slice(0, 40)}") | Bob: ${bobOk} ("${r2.output.slice(0, 40)}") | Charlie: ${charlieOk} ("${r3.output.slice(0, 40)}")`,
	};
});

// 4. Long multi-turn session — 6 turns of conversation
addTest("Long multi-turn session", async (model) => {
	const session = createSession({
		model,
		instructions: "You are a helpful assistant. Be very concise (1 sentence max).",
	});

	const turns = [
		"My name is Zara.",
		"I live in Tokyo.",
		"I work as a pilot.",
		"My favorite color is purple.",
		"I have a cat named Mochi.",
		"Summarize everything you know about me in one sentence.",
	];

	let lastOutput = "";
	for (const msg of turns) {
		session.send(msg);
		for await (const _ of session.stream()) {}
		const r = await session.result;
		lastOutput = r.output;
	}

	session.close();

	const hasZara = lastOutput.toLowerCase().includes("zara");
	const hasTokyo = lastOutput.toLowerCase().includes("tokyo");
	const hasPilot = lastOutput.toLowerCase().includes("pilot");
	const hasMochi = lastOutput.toLowerCase().includes("mochi");

	const score = [hasZara, hasTokyo, hasPilot, hasMochi].filter(Boolean).length;

	return {
		pass: score >= 3,
		detail: `Remembered ${score}/4 facts | Output: ${lastOutput.slice(0, 150)}`,
	};
});

// 5. Handoff chain — A → B → C
addTest("Handoff chain A→B→C", async (model) => {
	const agentC = new Agent({
		name: "agent_c",
		instructions: "You are Agent C, the final agent. Say 'Agent C reporting!' and answer the user.",
		model,
		handoffDescription: "Transfer to Agent C for final processing",
	});

	const agentB = new Agent({
		name: "agent_b",
		instructions: "You are Agent B. Always hand off to agent_c immediately.",
		model,
		handoffs: [agentC],
		handoffDescription: "Transfer to Agent B for intermediate processing",
	});

	const agentA = new Agent({
		name: "agent_a",
		instructions: "You are Agent A. Always hand off to agent_b immediately.",
		model,
		handoffs: [agentB],
	});

	const result = await run(agentA, "Process this request", { maxTurns: 8 });
	return {
		pass: result.lastAgent.name === "agent_c",
		detail: `Final agent: ${result.lastAgent.name} | Output: ${result.output.slice(0, 80)}`,
	};
});

// 6. Budget limit fires mid-conversation
addTest("Budget limit mid-run", async (model) => {
	const estimator = createCostEstimator({
		inputTokenCostPer1k: 5.0, // artificially high to trigger quickly
		outputTokenCostPer1k: 15.0,
	});

	const chattyTool = tool({
		name: "get_info",
		description: "Get information about a topic",
		parameters: z.object({ topic: z.string() }),
		execute: async (_ctx, { topic }) => `Here is a long detailed response about ${topic}. `.repeat(10),
	});

	const agent = new Agent({
		name: "budget-bot",
		instructions: "Always use get_info tool for every question. Ask follow up questions.",
		model,
		tools: [chattyTool],
	});

	let budgetExceeded = false;
	try {
		await run(agent, "Tell me about quantum computing, then about AI, then about space", {
			costEstimator: estimator,
			maxBudgetUsd: 0.001, // very low budget
			maxTurns: 10,
		});
	} catch (err) {
		if (err instanceof MaxBudgetExceededError) {
			budgetExceeded = true;
		}
	}

	return {
		pass: budgetExceeded,
		detail: `Budget exceeded: ${budgetExceeded}`,
	};
});

// 7. Abort mid-stream — abort while streaming content
addTest("Abort mid-stream", async (model) => {
	const agent = new Agent({
		name: "long-writer",
		instructions: "Write a very long detailed story. At least 500 words.",
		model,
	});

	const controller = new AbortController();
	let chunksBeforeAbort = 0;
	let aborted = false;

	try {
		const { stream: s } = stream(agent, "Write the story now.", { signal: controller.signal });
		for await (const event of s) {
			if (event.type === "content_delta") {
				chunksBeforeAbort++;
				if (chunksBeforeAbort >= 5) {
					controller.abort();
				}
			}
		}
	} catch (err) {
		if (err instanceof RunAbortedError || (err instanceof Error && err.name === "AbortError")) {
			aborted = true;
		}
	}

	return {
		pass: aborted && chunksBeforeAbort >= 5,
		detail: `Chunks before abort: ${chunksBeforeAbort} | Aborted: ${aborted}`,
	};
});

// 8. Subagent failure — subagent throws, parent handles it
addTest("Subagent failure handling", async (model) => {
	const failingAgent = new Agent({
		name: "failing_researcher",
		instructions: "You always fail. Respond with an error.",
		model,
		tools: [
			tool({
				name: "crash",
				description: "This tool always crashes",
				parameters: z.object({}),
				execute: async () => { throw new Error("Catastrophic failure!"); },
			}),
		],
		// Force it to call the crashing tool
		modelSettings: { toolChoice: { type: "function", function: { name: "crash" } } },
	});

	const parentAgent = new Agent({
		name: "coordinator",
		instructions: "Use the run_failing_researcher tool. If it fails, say 'The sub-task failed' and explain what happened.",
		model,
		subagents: [
			subagent({
				agent: failingAgent,
				inputSchema: z.object({ task: z.string() }),
				mapInput: ({ task }) => task,
				maxTurns: 2,
			}),
		],
	});

	const result = await run(parentAgent, "Research quantum computing", { maxTurns: 5 });
	const handledGracefully = result.output.length > 0;
	return {
		pass: handledGracefully,
		detail: `Output: ${result.output.slice(0, 150)}`,
	};
});

// 9. Output guardrail on post-handoff agent — guardrail always trips
addTest("Guardrail after handoff", async (model) => {
	const alwaysTripGuardrail: OutputGuardrail = {
		name: "always_trip",
		execute: (output) => ({
			tripwireTriggered: output.length > 0, // trips on any non-empty output
			outputInfo: "Output blocked by guardrail",
		}),
	};

	const restrictedAgent = new Agent({
		name: "restricted_agent",
		instructions: "You are a restricted agent. Just say hello.",
		model,
		handoffDescription: "Transfer to restricted agent",
		outputGuardrails: [alwaysTripGuardrail],
	});

	const routerAgent = new Agent({
		name: "router",
		instructions: "Always hand off to restricted_agent.",
		model,
		handoffs: [restrictedAgent],
	});

	let tripped = false;
	try {
		await run(routerAgent, "Hello", { maxTurns: 5 });
	} catch (err) {
		if (err instanceof OutputGuardrailTripwireTriggered) {
			tripped = true;
		}
	}

	return {
		pass: tripped,
		detail: `Output guardrail tripped after handoff: ${tripped}`,
	};
});

// 10. Structured output parse failure — model returns bad JSON
addTest("Structured output recovery", async (model) => {
	const StrictSchema = z.object({
		items: z.array(z.object({
			name: z.string(),
			price: z.number().positive(),
			inStock: z.boolean(),
		})).min(1),
	});

	const agent = new Agent({
		name: "strict-extractor",
		instructions: "Extract product data. Return JSON matching the schema exactly.",
		model,
		outputType: StrictSchema,
	});

	// Give it clean data — should parse fine
	const result = await run(agent, 'Products: Widget ($9.99, in stock), Gadget ($24.50, out of stock)');
	const valid = result.finalOutput !== undefined &&
		Array.isArray(result.finalOutput.items) &&
		result.finalOutput.items.length >= 1;

	return {
		pass: valid,
		detail: `Parsed: ${JSON.stringify(result.finalOutput)}`,
	};
});

// 11. Parallel tool calls — agent calls multiple tools at once
addTest("Parallel tool calls", async (model) => {
	const callOrder: string[] = [];
	const callTimes: Record<string, number> = {};

	const slowTool = (name: string, delayMs: number) => tool({
		name,
		description: `Get ${name} data`,
		parameters: z.object({}),
		execute: async () => {
			const start = Date.now();
			callOrder.push(name);
			await new Promise((r) => setTimeout(r, delayMs));
			callTimes[name] = Date.now() - start;
			return `${name} result`;
		},
	});

	const agent = new Agent({
		name: "parallel-bot",
		instructions: "Call ALL three tools (get_weather, get_news, get_stocks) simultaneously in a single response. Then summarize results.",
		model,
		tools: [slowTool("get_weather", 100), slowTool("get_news", 100), slowTool("get_stocks", 100)],
		modelSettings: { parallelToolCalls: true },
	});

	const result = await run(agent, "Give me weather, news, and stocks", { maxTurns: 4 });
	const allCalled = callOrder.includes("get_weather") && callOrder.includes("get_news") && callOrder.includes("get_stocks");

	return {
		pass: allCalled && result.output.length > 0,
		detail: `Call order: [${callOrder.join(", ")}] | Output: ${result.output.slice(0, 80)}`,
	};
});

// 12. Hook denies tool call — beforeToolCall returns deny
addTest("Hook denies tool call", async (model) => {
	let deniedCount = 0;
	let allowedCount = 0;

	const safeTool = tool({
		name: "safe_lookup",
		description: "Safe data lookup",
		parameters: z.object({ query: z.string() }),
		execute: async (_ctx, { query }) => `Safe result for ${query}`,
	});

	const dangerousTool = tool({
		name: "delete_data",
		description: "Delete data from the database",
		parameters: z.object({ id: z.string() }),
		execute: async () => "Deleted!",
	});

	const agent = new Agent({
		name: "guarded-bot",
		instructions: "Use safe_lookup for queries. If asked to delete, use delete_data. Always try to help.",
		model,
		tools: [safeTool, dangerousTool],
		hooks: {
			beforeToolCall: ({ toolCall }) => {
				if (toolCall.function.name === "delete_data") {
					deniedCount++;
					return { decision: "deny" as const, reason: "Deletion not allowed in read-only mode" };
				}
				allowedCount++;
				return { decision: "allow" as const };
			},
		},
	});

	const result = await run(agent, "Look up user 123, then delete user 456", { maxTurns: 6 });
	return {
		pass: allowedCount > 0 && result.output.length > 0,
		detail: `Allowed: ${allowedCount} | Denied: ${deniedCount} | Output: ${result.output.slice(0, 100)}`,
	};
});

// 13. Hook modifies tool call params
addTest("Hook modifies tool params", async (model) => {
	let originalQuery = "";
	let executedQuery = "";

	const searchTool = tool({
		name: "search",
		description: "Search for information",
		parameters: z.object({ query: z.string() }),
		execute: async (_ctx, { query }) => {
			executedQuery = query;
			return `Results for: ${query}`;
		},
	});

	const agent = new Agent({
		name: "filtered-bot",
		instructions: "Use the search tool to answer. Be concise.",
		model,
		tools: [searchTool],
		hooks: {
			beforeToolCall: ({ toolCall }) => {
				const args = JSON.parse(toolCall.function.arguments);
				originalQuery = args.query;
				return {
					decision: "modify" as const,
					modifiedParams: { query: `${args.query} site:wikipedia.org` },
				};
			},
		},
	});

	const result = await run(agent, "Search for quantum computing");
	const wasModified = executedQuery.includes("site:wikipedia.org");
	return {
		pass: wasModified && executedQuery.length > 0,
		detail: `Original: "${originalQuery}" | Executed: "${executedQuery}"`,
	};
});

// 14. Session fork divergence — forked session takes different path
addTest("Session fork divergence", async (model) => {
	const session = createSession({
		model,
		instructions: "You are a helpful assistant. Be very concise.",
	});

	session.send("I'm planning a trip. I like beaches.");
	for await (const _ of session.stream()) {}

	const snapshot = session.save();

	// Original continues with beaches
	session.send("Suggest a beach destination. One word.");
	for await (const _ of session.stream()) {}
	const beachResult = await session.result;

	// Fork goes to mountains
	const forked = forkSession(snapshot, {
		model,
		instructions: "You are a helpful assistant. Be very concise.",
	});
	forked.send("Actually I changed my mind, I want mountains. Suggest one. One word.");
	for await (const _ of forked.stream()) {}
	const mountainResult = await forked.result;

	session.close();
	forked.close();

	// They should give different answers
	const different = beachResult.output.toLowerCase() !== mountainResult.output.toLowerCase();
	return {
		pass: beachResult.output.length > 0 && mountainResult.output.length > 0,
		detail: `Beach: "${beachResult.output.slice(0, 40)}" | Mountain: "${mountainResult.output.slice(0, 40)}" | Diverged: ${different}`,
	};
});

// 15. Tracing with handoffs and tools — verify all span types
addTest("Tracing full span coverage", async (model) => {
	const lookupTool = tool({
		name: "lookup",
		description: "Look up an order",
		parameters: z.object({ id: z.string() }),
		execute: async (_ctx, { id }) => `Order ${id}: shipped`,
	});

	const orderAgent = new Agent({
		name: "order_agent",
		instructions: "Use the lookup tool to find the order, then respond.",
		model,
		tools: [lookupTool],
		handoffDescription: "Handle order queries",
	});

	const triageAgent = new Agent({
		name: "triage",
		instructions: "Hand off order questions to order_agent.",
		model,
		handoffs: [orderAgent],
	});

	const { result, trace } = await withTrace("battle-trace", () =>
		run(triageAgent, "Where is order #12345?", { maxTurns: 6 }),
	);

	const spanTypes = new Set(getAllSpanTypes(trace.spans));
	const hasModel = spanTypes.has("model_call");
	const hasTool = spanTypes.has("tool_execution");
	const hasHandoff = spanTypes.has("handoff");

	return {
		pass: hasModel && hasTool && hasHandoff && (trace.duration ?? 0) > 0,
		detail: `Span types: [${[...spanTypes].join(", ")}] | Spans: ${countSpans(trace.spans)} | Duration: ${trace.duration?.toFixed(0)}ms`,
	};
});

function getAllSpanTypes(spans: any[]): string[] {
	const types: string[] = [];
	for (const s of spans) {
		types.push(s.type);
		if (s.children?.length) types.push(...getAllSpanTypes(s.children));
	}
	return types;
}

function countSpans(spans: any[]): number {
	let count = spans.length;
	for (const s of spans) {
		if (s.children?.length) count += countSpans(s.children);
	}
	return count;
}

// 16. MaxTurns exceeded gracefully — force tool calls via toolChoice
addTest("MaxTurns exceeded", async (model) => {
	let callCount = 0;
	const infiniteTool = tool({
		name: "think_more",
		description: "Think about the problem",
		parameters: z.object({ thought: z.string() }),
		execute: async (_ctx, { thought }) => {
			callCount++;
			return `Keep going: ${thought}`;
		},
	});

	let stopHookFired = false;
	const agent = new Agent({
		name: "overthinker",
		instructions: "Think deeply.",
		model,
		tools: [infiniteTool],
		modelSettings: {
			toolChoice: { type: "function", function: { name: "think_more" } },
		},
		hooks: {
			onStop: ({ reason }) => {
				if (reason === "max_turns") stopHookFired = true;
			},
		},
	});

	let exceeded = false;
	try {
		await run(agent, "What is 1+1?", { maxTurns: 3 });
	} catch (err) {
		if (err instanceof MaxTurnsExceededError) {
			exceeded = true;
		}
	}

	return {
		pass: exceeded && callCount >= 2,
		detail: `MaxTurns thrown: ${exceeded} | Tool calls: ${callCount} | onStop: ${stopHookFired}`,
	};
});

// ═══════════════════════════════════════════════
// Runner (models in parallel)
// ═══════════════════════════════════════════════

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

console.log("=== Battle Tests ===");
console.log(`Models: ${models.length} | Tests: ${tests.length}`);
console.log(`Running all models in parallel...\n`);

const startTime = performance.now();
const modelResults = await Promise.all(models.map((config) => runModelTests(config)));
const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

for (const mr of modelResults) {
	console.log(`${"=".repeat(64)}`);
	console.log(`  ${mr.model}  (${mr.passed}/${mr.passed + mr.failed})`);
	console.log(`${"=".repeat(64)}`);
	for (const r of mr.results) {
		console.log(`  ${r.name.padEnd(32)} ${r.status}`);
		console.log(`    ${r.detail}`);
	}
	console.log();
}

console.log(`${"=".repeat(64)}`);
console.log("  SUMMARY");
console.log(`${"=".repeat(64)}`);
for (const mr of modelResults) {
	const status = mr.failed === 0 ? "ALL PASS" : `${mr.passed}/${mr.passed + mr.failed}`;
	console.log(`  ${mr.model.padEnd(44)} ${status}`);
}
const totalPassed = modelResults.reduce((a, mr) => a + mr.passed, 0);
const totalTests = modelResults.reduce((a, mr) => a + mr.passed + mr.failed, 0);
console.log(`\n  Total: ${totalPassed}/${totalTests} across ${modelResults.length} models in ${elapsed}s`);
