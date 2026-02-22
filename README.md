<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo.svg">
    <img src=".github/logo.svg" alt="Stratus" width="80" height="80">
  </picture>
</p>

# Stratus

[usestratus.dev](https://usestratus.dev)

[![npm version](https://img.shields.io/npm/v/stratus-sdk)](https://www.npmjs.com/package/stratus-sdk)
[![CI](https://github.com/tylergibbs1/stratus/actions/workflows/ci.yml/badge.svg)](https://github.com/tylergibbs1/stratus/actions/workflows/ci.yml)

A better TypeScript agent SDK for Azure OpenAI. Build multi-agent systems with tools, handoffs, guardrails, streaming, structured output, and more.

- **One framework, two swappable backends** — Chat Completions and Responses API through the same interface. Switch with one line.
- **No more 404 config spiral** — auto-endpoint detection for standard, foundry, and full URLs. Built-in retry with exponential backoff and unified content filter errors.
- **One call, entire tool loop** — model calls, parallel tool execution, result appending, and looping back. No manual message array management.
- **Client-side agent state** — no server-side threads or opaque IDs. Save, resume, and fork conversations with portable snapshots.
- **Budget enforcement built in** — set a dollar limit and the run stops before you get a surprise bill. Cost estimation accounts for cached and reasoning tokens.
- **Auth validated at construction** — API key or Entra ID, enforced mutually exclusive. No silent misconfiguration that surfaces as a mysterious 401 three calls later.

`agents` `tools` `streaming` `structured output` `handoffs` `subagents` `guardrails` `hooks` `tracing` `sessions` `abort signals` `todo tracking` `cost tracking`

## Install

```bash
bun add stratus-sdk
```

Stratus requires [Zod](https://zod.dev) as a peer dependency:

```bash
bun add zod
```

## Quick Start

```ts
import { z } from "zod";
import { Agent, AzureResponsesModel, run, tool } from "stratus-sdk";

const model = new AzureResponsesModel({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  deployment: "gpt-5.2",
});

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({
    city: z.string().describe("The city name"),
  }),
  execute: async (_ctx, { city }) => {
    return `72°F and sunny in ${city}`;
  },
});

const agent = new Agent({
  name: "weather-assistant",
  instructions: "You are a helpful weather assistant.",
  model,
  tools: [getWeather],
});

const result = await run(agent, "What's the weather in New York?");
console.log(result.output);
```

## Core Concepts

### Agents

Agents are the primary building block. Each agent has a name, instructions, a model, and optional tools, handoffs, guardrails, and hooks.

```ts
const agent = new Agent({
  name: "my-agent",
  instructions: "You are a helpful assistant.",
  model,
  tools: [myTool],
});

// Dynamic instructions based on context
const agent = new Agent({
  name: "my-agent",
  instructions: (ctx) => `You are helping ${ctx.userName}.`,
  model,
});
```

### Tools

Define tools with Zod schemas for type-safe parameter validation:

```ts
const searchTool = tool({
  name: "search",
  description: "Search for information",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results"),
  }),
  execute: async (context, { query, limit }) => {
    // Tool logic here
    return "search results";
  },
});
```

### Streaming

Stream responses token-by-token:

```ts
const { stream: s, result } = stream(agent, "Tell me a story");

for await (const event of s) {
  if (event.type === "content_delta") {
    process.stdout.write(event.content);
  } else if (event.type === "tool_call_start") {
    console.log(`Calling: ${event.toolCall.name}`);
  }
}

const finalResult = await result;
```

### Structured Output

Use Zod schemas to get typed, validated output:

```ts
const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
  occupation: z.string(),
});

const agent = new Agent({
  name: "extractor",
  instructions: "Extract person information.",
  model,
  outputType: PersonSchema,
});

const result = await run(agent, "Marie Curie was a 66-year-old physicist.");
console.log(result.finalOutput); // { name: "Marie Curie", age: 66, occupation: "physicist" }
```

### Sessions

Sessions maintain conversation history across multiple interactions:

```ts
import { createSession } from "stratus-sdk";

const session = createSession({ model, tools: [myTool] });

session.send("Hello!");
for await (const event of session.stream()) {
  // handle events
}

session.send("Follow-up question");
for await (const event of session.stream()) {
  // handle events
}

// Save and resume sessions
const snapshot = session.save();
const resumed = resumeSession(snapshot, { model });

// Fork a session (new ID, same history)
const forked = forkSession(snapshot, { model });

// Cleanup
session.close();
// Or use Symbol.asyncDispose:
await using session = createSession({ model });
```

### Handoffs

Transfer control between specialized agents:

```ts
import { handoff } from "stratus-sdk";

const orderAgent = new Agent({
  name: "order_specialist",
  instructions: "Help with order inquiries.",
  model,
  tools: [lookupOrder],
  handoffDescription: "Transfer for order questions",
});

const triageAgent = new Agent({
  name: "triage",
  instructions: "Route to the right specialist.",
  model,
  handoffs: [
    orderAgent, // shorthand
    handoff({    // with options
      agent: refundAgent,
      onHandoff: () => console.log("Transferring..."),
    }),
  ],
});

const result = await run(triageAgent, "Where is my order?");
console.log(result.lastAgent.name); // "order_specialist"
```

### Subagents

Delegate subtasks to child agents that run independently:

```ts
import { subagent } from "stratus-sdk";

const researcher = new Agent({
  name: "researcher",
  instructions: "Research topics thoroughly.",
  model,
});

const parentAgent = new Agent({
  name: "parent",
  instructions: "Use the researcher for deep dives.",
  model,
  subagents: [
    subagent({
      agent: researcher,
      inputSchema: z.object({ topic: z.string() }),
      mapInput: ({ topic }) => `Research: ${topic}`,
    }),
  ],
});
```

### Guardrails

Validate inputs and outputs with guardrails:

```ts
import type { InputGuardrail, OutputGuardrail } from "stratus-sdk";

const profanityFilter: InputGuardrail = {
  name: "profanity_filter",
  execute: (input) => ({
    tripwireTriggered: containsProfanity(input),
    outputInfo: "Blocked by profanity filter",
  }),
};

const piiFilter: OutputGuardrail = {
  name: "pii_filter",
  execute: (output) => ({
    tripwireTriggered: /\d{3}-\d{2}-\d{4}/.test(output),
    outputInfo: "Output contained PII",
  }),
};

const agent = new Agent({
  name: "guarded",
  model,
  inputGuardrails: [profanityFilter],
  outputGuardrails: [piiFilter],
});
```

Guardrails run in parallel. When a tripwire is triggered, an `InputGuardrailTripwireTriggered` or `OutputGuardrailTripwireTriggered` error is thrown.

### Hooks

Lifecycle hooks for observability and control:

```ts
import type { AgentHooks } from "stratus-sdk";

const hooks: AgentHooks = {
  beforeRun: ({ agent, input }) => { /* ... */ },
  afterRun: ({ agent, result }) => { /* ... */ },

  // Return a decision to allow, deny, or modify tool calls
  beforeToolCall: ({ toolCall }) => {
    if (toolCall.function.name === "dangerous_tool") {
      return { decision: "deny", reason: "Not allowed" };
    }
    return { decision: "allow" };
  },
  afterToolCall: ({ toolCall, result }) => { /* ... */ },

  // Allow or deny handoffs
  beforeHandoff: ({ fromAgent, toAgent }) => {
    return { decision: "allow" };
  },
};
```

### Tracing

Opt-in tracing with zero overhead when inactive:

```ts
import { withTrace } from "stratus-sdk";

const { result, trace } = await withTrace("my-workflow", () =>
  run(agent, "Hello"),
);

console.log(trace.id);
console.log(trace.duration);
for (const span of trace.spans) {
  console.log(`[${span.type}] ${span.name} (${span.duration}ms)`);
  // span.type: "model_call" | "tool_execution" | "handoff" | "guardrail" | "subagent" | "custom"
}
```

### Abort Signals

Cancel runs with `AbortSignal`:

```ts
const controller = new AbortController();

setTimeout(() => controller.abort(), 5000);

try {
  const result = await run(agent, "Long task...", {
    signal: controller.signal,
  });
} catch (error) {
  if (error instanceof RunAbortedError) {
    console.log("Run was cancelled");
  }
}
```

### Todo Tracking

Track task progress during agent execution:

```ts
import { todoTool, TodoList } from "stratus-sdk";

const todos = new TodoList();
todos.onUpdate((items) => {
  for (const item of items) {
    const icon = item.status === "completed" ? "+" : item.status === "in_progress" ? ">" : "-";
    console.log(`${icon} ${item.content}`);
  }
});

const agent = new Agent({
  name: "planner",
  instructions: "Break tasks into steps and track progress with todo_write.",
  model,
  tools: [todoTool(todos)],
});

await run(agent, "Set up a new TypeScript project");
```

### Usage & Cost Tracking

Track token usage and estimate costs:

```ts
import { createCostEstimator } from "stratus-sdk";

const estimator = createCostEstimator({
  inputTokenCostPer1k: 0.01,
  outputTokenCostPer1k: 0.03,
});

const result = await run(agent, "Hello", { costEstimator: estimator });
console.log(result.usage.totalTokens); // token counts
console.log(result.totalCostUsd);      // estimated cost
console.log(result.numTurns);          // model call count

// Set budget limits
const result = await run(agent, "Hello", {
  costEstimator: estimator,
  maxBudgetUsd: 0.50, // throws MaxBudgetExceededError if exceeded
});
```

### Tool Choice & Tool Use Behavior

Control how the model uses tools:

```ts
const agent = new Agent({
  name: "my-agent",
  model,
  tools: [myTool],
  modelSettings: {
    // "auto" | "none" | "required" | { type: "function", function: { name: "..." } }
    toolChoice: "required",
  },
  // "run_llm_again" (default) | "stop_on_first_tool" | { stopAtToolNames: ["..."] }
  toolUseBehavior: "stop_on_first_tool",
});
```

## Imports

Stratus provides three export paths:

```ts
// Everything (core + Azure)
import { Agent, run, tool, AzureChatCompletionsModel, AzureResponsesModel } from "stratus-sdk";

// Core only (provider-agnostic)
import { Agent, run, tool } from "stratus-sdk/core";

// Azure provider only
import { AzureChatCompletionsModel, AzureResponsesModel } from "stratus-sdk/azure";
```

## Configuration

### Azure OpenAI

Stratus includes two interchangeable Azure model implementations:

```ts
// Chat Completions API
const model = new AzureChatCompletionsModel({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  deployment: "gpt-5.2",
  apiVersion: "2025-03-01-preview", // optional, this is the default
});

// Responses API
const model = new AzureResponsesModel({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  deployment: "gpt-5.2",
  apiVersion: "2025-04-01-preview", // optional, this is the default
});
```

Both implement the same `Model` interface — swap one for the other without changing any agent, tool, or session code.

### Environment Variables

```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
```

## Error Handling

All errors extend `StratusError`:

| Error | Description |
|---|---|
| `StratusError` | Base error class |
| `ModelError` | API call failures (includes `status` and `code`) |
| `ContentFilterError` | Content filtered by Azure's content management policy |
| `MaxTurnsExceededError` | Agent exceeded the `maxTurns` limit |
| `OutputParseError` | Structured output failed Zod validation |
| `RunAbortedError` | Run cancelled via `AbortSignal` |
| `InputGuardrailTripwireTriggered` | Input guardrail blocked the request |
| `OutputGuardrailTripwireTriggered` | Output guardrail blocked the response |

```ts
import { ModelError, MaxTurnsExceededError, RunAbortedError } from "stratus-sdk";

try {
  await run(agent, input);
} catch (error) {
  if (error instanceof MaxTurnsExceededError) {
    // Agent ran too many turns
  } else if (error instanceof ModelError) {
    console.log(error.status, error.code);
  }
}
```

## Development

```bash
bun test          # Run tests
bun run lint      # Lint with Biome
bun run typecheck # TypeScript type checking
```
