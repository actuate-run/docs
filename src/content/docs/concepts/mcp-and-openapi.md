---
title: MCP and OpenAPI
description: Every deployed actuator is an MCP tool and has an OpenAPI document, generated from its name, description and InputSchema. This page also covers protocol versions, annotations, caching and idempotency on the hosted MCP server.
---

When you deploy an actuator, the platform publishes it two ways:

- a **hosted MCP server**, over Streamable HTTP (and the legacy HTTP+SSE transport), where the actuator is a tool an AI agent can call;
- an **OpenAPI document**, for any HTTP client or agent framework that speaks OpenAPI.

`actuate deploy` prints both URLs:

| URL | What it serves |
| --- | --- |
| `https://run.actuate.run/a/<actuator-id>/mcp` | MCP for one actuator, plus the [built-in tools](#built-in-tools) |
| `https://run.actuate.run/mcp` | MCP for every active actuator on your account, plus the [built-in tools](#built-in-tools) |
| `https://run.actuate.run/a/<actuator-id>/sse`, `https://run.actuate.run/sse` | The same, over the legacy HTTP+SSE transport |
| `https://run.actuate.run/a/<actuator-id>/openapi.json` | The OpenAPI document |

MCP clients either [sign in with OAuth](/docs/guides/connect-your-agent/#sign-in-from-your-mcp-client) or send an API token as `Authorization: Bearer <token>`; an Agent (run-scoped) token is enough. The OpenAPI document and the HTTP routes it describes take an API token only. See [Connect your agent](/docs/guides/connect-your-agent/).

## From actuator to tool

The platform generates both from the actuator definition:

| Actuator field | Becomes |
| --- | --- |
| `name` | The tool name. The tool's `title` is the name with underscores turned into spaces (`refund_order` becomes "refund order") |
| `description` | The tool description |
| `input` (InputSchema) | The tool's argument schema, as JSON Schema |
| `output` | The tool's `outputSchema`, when you set one and it describes an object |
| `hints` | The tool's [annotations](#tool-hints) |

This is why `name` is restricted to lowercase letters, digits and underscores (at most 64 characters), and why `description` is required. Names starting with `actuate_` are reserved for the [built-in tools](#built-in-tools). The platform refuses to deploy them, and `actuate check --platform` and `actuate deploy` say so before you upload.

Write the description and field descriptions for a model, because a model reads them to decide when and how to call the tool:

```ts
export const InputSchema = z.object({
  orderId: z.string().describe("The order to refund, e.g. ORD-1042"),
  amount: z.number().positive().max(500).describe("Refund amount in RM, at most 500"),
  reason: z.enum(["damaged", "late", "wrong_item", "other"]).describe("Why the customer is owed a refund"),
});

export default defineActuator({
  name: "refund_order",
  description:
    "Refund part or all of a paid order. Refunds above RM 100 wait for a manager's approval. " +
    "Returns the refund status. Call once per refund; retries are safe.",
  input: InputSchema,
  // ...
});
```

The platform generates the JSON Schema from the schema's input type, so fields with a `.default()` are optional for the caller.

## Built-in tools

Besides your actuators, an endpoint has these tools:

| Tool | What it does | Listed for |
| --- | --- | --- |
| `actuate_get_run` | Returns the status and result of a run another tool started, as the original call would answer. See [what a tool call returns](/docs/guides/connect-your-agent/#what-a-tool-call-returns) | Every token |
| `actuate_list_runs` | Lists a tool's recent runs, newest first, with what each waiting run waits for. An agent token sees only the runs it started, and may call it 30 times a minute. See [list runs](/docs/guides/connect-your-agent/#list-runs) | Every token |
| `actuate_cancel_run` | Cancels a running or waiting run. An agent token cancels only the runs it started. See [cancel a run](/docs/guides/connect-your-agent/#cancel-a-run) | Full tokens, and agent tokens you allowed to cancel |

On an endpoint with more than one actuator, each takes an `actuator` argument naming the tool whose run it is.

## Tool hints

MCP clients ask a person before running tools that change things, and some agents treat read-only tools differently. Tell them what your tool does with `hints`:

```ts
export default defineActuator({
  name: "order_status",
  description: "Looks up an order's payment and delivery status.",
  input: z.object({ orderId: z.string() }),
  hints: { readOnly: true, idempotent: true, openWorld: false },
  async run(ctx, input) {
    return ctx.db.first("SELECT status FROM orders WHERE id = ?", [input.orderId]);
  },
});
```

The hosted server always sends all four annotations, so clients and directories never fall back to their own defaults:

| Hint | MCP annotation | Sent when you don't set it | Set it when |
| --- | --- | --- | --- |
| `readOnly` | `readOnlyHint` | `false` | The tool never changes anything |
| `idempotent` | `idempotentHint` | `false`, or `true` for a read-only tool | Calling it twice with the same arguments has the same effect as once |
| `destructive` | `destructiveHint` | `true`, or `false` for a read-only tool | It may delete or irreversibly change data. Set `false` for additive tools such as "create a draft" |
| `openWorld` | `openWorldHint` | `true` if the actuator declares any capability (`messaging`, `payment`, `llm`, `http`, required or optional), `false` otherwise | It talks to the outside world, through messages, payments or other APIs. Set `false` when it only touches its own database |

The server treats `readOnly: true` together with `destructive: true` as not read-only, and sends the tool as destructive. It always sends a read-only tool as idempotent and not destructive, whatever `idempotent` and `destructive` say. It sends `actuate_get_run` and `actuate_list_runs` as read-only, idempotent, not destructive and closed-world. It sends `actuate_cancel_run` as not read-only, destructive, idempotent (cancelling twice changes nothing more) and closed-world.

Hints describe the tool to clients; they don't enforce anything. The schema, your code and `waitForApproval` do that.

## Validation before code runs

The gateway validates arguments against the InputSchema before the actuator wakes. It rejects a call with a missing field, a wrong type or an amount over the `max`, so no run is created and none of your code executes. The model gets a precise error it can correct, instead of a half-executed process, and your agent gets the code `INVALID_ARGUMENTS` with each field and reason in `issues`.

Put every rule you can into the schema: enums instead of free strings, `min` and `max` on amounts, `regex` on phone numbers. The model cannot call the tool with arguments the schema rejects.

## Protocol versions

The hosted server speaks both the stateless 2026-07-28 protocol and the older, session-based versions. Clients pick one; you don't configure anything.

| Version | How the client uses it |
| --- | --- |
| `2026-07-28` | Stateless. There is no `initialize` and no `Mcp-Session-Id`. Every request carries its protocol version and client capabilities in `_meta`, and the matching `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. `server/discover` describes the server |
| `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` | `initialize` picks the version. A client that asks for a version not in this list gets `2025-11-25`. The server returns an `Mcp-Session-Id`, which it uses only to [deduplicate retried calls](#idempotent-receipts) |

The server implements `tools/list`, `tools/call` and, for session-based clients, `initialize` and `ping`. It answers every request with a JSON response and never opens a server-to-client stream, so `GET` and `DELETE` on an MCP endpoint return `405` with `Allow: POST`. The server still serves the legacy HTTP+SSE transport (protocol 2024-11-05) at `/sse` and `/a/<id>/sse` for old clients, with an API token only.

Errors follow the protocol:

| Situation | Response |
| --- | --- |
| 2026-07-28 request with a header that is missing or doesn't match the body | `400`, JSON-RPC error `-32020` |
| 2026-07-28 request naming a version the server doesn't support | `400`, error `-32022`, with `data.supported` listing the versions above |
| 2026-07-28 request without `_meta["io.modelcontextprotocol/protocolVersion"]` or `_meta["io.modelcontextprotocol/clientCapabilities"]` | `400`, error `-32602` |
| Session-based request with an `MCP-Protocol-Version` header the server doesn't support | `400`, error `-32600`, with `data.supported` |
| Unknown method | Error `-32601` (`404` for 2026-07-28 requests) |
| Unknown tool | Error `-32602`, with status `200` |
| A request body that isn't JSON | `400`, JSON-RPC error `-32700` (parse error), giving the line and column |
| A request body over 256 KiB | `413`, error `-32600` |

Errors in a tool call itself, such as invalid arguments, a refused run or a failed run, are not protocol errors. The result has `isError: true`, a message for the model, and a JSON line with a `code` and whether to retry, which is also in `_meta["run.actuate/error"]`. See [tool errors](/docs/guides/connect-your-agent/#tool-errors).

A request without credentials, or with a token that is expired, revoked or for another endpoint, gets `401` with a `WWW-Authenticate` header that points MCP clients at the sign-in server. See [Platform API](/docs/reference/platform-api/#mcp-authorization).

## Tool list changes

The tool list changes when you deploy, roll back, pause or resume an actuator. The server does not send list-change notifications (they need a server stream, which it doesn't open), so it reports `listChanged: false`. Instead:

- 2026-07-28 clients get `ttlMs: 60000` with `cacheScope: "private"` on `tools/list`, so they may cache the list for a minute, for this token only. Clients may cache `server/discover` for an hour.
- Session-based clients see changes when they list tools again or reconnect.

The gateway itself picks up a deploy within about 30 seconds.

## Idempotent receipts

Agents retry, and networks drop responses. An MCP tool call to an actuator returns an **execution receipt**, and a retried tool call can return the first run's receipt instead of running again. Combined with [steps](/docs/concepts/steps-and-replay/), a refund tool called twice refunds once.

To get this, put an idempotency key in the call's `_meta`:

```json
{
  "name": "refund_order",
  "arguments": { "orderId": "2291", "amount": 120, "reason": "damaged" },
  "_meta": { "run.actuate/idempotencyKey": "refund-2291" }
}
```

- The same key on the same tool returns the same run, across sessions and processes, for as long as the platform keeps that run: 7 days on Sandbox, 30 on Maker and 90 on Agency after it settles. A run still waiting is never deleted. The server also reads `actuate/idempotencyKey` and `idempotencyKey`, in that order, after `run.actuate/idempotencyKey`.
- Keys are per actuator, so the same key on two tools starts two runs. The server also keeps MCP keys apart from HTTP `Idempotency-Key` values, so a key sent over MCP never matches one sent to `/run`.
- Without a key, a session-based client (2025-11-25 and earlier) that repeats a call with the same JSON-RPC `id` in the same session gets the first call's receipt. A 2026-07-28 client has no session, and JSON-RPC IDs are reused across processes, so without a key every call starts a new run.

The same guarantee is available over plain HTTP with the [`Idempotency-Key` header](/docs/concepts/triggers/#idempotency-key).

## Self-hosted

The MCP server, OAuth sign-in and OpenAPI document are part of the hosted platform. The open-source runtime exposes the same generated JSON Schema at `GET /` (see [Runtime HTTP API](/docs/reference/runtime-http/#describe)) and validates input on `/run` and `/webhook` in the same way.

See [Deterministic agent tools](/docs/guides/agent-tools/) for how to design actuators for agents.
