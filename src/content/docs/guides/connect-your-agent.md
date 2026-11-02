---
title: Connect your agent
description: Add a deployed actuator to Claude Code, Claude Desktop, Cursor or your own agent as an MCP tool.
---

Every deployed actuator is an MCP tool. Its `name` is the tool name, its `description` is what the model reads, and its `InputSchema` is the argument schema. Arguments that don't fit the schema are rejected before any of your code runs.

## Pick an endpoint

| Endpoint | Tools |
| --- | --- |
| `https://run.actuate.run/a/<actuator-id>/mcp` | One actuator, plus `actuate_get_run` |
| `https://run.actuate.run/mcp` | Every active actuator on your account, plus `actuate_get_run` |

Both take an API token as `Authorization: Bearer <token>`. Create an **agent token** in the dashboard under Settings → API tokens: run-scoped, the default for new tokens. It can start and read runs, and nothing else: it cannot approve, deploy, change configuration or manage your account, so an agent holding it cannot sign off its own approval gates. Keep full tokens for the CLI. Treat any token like a password. The dashboard's **Connect** tab on each actuator shows these snippets with the real URL filled in.

## Claude Code

```bash
claude mcp add --transport http deposit_reminder https://run.actuate.run/a/<actuator-id>/mcp \
  --header "Authorization: Bearer <token>"
```

## Claude Desktop

Claude Desktop starts local (stdio) servers, so connect through `mcp-remote`. In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "deposit_reminder": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://run.actuate.run/a/<actuator-id>/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

## Cursor, VS Code and other clients

Clients that speak Streamable HTTP take a URL and headers:

```json
{
  "mcpServers": {
    "deposit_reminder": {
      "type": "http",
      "url": "https://run.actuate.run/a/<actuator-id>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Older clients that only support the HTTP+SSE transport can use `/a/<actuator-id>/sse` (or `/sse` for every actuator). Those sessions close after 15 minutes and the client reconnects.

## Your own agent

With the official TypeScript SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://run.actuate.run/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.ACTUATE_TOKEN}` } },
  }),
);

const { tools } = await client.listTools(); // hand these to your model
const result = await client.callTool({ name: "refund_order", arguments: { orderId: "2291", billId: "pi_123", amount: 120 } });
```

## What a tool call returns

- **The run finished:** the result is the run's output, as text and, when the actuator declares an `output` schema, as `structuredContent`.
- **The run is waiting** (sleeping, waiting for a webhook, or waiting for a person to approve): the result is a receipt with the `runId`. Your agent can tell the user it's in progress and check later with `actuate_get_run`:

  ```json
  { "name": "actuate_get_run", "arguments": { "runId": "run_01a19b8e...", "actuator": "refund_order" } }
  ```

  `actuator` is needed only on the account-wide `/mcp` endpoint.
- **The run failed, or the arguments were invalid:** the result has `isError: true` and a message the model can read and correct.

## Retries never act twice

Within one MCP session, a retried call (same JSON-RPC `id`) returns the first call's receipt instead of starting another run. To deduplicate across sessions, for example when your agent retries after a crash, pass your own key in `_meta`:

```json
{
  "name": "refund_order",
  "arguments": { "orderId": "2291", "billId": "pi_123", "amount": 120 },
  "_meta": { "actuate/idempotencyKey": "refund-2291" }
}
```

The same key always returns the same run. See [MCP and OpenAPI](/docs/concepts/mcp-and-openapi/) for the full behaviour, and [Deterministic agent tools](/docs/guides/agent-tools/) for how to design a tool the model can't misuse.
