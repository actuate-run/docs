---
title: Connect your agent
description: Add a deployed actuator to Claude, ChatGPT, Cursor, Claude Code or your own agent as an MCP tool, by signing in or with an agent token.
---

Every deployed actuator is an MCP tool. Its `name` is the tool name, its `description` is what the model reads, and its `InputSchema` is the argument schema. Arguments that don't fit the schema are rejected before any of your code runs.

There are two ways to connect a client:

- **Sign in.** Paste the MCP URL into a client that supports MCP sign-in (Claude, ChatGPT, Cursor, Claude Code and others) and approve it in your browser. No token to copy.
- **An agent token.** Create a token in the dashboard and send it as `Authorization: Bearer <token>`. Use this for clients that can't sign in, scripts and your own agents.

Both give the client the same access: it can start runs and read their results, and nothing else. The dashboard's **Connect** tab on each actuator shows the URL and these snippets with real values filled in.

## Pick an endpoint

| Endpoint | Tools |
| --- | --- |
| `https://run.actuate.run/a/<actuator-id>/mcp` | One actuator, plus `actuate_get_run` |
| `https://run.actuate.run/mcp` | Every active actuator on your account, plus `actuate_get_run` |

Paused actuators are left out of the account-wide list. A new or redeployed actuator shows up within about 30 seconds; see [tool list changes](/docs/concepts/mcp-and-openapi/#tool-list-changes).

## Sign in from your MCP client

Add the URL as a remote MCP server, with no token or header. When the client first connects, Actuate answers `401` with a pointer to its sign-in server, the client opens your browser, and you approve the connection on a page at `app.actuate.run` (sign in to the dashboard first if you aren't already).

### Claude

In Claude (on the web or in the desktop app), add a custom connector with the URL `https://run.actuate.run/mcp`, or one actuator's URL, and connect. Claude opens the Actuate sign-in page.

### ChatGPT

Add the URL as a custom connector (a remote MCP server), where your ChatGPT plan or workspace allows custom connectors, and choose OAuth when it asks how to authenticate.

### Cursor

In `.cursor/mcp.json` (or the global `~/.cursor/mcp.json`), add the URL with no headers:

```json
{
  "mcpServers": {
    "actuate": { "url": "https://run.actuate.run/mcp" }
  }
}
```

Cursor shows that the server needs a login. Start it from the MCP settings to open the sign-in page.

### Claude Code

```bash
claude mcp add --transport http actuate https://run.actuate.run/mcp
```

Then run `/mcp` in Claude Code, pick `actuate` and choose **Authenticate**.

### The consent page

The page shows:

- **App:** the name the client gave. For clients that publish a [client metadata document](/docs/reference/platform-api/#clients), it adds the website the name came from. A client that registered itself is marked **unverified**, because Actuate can't confirm its name.
- **Sends you back to:** where your browser goes after you decide: the client's website, a program on your computer (a `localhost` address) or an installed app's own link (for example `cursor://`). The page warns you about the last two.
- **Gets access to:** every actuator in your account as tools, or the one tool, depending on the URL you pasted.

Click **Allow** only if you just started connecting that app. **Deny** sends the client an `access_denied` error. A sign-in request expires after 10 minutes and works once; if it has expired, start again from the client.

A per-actuator URL can only be approved by the account that owns the actuator.

### What a connection can do

A connection is an agent token that the client manages for you:

- It can call the tools on the endpoint you approved, and `actuate_get_run`. It cannot approve or reject steps, answer questions, post events, deploy, change configuration, or read your tables, tokens or settings.
- It works only on the MCP endpoint it was approved for. A connection to `https://run.actuate.run/mcp` also works on each of your per-actuator `/a/<id>/mcp` URLs; a connection to one actuator's URL works only there. It is not accepted on `/a/<id>/run`, the OpenAPI document, the legacy SSE endpoints or the API at `api.actuate.run`.
- Runs it starts record it as the [agent](/docs/concepts/agents/) that started them, and it has its own row in **Settings → Agents**, where you can cap how often it may run tools.

### Lifetime and revoking

- The client gets an access token that lasts **1 hour** and a refresh token that lasts **30 days**. The client refreshes on its own; every refresh issues a new refresh token, valid for another 30 days. A connection the client doesn't use for 30 days has to sign in again.
- Every refresh issues a new refresh token. The previous one keeps working until the new one is used, so a client that lost a refresh response, or two windows of the same app, end up with the same tokens. A client holding an older one is asked to sign in again; the connection itself stays.
- Connections are listed under **Settings → API tokens**, tagged **connected app** and named after the app. The row keeps the same ID for the life of the connection, so its limits and analytics carry over between refreshes. Signing in again from scratch creates a new connection with a new ID.
- **Revoke** it there to disconnect the app. The gateway stops accepting it within 30 seconds. A client can also end its own connection through the [revocation endpoint](/docs/reference/platform-api/#oauth-endpoints).

Sign-in is part of the hosted platform. The [open-source runtime](/docs/guides/self-hosting/) has no MCP endpoint.

## Use an agent token

Create an **agent token** in the dashboard under Settings → API tokens: run-scoped, the default for new tokens. It can start and read runs, and nothing else: it cannot approve, post events, deploy, change configuration or manage your account, so an agent holding it cannot sign off its own approval gates or fake an event a run is waiting for, such as a payment. Keep full tokens for the CLI. Treat any token like a password.

Agent tokens work on every gateway route that starts or reads runs: both MCP endpoints, the legacy SSE endpoints, `POST /a/<id>/run`, `GET /a/<id>/runs/<runId>` and the OpenAPI document.

### Claude Code

```bash
claude mcp add --transport http deposit_reminder https://run.actuate.run/a/<actuator-id>/mcp \
  --header "Authorization: Bearer <token>"
```

### Claude Desktop

To use a token instead of signing in, Claude Desktop can start a local (stdio) server that forwards to Actuate through `mcp-remote`. In `claude_desktop_config.json`:

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

### Cursor, VS Code and other clients

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

Older clients that only support the HTTP+SSE transport can use `/a/<actuator-id>/sse` (or `/sse` for every actuator), with a token. Those sessions close after 15 minutes and the client reconnects.

### Your own agent

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

If you are building an MCP client that signs users in, see the [OAuth endpoints](/docs/reference/platform-api/#oauth-endpoints) and what Actuate requires of clients.

## What a tool call returns

- **The run finished:** the result is the run's output, as text and, when the actuator declares an `output` schema and the output is an object, as `structuredContent`.
- **The run is waiting** (sleeping, waiting for a webhook, or waiting for a person to approve): the result is a receipt with the `runId`. Your agent can tell the user it's in progress and check later with `actuate_get_run`:

  ```json
  { "name": "actuate_get_run", "arguments": { "runId": "run_01a19b8e...", "actuator": "refund_order" } }
  ```

  `actuator` is needed only when the endpoint has more than one actuator, as the account-wide `/mcp` usually does.
- **The run failed, or the arguments were invalid:** the result has `isError: true` and a message the model can read and correct. A call refused by your plan's limits or the agent's own [limits](/docs/concepts/agents/#limits) is a tool error too, with the reason.

## Retries never act twice

To make a retried call safe, for example when your agent retries after a timeout or a crash, pass your own key in `_meta`:

```json
{
  "name": "refund_order",
  "arguments": { "orderId": "2291", "billId": "pi_123", "amount": 120 },
  "_meta": { "run.actuate/idempotencyKey": "refund-2291" }
}
```

The same key on the same tool always returns the same run, instead of starting another. Use a key that names the thing you are doing, such as the order, not a random value per attempt. `actuate/idempotencyKey` and `idempotencyKey` are accepted too.

Without a key, deduplication depends on the protocol version. Clients that open a session with `initialize` (protocol 2025-11-25 and earlier) get it within one session: a call repeated with the same JSON-RPC `id` returns the first call's receipt. Stateless 2026-07-28 clients have no session, so only the `_meta` key deduplicates. See [MCP and OpenAPI](/docs/concepts/mcp-and-openapi/#idempotent-receipts) for the full behaviour, and [Deterministic agent tools](/docs/guides/agent-tools/) for how to design a tool the model can't misuse.
