# @stratus/mcp-aws

Build, deploy, and manage MCP servers on AWS in TypeScript. Progressive disclosure, tool gating, code mode, and one-line Lambda deploys.

```ts
import { McpServer, apiKey, role, deploy } from "@stratus/mcp-aws";
import { z } from "zod";

const server = new McpServer("my-tools@1.0.0")
  .auth(apiKey({ "sk-live-xxx": { roles: ["admin"] } }))
  .tool("greet", z.object({ name: z.string() }), async ({ name }) => {
    return `Hello, ${name}!`;
  });

export const handler = server.lambda();

// Or deploy directly from code:
// const { url } = await server.deploy({ entry: "./src/server.ts" });
```

## Install

```bash
bun add @stratus/mcp-aws zod
```

## Quick Start

### 5 lines to a working MCP server

```ts
import { McpServer } from "@stratus/mcp-aws";
import { z } from "zod";

const server = new McpServer("my-server@1.0.0");
server.tool("greet", z.object({ name: z.string() }), async ({ name }) => `Hello, ${name}!`);
export const handler = server.lambda();
```

### Local development with Claude Desktop

```ts
await server.stdio();
```

### Deploy to AWS Lambda

```ts
const { url } = await server.deploy({ entry: "./src/server.ts" });
// → https://xxx.lambda-url.us-east-1.on.aws/
```

---

## API Reference

### McpServer

```ts
// String constructor
const server = new McpServer("my-server@1.0.0");

// Config object (for advanced options)
const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
  codeMode: { enabled: true, executor: "worker" },
});
```

### Tool Registration

Three overloads — pick the one that fits:

```ts
// Simple: name + handler (no params)
server.tool("ping", async () => "pong");

// With params: name + Zod schema + handler
server.tool("greet", z.object({ name: z.string() }), async ({ name }) => {
  return `Hello, ${name}!`;
});

// Full config: name + options + handler
server.tool("admin_action", {
  description: "Reset a user account",
  params: z.object({ userId: z.string() }),
  tier: "hidden",
  gate: role("admin"),
  timeout: 5000,
  tags: ["admin"],
}, async ({ userId }) => {
  return { reset: true, userId };
});
```

**Return values are auto-coerced:**
- `string` → text content
- `object` / `array` → JSON-serialized text content
- `undefined` → empty content
- `ToolResult` → pass-through (for full control)

### Method Chaining

Everything returns `this`:

```ts
const server = new McpServer("my-server@1.0.0")
  .auth(apiKey({ "sk-123": { roles: ["admin"] } }))
  .tool("ping", async () => "pong")
  .tool("greet", z.object({ name: z.string() }), async ({ name }) => `Hello, ${name}!`)
  .on("tool:call", (e) => console.log(e.toolName));
```

---

## Auth

Configure once on the server. All transports inherit it.

### API Key

```ts
import { apiKey } from "@stratus/mcp-aws";

server.auth(apiKey({
  "sk-live-abc123": { subject: "user-1", roles: ["admin"] },
  "sk-live-xyz789": { subject: "user-2", roles: ["reader"] },
}));
```

### Cognito JWT

```ts
import { cognito } from "@stratus/mcp-aws";

server.auth(cognito({
  userPoolId: "us-east-1_abc123",
  region: "us-east-1",
  audience: "my-client-id", // optional
}));
```

### Chain Multiple Providers

```ts
server.auth(
  apiKey({ "sk-123": { roles: ["admin"] } }),
  cognito({ userPoolId: "...", region: "us-east-1" }),
);
// Tries each in order, returns first success
```

### AsyncLocalStorage Context

Tool handlers can access auth without explicit parameters:

```ts
import { getAuthContext, getSession } from "@stratus/mcp-aws";

server.tool("my_tool", async () => {
  const auth = getAuthContext(); // works anywhere in the call stack
  const session = getSession();
  return `Hello, ${auth.subject}!`;
});
```

---

## Progressive Disclosure

59 tools? No problem. Only show what matters.

### Tier System

| Tier | Behavior | Default? |
|------|----------|----------|
| `always` | Always in `tools/list`. The server's front door. | Yes |
| `discoverable` | Found via `search_tools`. Promoted on discovery. | |
| `hidden` | Invisible until a gate unlocks it. | |

```ts
server
  .tool("get_weather", async () => "sunny")                                    // always (default)
  .tool("get_forecast", { tier: "discoverable", tags: ["weather"] }, handler)  // searchable
  .tool("delete_account", { tier: "hidden", gate: requires("confirm") }, handler) // gated
```

### How It Works

1. Client calls `tools/list` → gets only `always` tier tools + `search_tools`
2. Agent calls `search_tools("weather forecast")` → BM25 search finds matches
3. Matches promoted to session → server sends `tools/list_changed`
4. Client re-fetches → now sees promoted tools
5. Visibility is per-session, persisted in session store

### Disclosure Modes

Auto-inferred from your tool tiers. Override with config:

| Mode | When | `tools/list` shows |
|------|------|--------------------|
| `all` | All tools are `always` | Everything |
| `progressive` | Any `discoverable`/`hidden` | `always` + `search_tools` |
| `code-first` | Explicit config | `search_tools` + `execute_workflow` only |

---

## Tool Gating

Access control at the tool level.

### Role-Based

```ts
import { role } from "@stratus/mcp-aws";

server.tool("admin_action", { gate: role("admin") }, handler);
server.tool("write_action", { gate: role("admin", "editor") }, handler); // any of these roles
```

### Prerequisite (Workflow Enforcement)

```ts
import { requires } from "@stratus/mcp-aws";

server
  .tool("review_trade", handler)
  .tool("execute_trade", { tier: "hidden", gate: requires("review_trade") }, handler);
// execute_trade is invisible until review_trade is called
// Then it auto-promotes and tools/list_changed fires
```

### Dynamic Check

```ts
import { check } from "@stratus/mcp-aws";

server.tool("update_deal", {
  gate: check((ctx) => ctx.auth.claims.org === "acme", "Wrong org"),
}, handler);
```

### Rate Limiting

```ts
import { rateLimit } from "@stratus/mcp-aws";

server.tool("expensive_op", {
  gate: rateLimit({ max: 10, windowMs: 60_000 }),
}, handler);
```

### Composite Gates

```ts
import { all, any, role, requires, rateLimit } from "@stratus/mcp-aws";

server.tool("approve_discount", {
  gate: all(
    role("sales-manager"),
    requires("review_discount"),
    rateLimit({ max: 10, windowMs: 3_600_000 }),
  ),
}, handler);
```

### Gate Denial

When a gate blocks, the agent gets a structured error it can self-correct from:

```json
{
  "error": "Permission denied",
  "reason": "Requires \"review_trade\" to be called first",
  "hint": "Call the \"review_trade\" tool before using \"execute_trade\"."
}
```

---

## Code Mode

Reduce N tool calls to 1. The agent writes code that orchestrates tools.

```ts
const server = new McpServer({
  name: "tools",
  version: "1.0.0",
  codeMode: { enabled: true, executor: "worker" },
});
```

This registers an `execute_workflow` tool. The agent:
1. Calls `search_tools` to discover available tools + type signatures
2. Writes an async arrow function using `codemode.toolName(args)`
3. Calls `execute_workflow` with the code
4. Server validates gates, executes in isolated V8, returns result

### Wrap Any Existing MCP Server

```ts
import { codeMcpServer } from "@stratus/mcp-aws";

const codeServer = await codeMcpServer({ server: existingMcpServer });
// → codeServer has one tool: execute_code
```

---

## Transports

### Lambda (Serverless)

```ts
export const handler = server.lambda();

// With session store
import { DynamoSessionStore } from "@stratus/mcp-aws/dynamo";

export const handler = server.lambda({
  sessionStore: new DynamoSessionStore({ tableName: "mcp-sessions" }),
});
```

### Express (Container/ECS/EC2)

```ts
import express from "express";

const app = express();
app.use(express.json());
server.express({ mcpPath: "/mcp" }).setup(app);
app.listen(3000);
```

### Bun.serve (Zero Dependencies)

```ts
const { url, stop } = server.bun({ port: 3000 });
// MCP server at http://localhost:3000/mcp
```

Native `Bun.serve()` — no Express, no dependencies. Handles auth, routes, and cleanup.

### Stdio (Claude Desktop)

```ts
await server.stdio();
```

### Stateless Handler (Bun/Deno/Any Runtime)

```ts
import { createMcpHandler } from "@stratus/mcp-aws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const handler = createMcpHandler({ server: myMcpServer });
Bun.serve({ fetch: handler });
```

---

## Deploy

### One-Line Deploy

```ts
const { url } = await server.deploy({ entry: "./src/server.ts" });
console.log(url); // https://xxx.lambda-url.us-east-1.on.aws/
```

### Deploy with Options

```ts
const { url, functionName, functionArn } = await server.deploy({
  entry: "./src/server.ts",
  region: "us-east-1",
  functionName: "my-mcp-server",
  memory: 512,
  timeout: 30,
  environment: { DATABASE_URL: "postgres://..." },
});
```

### Destroy

```ts
await server.destroy();
// or
await server.destroy("custom-function-name", "us-east-1");
```

### Security Modes

| Mode | `urlAuth` | `vpc` | Who can call |
|------|-----------|-------|-------------|
| Public (default) | `"NONE"` | — | Anyone + MCP-level auth |
| IAM-signed | `"AWS_IAM"` | — | AWS services with SigV4 |
| VPC-only | `"none"` | set | Resources in the VPC |
| VPC + IAM | `"AWS_IAM"` | set | VPC with SigV4 |

```ts
// Private deployment inside a VPC
await server.deploy({
  entry: "./src/server.ts",
  urlAuth: "none",  // no public URL
  vpc: {
    subnetIds: ["subnet-abc123", "subnet-def456"],
    securityGroupIds: ["sg-xyz789"],
  },
});
```

---

## SSRF Protection

Prevent tools from accessing internal infrastructure:

```ts
import { isBlockedUrl, assertSafeUrl } from "@stratus/mcp-aws";

server.tool("fetch", z.object({ url: z.string() }), async ({ url }) => {
  assertSafeUrl(url); // throws if private IP, metadata endpoint, etc.
  return (await fetch(url)).text();
});

// Or check manually
if (isBlockedUrl(url)) return "Blocked";
```

Blocks: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254` (AWS metadata), `::1`, link-local, non-HTTP schemes.

---

## Observability

Typed event system for monitoring:

```ts
server
  .on("tool:call", (e) => {
    console.log(`${e.toolName} called by ${e.auth.subject}`);
  })
  .on("tool:result", (e) => {
    metrics.histogram("tool.duration", e.durationMs);
    if (e.isError) metrics.increment("tool.errors");
  })
  .on("gate:denied", (e) => {
    audit.log(`${e.toolName} denied: ${e.reason}`);
  })
  .on("tools:unlocked", (e) => {
    console.log(`${e.toolNames.join(", ")} unlocked via ${e.prerequisite}`);
  });
```

Events: `tool:call`, `tool:result`, `gate:denied`, `auth:success`, `auth:failure`, `tools:promoted`, `tools:unlocked`, `deploy:start`, `deploy:complete`.

---

## Session Stores

### Memory (dev/test)

```ts
import { MemorySessionStore } from "@stratus/mcp-aws";

server.lambda({ sessionStore: new MemorySessionStore({ ttlMs: 3600_000 }) });
```

### DynamoDB (production)

```ts
import { DynamoSessionStore } from "@stratus/mcp-aws/dynamo";

server.lambda({
  sessionStore: new DynamoSessionStore({
    tableName: "mcp-sessions",
    region: "us-east-1",
    ttlSeconds: 86400,
  }),
});
```

### SQLite (ECS/Fargate/EC2)

```ts
import { SqliteSessionStore } from "@stratus/mcp-aws";

server.lambda({
  sessionStore: new SqliteSessionStore({
    path: "/tmp/mcp-sessions.db",
    ttlMs: 3_600_000,
  }),
});
```

Uses Bun's native `bun:sqlite`. Zero dependencies. Supports file persistence across restarts.

### Custom

Implement the `SessionStore` interface:

```ts
import type { SessionStore, McpSession } from "@stratus/mcp-aws";

class RedisSessionStore implements SessionStore {
  async get(sessionId: string): Promise<McpSession | undefined> { /* ... */ }
  async set(session: McpSession): Promise<void> { /* ... */ }
  async delete(sessionId: string): Promise<void> { /* ... */ }
}
```

---

## RFC 9728 OAuth Metadata

Automatically serve `.well-known/oauth-protected-resource` for MCP clients that support OAuth discovery:

```ts
server.lambda({
  baseUrl: "https://api.example.com",
  resourceMetadata: {
    baseUrl: "https://api.example.com",
    authorizationServers: ["https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xxx"],
    scopes: ["openid", "email"],
  },
});
```

401 responses include `WWW-Authenticate: Bearer realm="mcp-server", resource_metadata="..."` per the spec.

---

## Error Classes

| Error | Description |
|---|---|
| `McpAwsError` | Base error |
| `GateDeniedError` | Tool gate blocked (has `toolName`, `reason`, `hint`) |
| `AuthenticationError` | Auth failed |
| `SessionNotFoundError` | Session expired/missing (has `sessionId`) |
| `ToolExecutionError` | Tool handler threw (has `toolName`, `cause`) |
| `ToolTimeoutError` | Tool exceeded timeout (has `toolName`, `timeoutMs`) |

---

## Full Example: Playwright MCP on Lambda

```ts
import { McpServer, apiKey, role } from "@stratus/mcp-aws";
import { z } from "zod";

const server = new McpServer("playwright@1.0.0")
  .auth(apiKey({ "demo-key": { roles: ["user"] } }))

  // Always visible (3 core tools)
  .tool("browser_navigate", z.object({ url: z.string() }), async ({ url }) => {
    return { navigated: true, url };
  })
  .tool("browser_snapshot", async () => {
    return { title: "Page", elements: ["heading", "link", "form"] };
  })
  .tool("browser_close", async () => "closed")

  // Discoverable via search (interaction tools)
  .tool("browser_click", {
    tier: "discoverable",
    tags: ["interaction"],
    params: z.object({ element: z.string() }),
  }, async ({ element }) => `Clicked ${element}`)

  .tool("browser_fill", {
    tier: "discoverable",
    tags: ["form", "input"],
    params: z.object({ element: z.string(), value: z.string() }),
  }, async ({ element, value }) => `Filled "${element}" with "${value}"`)

  // Hidden until auth (debug tools)
  .tool("browser_console", {
    tier: "hidden",
    gate: role("user"),
    tags: ["debug"],
  }, async () => [{ level: "log", text: "loaded" }])

  // Observability
  .on("tool:call", (e) => console.log(`[${e.toolName}] called`));

export const handler = server.lambda();
```

19 tools → only 3 + `search_tools` visible initially. The agent discovers the rest via search. Debug tools require authentication. All deployed with `server.lambda()`.

---

## Development

```bash
bun install                          # Install dependencies
bun test                             # Run 248 tests (<1s)
bun run typecheck                    # TypeScript checking
bun run lint                         # Biome linting
```

Tests are organized by type:
- **Unit** (125 tests) — types, gates, search, auth, session, codemode, context, ssrf, events
- **Local integration** (80 tests) — Lambda handler, MCP protocol, disclosure, PRD stories
- **Edge cases** (43 tests) — every branch covered
- **AWS integration** (optional) — real Lambda deploy + Function URL + Stratus agent E2E
