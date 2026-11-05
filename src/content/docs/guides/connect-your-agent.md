---
title: Connect your agent
description: Add a deployed actuator to Claude, ChatGPT, Cursor, Claude Code or your own agent as an MCP tool, by signing in or with an agent token.
---

Every deployed actuator is an MCP tool. Its `name` is the tool name, its `description` is what the model reads, and its `InputSchema` is the argument schema. Arguments that don't fit the schema are rejected before any of your code runs.

There are two ways to connect a client:

- **Sign in.** Paste the MCP URL into a client that supports MCP sign-in (Claude, ChatGPT, Cursor, Claude Code and others) and approve it in your browser. No token to copy.
- **An agent token.** Create a token in the dashboard and send it as `Authorization: Bearer <token>`. Use this for clients that can't sign in, scripts and your own agents.

Both give the client the same access: it can start runs and read their results, and nothing else unless you [let it cancel](#cancel-a-run) the runs it started. The dashboard's **Connect** tab on each actuator shows the URL and these snippets with real values filled in.

## Pick an endpoint

| Endpoint | Tools |
| --- | --- |
| `https://run.actuate.run/a/<actuator-id>/mcp` | One actuator, plus the built-in tools |
| `https://run.actuate.run/mcp` | Every active actuator on your account, plus the built-in tools |

The built-in tools are `actuate_get_run` and `actuate_list_runs` on every endpoint, and `actuate_cancel_run` for a client [allowed to cancel](#cancel-a-run). Paused actuators are left out of the account-wide list. A new or redeployed actuator shows up within about 30 seconds; see [tool list changes](/docs/concepts/mcp-and-openapi/#tool-list-changes).

## Sign in from your MCP client

Add the URL as a remote MCP server, with no token or header. When the client first connects, Actuate answers `401` with a pointer to its sign-in server, the client opens your browser, and you approve the connection on a page at `app.actuate.run` (sign in to the dashboard first if you aren't already).

### Claude

In Claude (on the web or in the desktop app), add a custom connector with the URL `https://run.actuate.run/mcp`, or one actuator's URL, and connect. Claude opens the Actuate sign-in page. Then turn the connector on in the chats where you want its tools. On plans that allow only one custom connector, use `https://run.actuate.run/mcp`: it carries every active actuator on your account.

When a tool's run waits, Claude gets a [receipt](#the-receipt) and the chat moves on. The receipt says what the run waits for (a sleep, an event, your approval or your answer), in which step, and links the run's page in your dashboard, so Claude can tell you where to look. Claude is not told when the run finishes. Ask it to check on the run later and it calls `actuate_get_run` with the `runId` from the receipt, which stays in the conversation; in a new chat, it can find the run again with [`actuate_list_runs`](#list-runs). Claude cannot approve or answer a run's question for you: decide in the dashboard's approvals queue, or through the links your actuator sends (see [Approvals](/docs/concepts/approvals/)). To hear about runs that fail, or that finish after waiting, without asking, turn on [alerts](/docs/guides/alerts/).

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

- It can call the tools on the endpoint you approved, `actuate_get_run`, and `actuate_list_runs`, which shows it only the runs it started. It can cancel the runs it started only if you [allow it](#cancel-a-run). It cannot approve or reject steps, answer questions, post events, deploy, change configuration, or read your tables, tokens or settings.
- It works only on the MCP endpoint it was approved for. A connection to `https://run.actuate.run/mcp` also works on each of your per-actuator `/a/<id>/mcp` URLs; a connection to one actuator's URL works only there. It is not accepted on `/a/<id>/run`, the OpenAPI document, the legacy SSE endpoints or the API at `api.actuate.run`.
- Runs it starts record it as the [agent](/docs/concepts/agents/) that started them, and it has its own row in **Settings → Agents**, where you can cap how often it may run tools and allow it to cancel its runs.

### Lifetime and revoking

- The client gets an access token that lasts **1 hour** and a refresh token that lasts **30 days**. The client refreshes on its own; every refresh issues a new refresh token, valid for another 30 days. A connection the client doesn't use for 30 days has to sign in again.
- Every refresh issues a new refresh token. The previous one keeps working until the new one is used, so a client that lost a refresh response, or two windows of the same app, end up with the same tokens. A client holding an older one is asked to sign in again; the connection itself stays.
- Connections are listed under **Settings → API tokens**, tagged **connected app** and named after the app. The row keeps the same ID for the life of the connection, so its limits and analytics carry over between refreshes. Signing in again from scratch creates a new connection with a new ID.
- **Revoke** it there to disconnect the app. The gateway stops accepting it within 30 seconds. A client can also end its own connection through the [revocation endpoint](/docs/reference/platform-api/#oauth-endpoints).

Sign-in is part of the hosted platform. The [open-source runtime](/docs/guides/self-hosting/) has no MCP endpoint.

## Use an agent token

Create an **agent token** in the dashboard under Settings → API tokens: run-scoped, the default for new tokens. It can start and read runs, and cancel the runs it started if you [allow it](#cancel-a-run), and nothing else: it cannot approve, post events, deploy, change configuration or manage your account, so an agent holding it cannot sign off its own approval gates or fake an event a run is waiting for, such as a payment. Keep full tokens for the CLI. Treat any token like a password.

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

A tool call answers after the run's first pass: your code runs from the top until it returns, throws, or reaches its first wait. A wait is a `sleep` or `sleepUntil`, a `waitForEvent`, `waitForApproval` or `waitForInput`, or a failed step's retry backoff. There is no time threshold: a run that never waits answers with its output, and a run that waits, even for a second, answers with a receipt.

- **The run finished:** the result is the run's output, as text and, when the actuator declares an `output` schema and the output is an object, as `structuredContent`.
- **The run is waiting** (sleeping, waiting for a webhook, waiting for a person, or about to retry a step): the result is a [receipt](#the-receipt). Your agent can tell the user it's in progress and check later with `actuate_get_run`:

  ```json
  { "name": "actuate_get_run", "arguments": { "runId": "run_01a19b8e...", "actuator": "refund_order" } }
  ```

  `actuator` is needed only when the endpoint has more than one actuator, as the account-wide `/mcp` usually does.
- **The run failed, the arguments were invalid, or the call was refused** by your plan's limits or the agent's own [limits](/docs/concepts/agents/#limits): the result is a [tool error](#tool-errors), with `isError: true`, a message the model can read and correct, and a code your agent can act on.

### The receipt

A receipt is text content only, with no `structuredContent`. It is a sentence for the model followed by a JSON object:

```text
Run run_01a19b8e... started and is waiting for a person to approve step "manager-ok". The approver decides in the Actuate dashboard or through the link the actuator sent; an agent cannot approve it. Call actuate_get_run with this runId to get the result later. {"runId":"run_01a19b8e...","status":"WAITING","wakeAt":"2026-11-12T10:00:00.000Z","waitingFor":"approval","step":"manager-ok","dashboardUrl":"https://app.actuate.run/actuators/refund_order/runs/run_01a19b8e..."}
```

| Field | Meaning |
| --- | --- |
| `runId` | The run to pass to `actuate_get_run` |
| `status` | `WAITING`: the run is suspended. `RUNNING`: a pass is still in progress, which is rare |
| `wakeAt` | When the run next wakes by itself, in ISO 8601: the end of a sleep, the timeout of a wait, or the next retry of a failed step. `null` when it waits for an event, approval or input with no timeout |
| `waitingFor` | What a `WAITING` run waits for: `sleep`, `event`, `approval`, `input` or `retry` (below) |
| `step` | The name of the step it waits in |
| `dashboardUrl` | The run's page in your dashboard. It needs your sign-in, so the agent can pass it on to you safely; it is not an approval link |

The sentence changes with `waitingFor`, so the model can tell the user what happens next:

| `waitingFor` | The sentence says the run is |
| --- | --- |
| `sleep` | Sleeping in the step until `wakeAt` |
| `event` | Waiting in the step for an event from outside, such as a payment, a reply or another system's callback, at most until `wakeAt` |
| `approval` | Waiting for a person to approve the step, in the dashboard or through the link the actuator sent. An agent cannot approve it |
| `input` | Waiting for a person to answer the step, in the dashboard or through the link the actuator sent. An agent cannot answer for them |
| `retry` | Waiting to retry the step after an error; the next attempt is at `wakeAt` |

A run that is waiting before it reached any step, for example because the actuator is paused or the month's budget is spent, has no `waitingFor` or `step`, and the sentence says only that it is waiting.

`actuate_get_run` answers the same way as the original call: the output once the run is `COMPLETED`; a tool error once it is `FAILED` (`RUN_FAILED`, naming the step that failed) or `CANCELLED` (`RUN_CANCELLED`); otherwise the same receipt, worded "is still waiting".

### Tool errors

A tool error has `isError: true` and one text item: a sentence for the model, then, on a second line, a JSON object for your agent's code:

```text
Rate limit: 60 runs per 60s on the Sandbox plan.
{"code":"RATE_LIMITED","retryable":true,"retryAfterSeconds":12}
```

The same object is in the result's `_meta["run.actuate/error"]`, for clients that read it there rather than parse the text.

| Field | Meaning |
| --- | --- |
| `code` | What went wrong (below) |
| `retryable` | Whether the same call may succeed later, unchanged, without the owner doing anything. Retry only when it is `true` |
| `retryAfterSeconds` | With `RATE_LIMITED`: when there is room again |
| `resetsAt` | With `BUDGET_EXHAUSTED`: when the monthly budget resets, in ISO 8601 |
| `step` | With `RUN_FAILED`: the step that failed |
| `issues` | With `INVALID_ARGUMENTS`: each problem, as `{ path, message }`. `path` is a JSON Pointer into the tool's arguments, such as `/amount`; for the built-in tools it is the argument's name, such as `limit` |

| `code` | When | `retryable` |
| --- | --- | --- |
| `INVALID_ARGUMENTS` | The arguments don't match the tool's schema. Fix them and call again | `false` |
| `RATE_LIMITED` | The plan's run rate, or the agent's own [hourly limit](/docs/concepts/agents/#limits) | `true` |
| `BUDGET_EXHAUSTED` | A monthly budget of the account is used up | `false` |
| `STORAGE_FULL` | The actuator's database, or the account's total storage, is over the plan's limit | `false` |
| `ACTUATOR_PAUSED` | The actuator is paused | `false` |
| `ACCOUNT_SUSPENDED` | The account is suspended | `false` |
| `NOT_FOUND` | No such run, or no such tool for `actuator` | `false` |
| `RUN_FAILED` | The run failed | `false` |
| `RUN_CANCELLED` | The run was cancelled | `false` |
| `NOT_CANCELLABLE` | `actuate_cancel_run`: the run already finished, or another agent started it | `false` |
| `INTERNAL` | Actuate could not complete the call | `true` |

Paused, suspended and full are not retryable: only the owner can change them, so an agent should stop and say so rather than loop. A call to a tool that doesn't exist on the endpoint is a protocol error (`-32602`, "Unknown tool"), not a tool error.

## Find and cancel runs

### List runs

`actuate_list_runs` lists a tool's recent runs, newest first, so an agent can find a run whose `runId` it no longer has, or see what is still waiting:

```json
{ "name": "actuate_list_runs", "arguments": { "actuator": "refund_order", "status": "WAITING", "limit": 10 } }
```

| Argument | Meaning |
| --- | --- |
| `actuator` | Which tool's runs. Needed only when the endpoint has more than one actuator |
| `status` | Only runs with this status: `WAITING`, `RUNNING`, `COMPLETED`, `FAILED` or `CANCELLED` |
| `limit` | Runs per page, 1 to 20. Default 10 |
| `before` | The `nextBefore` of the previous page, for older runs |

The result is a JSON object, as text and as `structuredContent`:

```json
{
  "runs": [
    {
      "runId": "run_01a19b8e...",
      "status": "WAITING",
      "createdAt": "2026-11-05T09:12:03.000Z",
      "updatedAt": "2026-11-05T09:12:04.000Z",
      "wakeAt": "2026-11-12T09:12:04.000Z",
      "waitingFor": "approval",
      "input": { "orderId": "ORD-1042", "amount": 120, "reason": "damaged" }
    }
  ],
  "nextBefore": "run_01a19b8e..."
}
```

- An agent token, or a client that signed in, sees only the runs it started. A full token sees every run.
- Entries have no output, error or steps: call `actuate_get_run` for those. `waitingFor` is as in the [receipt](#the-receipt). An input longer than 500 characters of JSON comes as a string of its first 500 characters, with `inputTruncated: true`.
- Each page looks through at most the newest 1,000 runs before `before`, so a page can come back with fewer runs than `limit`, even none, and still a `nextBefore`. Keep paging until `nextBefore` is `null`.

### Cancel a run

`actuate_cancel_run` cancels a run that is still running or waiting. It takes the same arguments as `actuate_get_run`:

```json
{ "name": "actuate_cancel_run", "arguments": { "runId": "run_01a19b8e...", "actuator": "refund_order" } }
```

```text
Run run_01a19b8e... cancelled while waiting in step "manager-ok". Steps it already completed are not undone. {"runId":"run_01a19b8e...","status":"CANCELLED","wakeAt":null,"dashboardUrl":"https://app.actuate.run/actuators/refund_order/runs/run_01a19b8e..."}
```

- **Who has it.** A full token always has the tool. Agent tokens and clients that signed in don't, until you allow it: in **Settings → Agents**, click **Edit** on the agent and tick **Can cancel runs it started**, or set [`canCancelRuns`](/docs/reference/platform-api/#tokens) through the API. Without it the tool isn't listed, and a call to it is refused as an unknown tool. The change reaches the gateway within 30 seconds.
- **Which runs.** An agent token cancels only runs it started that are `RUNNING` or `WAITING`; a full token, any run that is. Another agent's run, or one that already completed or failed, is a `NOT_CANCELLABLE` tool error. A run that is already cancelled answers "was already cancelled" with the receipt again, so a retried call is safe.
- **What it does.** The run stops and never wakes. Steps it already completed, such as a message sent or a payment taken, are not undone. The run's log records `Cancelled by agent "<name>"`.

The agent still cannot approve, reject or answer for a person, or post events.

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
