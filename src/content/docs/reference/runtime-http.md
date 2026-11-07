---
title: Runtime HTTP API
description: Every route of the open-source runtime served by actuate dev and self-hosted workers, with auth rules and environment variables.
---

The open-source runtime (`@actuate/runtime/worker`) serves one actuator over HTTP. This is the API you talk to under `actuate dev` at `http://localhost:8787` and when you [self-host](/docs/guides/self-hosting/). The hosted platform puts its own gateway in front, with MCP, OpenAPI and account authentication. The [Platform API](/docs/reference/platform-api/) reference covers its routes.

All responses are JSON unless this page says otherwise. The runtime ignores trailing slashes.

## Authentication

Routes are **public**, **run** or **admin**.

- **Admin** routes require `Authorization: Bearer <ACTUATE_TOKEN>`, the owner's token, and return `401 {"error":"unauthorized"}` without it.
- **Run** routes (describe the actuator, start a run, read one run) also accept `Authorization: Bearer <ACTUATE_RUN_TOKEN>`. That is the token to give your agent. Every other route answers it with `403`, so an agent can't approve its own run, answer an input step, fetch approval links, post events, cancel runs or read tables.
- **Public** routes never need a token. `/webhook` needs its own secret, and the signed token in the link protects `/approve`.

:::caution[Never give your agent ACTUATE_TOKEN]
`ACTUATE_TOKEN` can approve any waiting step and post any event, including `payment.*`. An agent holding it can get past every approval and payment wait you wrote. Give the agent `ACTUATE_RUN_TOKEN`, or only the `/webhook` secret if it never needs to read runs.
:::

The runtime **fails closed**. If neither `ACTUATE_TOKEN` nor `ACTUATE_RUN_TOKEN` is set, every admin and run route answers `503 {"error":"Set ACTUATE_TOKEN to use the admin API."}`. If `ACTUATE_WEBHOOK_SECRET` is not set, `/webhook` answers `503`. The runtime compares tokens and secrets in constant time.

The only exception is `ACTUATE_DEV=1`, which `actuate dev` sets for you. Routes whose secret is unset are then open for local use, but only to requests sent to `localhost` (or `127.0.0.1`, `[::1]`) that a web page didn't make. A request through another host, such as a tunnel or a DNS-rebinding page, or one a browser marks cross-site (`Sec-Fetch-Site`) or cross-origin (`Origin`), gets `403`. That stops a website you have open from starting runs with the real providers in your `.dev.vars`. To use these routes through a tunnel, set `ACTUATE_TOKEN` (or `ACTUATE_WEBHOOK_SECRET`) in `.dev.vars`. Never set `ACTUATE_DEV` in production.

## Routes

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| `GET` | [`/health`](#health) | public | Liveness check |
| `GET` | [`/approve?token=`](#approve) | public | The page behind an approval or input link |
| `POST` | [`/approve`](#approve) | public | Apply an approval decision or an answer |
| `POST` | [`/webhook`](#webhook) | webhook secret | Start a run (trigger `webhook`) |
| `POST` | [`/providers/:kind/webhook`](#provider-webhooks) | your verifier | A provider webhook, delivered as an event, or a button click. Only with `providerWebhook` or `providerInteractions` |
| `GET` | [`/`](#describe) | run | Describe the actuator |
| `POST` | [`/run`](#run) | run | Start a run (trigger `api`) |
| `GET` | [`/runs`](#runs) | admin | List runs |
| `GET` | [`/runs/:runId`](#get-a-run) | run | A run with its steps and logs |
| `POST` | [`/runs/:runId/cancel`](#cancel-and-resume) | admin | Cancel a run |
| `POST` | [`/runs/:runId/resume`](#cancel-and-resume) | admin | Run another pass now |
| `GET` | [`/approvals`](#approvals) | admin | Pending approvals |
| `GET` | [`/runs/:runId/approvals/:step/links`](#approvals) | admin | The signed approve and reject links of a waiting step |
| `POST` | [`/runs/:runId/approvals/:step/approve`](#approvals) | admin | Approve directly |
| `POST` | [`/runs/:runId/approvals/:step/reject`](#approvals) | admin | Reject directly |
| `POST` | [`/runs/:runId/inputs/:step`](#approvals) | admin | Answer an input step directly |
| `POST` | [`/events/:key`](#events) | admin | Post an event (`GET` too, under `actuate dev`) |
| `GET` | [`/tables`](#tables) | admin | List your tables |
| `GET` | [`/tables/:name`](#tables) | admin | Read a table as JSON or CSV |

Unknown routes return `404 {"error":"not found"}`. Unexpected errors return `500 {"error":"<message>"}`, with secret config values replaced.

There is no `/mcp` route, because the hosted platform's gateway serves the MCP endpoint, not this runtime. Callers reach a self-hosted actuator over these routes, usually `POST /run` with `ACTUATE_RUN_TOKEN`.

## The run record

`/run`, `/webhook`, `/runs` and `/runs/:runId` return run records:

```json
{
  "runId": "run_01a1998e44009c41f2e07b3d5a18",
  "status": "WAITING",
  "trigger": { "kind": "api" },
  "input": { "name": "Aina" },
  "output": null,
  "error": null,
  "idempotencyKey": "order-1042",
  "wakeAt": 1793577610000,
  "passes": 1,
  "createdAt": 1793577600000,
  "updatedAt": 1793577600000
}
```

| Field | Meaning |
| --- | --- |
| `status` | `RUNNING`, `WAITING`, `COMPLETED`, `FAILED` or `CANCELLED` |
| `output` | The value `run` returned, once `COMPLETED` |
| `error` | `{ name, message, stack? }`, once `FAILED` |
| `idempotencyKey` | The `Idempotency-Key` the run was started with, or `null` |
| `wakeAt` | Epoch ms of the next scheduled wake (sleep, timeout, retry), or `null` |
| `passes` | How many times `run` has executed |
| `createdAt`, `updatedAt` | Epoch ms |

### Secret values

These routes hide config fields wrapped in [`secret()`](/docs/reference/sdk/#secret) (JSON Schema `"writeOnly": true`) in what they return about runs. Each occurrence of their values becomes `[secret]` in run records (`/run`, `/webhook`, `/runs`, `/runs/:runId`, including `output`, `error`, `steps` and `logs`), the approval queue, the approval and input pages, and the message sent to an approver. The values come from the config schema and `ACTUATE_CONFIG`, and there is nothing to set up. Stored step results keep the real values, so replays see them. The runtime redacts reads with the values configured now, and doesn't redact [`/tables`](#tables) at all. See [keys and tokens](/docs/concepts/capabilities/#keys-and-tokens) for what is caught.

On the hosted platform, run records also have `version` and, for runs an API token started, `trigger.agent`. See [Platform API](/docs/reference/platform-api/#run-records).

## Health

`GET /health` returns `{"ok": true}`.

## Approve

`GET /approve?token=<token>` returns the HTML form for the link. It changes nothing.

- An **approval** link shows the decision ("Approve “manager-ok”"), the step's `message`, an optional note box and one button.
- An **input** link (from [`waitForInput`](/docs/concepts/approvals/#asking-for-input)) shows the prompt and a text box pre-filled with `initial`, limited to `maxLength`.
- An invalid, expired or already used link shows "Link expired".

The runtime sends both with `Cache-Control: no-store`, `X-Frame-Options: DENY` and a Content-Security-Policy that forbids framing, so the token in the link isn't cached and the page can't be embedded in another site.

`POST /approve` takes a form-encoded body (at most 64 KiB) with `token`, plus `note` for an approval or `text` for an input answer. It records the decision or answer and resumes the run. It returns an HTML page and status `200` on success, or `410` when the token is invalid, expired or already used, or the answer is empty or longer than `maxLength`. Links are single use. Once a step is decided or answered, its links return `410`. See [Human approvals and input](/docs/concepts/approvals/).

## Webhook

`POST /webhook` starts a run with the JSON body as input and `trigger.kind = "webhook"`. It has the same validation, responses and `Idempotency-Key` handling as [`POST /run`](#run).

The request must prove it knows `ACTUATE_WEBHOOK_SECRET`, or it gets `401`. If the secret is not set at all, the route answers `503` (except under `ACTUATE_DEV=1`). It doesn't need the admin token. There are two ways to prove the secret:

- **Signature (preferred).** Sign the raw body GitHub-style: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body, keyed with the secret>`. GitHub does this for you when you set the secret on the repository's webhook. A signed delivery's idempotency key is its signature, because headers aren't signed. A captured request replayed with a new `X-GitHub-Delivery` or `Idempotency-Key` returns the original run instead of starting another.
- **Shared secret.** Send it as the `x-actuate-secret` header, or as `?secret=` for senders that can't set headers. Query strings end up in proxy and sender logs, so prefer the header, and rotate the secret if a URL leaks. `Idempotency-Key`, or else `X-GitHub-Delivery`, is the idempotency key.

## Provider webhooks

`/providers/:kind/webhook` (any method) exists when you pass a `providerWebhook` function, a `providerInteractions` function or both to `createRuntime` (see [Self-hosting](/docs/guides/self-hosting/#5-providers)). `:kind` is lowercase letters, digits and hyphens, for example `stripe`. On a `POST`, the provider's `parseInteraction` (from `providerInteractions`) reads the request first. It answers a button click or a reply the chat app needs, such as Discord's PING. Anything else goes to `providerWebhook`, which verifies the request and returns what to do. `parseProviderWebhookFromEnv` and `providerInteractionsFromEnv` from `@actuate/providers` do this for the built-in providers:

| Your function | Response |
| --- | --- |
| `parseInteraction` finds an Approve or Reject click | The runtime checks the clicker against the provider's approver list, decides the step and answers with the provider's reply. See [Approval buttons](/docs/guides/approval-buttons/) |
| Returns `{ event, payload }` | The runtime delivers the event as [`POST /events/:key`](#events) does, and responds `{ "event", "resumed", "buffered" }` |
| Returns an array of them | The runtime delivers each in order, and responds `{ "events": [ ... ] }` |
| Returns `{ reply: "<text>" }` | `200` with that text as `text/plain`, for subscription handshakes such as Meta's `hub.challenge` |
| Returns `{ reply: { status, contentType, body } }` | That status, content type and body. `contentType` defaults to `text/plain` |
| Returns `null`, or there is no `providerWebhook` | `{ "ignored": true }` |
| Throws an error named `WebhookVerificationError` | `401 {"error": "<message>"}` |

The route needs no admin token, because verification is your function's job.

## Describe

`GET /` describes the actuator:

```json
{
  "name": "deposit_booking",
  "description": "Books a slot, sends a payment link, waits for the webhook or reminds.",
  "capabilities": ["payment", "messaging"],
  "input": { "type": "object", "properties": { ... }, "required": [ ... ] },
  "config": { "type": "object", "properties": { ... } },
  "configError": null
}
```

`input` and `config` are JSON Schema generated from the Zod schemas (input side, so fields with defaults are optional). `configError` is a message when the configuration is invalid. While it is set, every run fails with a `ConfigError`. Because `GET /` serves it to run tokens too, it never carries a secret:

| Problem | `configError` |
| --- | --- |
| `ACTUATE_CONFIG` isn't JSON | `Invalid ACTUATE_CONFIG: it is not valid JSON (line 1, column 24).` Only the position, never the text around the error |
| The schema rejects the configuration, or a `transform` or `refine` in it throws | `Invalid configuration: <message>`, with secret values replaced |
| A custom `config(env)` throws, or the schema throws and can't be described as JSON Schema | `Invalid configuration: config(env) threw TypeError. The error is in the worker's logs.` (or `the config schema threw ...`), with only the error's name. The full error goes to the worker's logs |

## Run

`POST /run` starts a run with the JSON body as input and `trigger.kind = "api"`.

| Response | When |
| --- | --- |
| `201` + run record | A new run was started. The record reflects the end of its first pass |
| `200` + run record | The `Idempotency-Key` header (or `X-GitHub-Delivery`) matched an existing run, or, without one, the actuator's [`idempotencyKey`](/docs/reference/sdk/#idempotencykey) fields matched a run that is running, waiting or completed in the last 24 hours. Nothing new was started |
| `400 {"error":"Request body must be JSON."}` | The body is not JSON |
| `400 {"error":"Invalid input","issues":[...]}` | The body failed the input schema; `issues` are Zod issues |

The request returns once the first pass ends, so a run that does not wait comes back `COMPLETED` with its output.

## Runs

`GET /runs` lists runs, newest first. Run IDs sort by creation time, so the list is ordered by run ID.

| Query | Default | Meaning |
| --- | --- | --- |
| `limit` | `50` | 1 to 500 |
| `before` | none | A run ID (exact, newest first by run ID) or an epoch-ms `createdAt`. Pass the last run's `runId` to get the next page |
| `status` | none | Only runs with this status |

## Get a run

`GET /runs/:runId` returns the run record plus:

- `steps`, the journal in order, as `{ name, status, output, wakeAt, event, attempts, error, updatedAt }`;
- `logs`, up to 500 log lines in pass order, as `{ ts, level, message, data }`. Each pass keeps at most 100 lines (then one warning line). The runtime cuts messages at 2,000 characters, and replaces `data` larger than about 4 KB with `{ "truncated": "<first 4,000 characters of its JSON>" }`.

It returns `404` if the run does not exist.

## Cancel and resume

`POST /runs/:runId/cancel` cancels a `RUNNING` or `WAITING` run and returns `{"cancelled": true}`, or `{"cancelled": false}` if it had already settled. A cancelled run never wakes.

`POST /runs/:runId/resume` runs another pass immediately and returns the run record. Sleeps, retries and waits that are not due yet suspend again, so it only moves a run forward when what it waits for is already due. It does nothing to settled (`COMPLETED`, `FAILED`, `CANCELLED`) runs.

## Approvals

`GET /approvals` lists steps waiting for a person, oldest first. `kind` is `"approval"` or `"input"`, and `message` is the approval message or the input prompt:

```json
[{ "runId": "run_...", "step": "manager-ok", "kind": "approval", "message": "Refund RM80 to Aina?", "expiresAt": 1793664000000, "since": 1793577600000 }]
```

`GET /runs/:runId/approvals/:step/links` returns the signed links for a step that is waiting for a person, for an owner who has no messaging channel. For an approval:

```json
{ "approveUrl": "https://bot.example.com/approve?token=...", "rejectUrl": "https://bot.example.com/approve?token=...", "expiresAt": 1793664000000 }
```

For an input step it returns `{ "answerUrl": "...", "expiresAt": ... }`. To answer directly, send `POST /runs/:id/inputs/:step` with `{ "text": "..." }` (admin auth). It returns `{"ok": true, "runId", "step", "approved": true}`, or `{"ok": false, "reason": "..."}` if the step isn't waiting for an answer, or the answer is empty or longer than `maxLength`.

It returns `404` if that step is not waiting. The runtime never writes the links to run logs, so this route (behind `ACTUATE_TOKEN`) and the messaging notification are the only ways to get them.

`POST /runs/:runId/approvals/:step/approve` (or `/reject`) decides without the signed link. The runtime stores an optional JSON body `{"note": "..."}` in the result's `note`. It returns `{"ok": true, "runId", "step", "approved"}`, or `{"ok": false, "reason"}` if the step is not waiting for a decision.

## Events

`POST /events/:key` posts an event with the JSON body as its payload, up to 64 KiB of JSON. Every step waiting on `key` completes with the payload and its run resumes. If none is waiting, the runtime buffers the event for the next wait (for up to 7 days).

```json
{ "resumed": ["run_01a1998e44009c41f2e07b3d5a18"], "buffered": false }
```

- The runtime delivers a body that is missing, not JSON, or `null` as `{}`. It never delivers an event as `null`, so `null` from a wait always means a timeout.
- The runtime refuses a larger payload with `500 {"error":"Event payload is too large."}`.
- If no step is waiting, the runtime buffers the event. It buffers at most 1,000 events per actuator, and beyond that drops the oldest.
- Under `actuate dev` only, `GET /events/:key` posts the event too, so you can open the local fake payment provider's bill links in a browser. Elsewhere `GET` answers `404`. For `payment.<referenceId>` keys the payload is `{"provider":"dev","status":"paid","referenceId":"<referenceId>","via":"GET"}`; for other keys it is `{"via":"GET"}`.
- Keys starting with `approval:` are reserved, and the runtime refuses a post to one.

The response returns after the resumed runs' next pass.

## Tables

`GET /tables` lists your tables: `["bookings", "greetings"]`. It leaves out the runtime's own tables (`_actuate_*`), SQLite's (`sqlite_*`), Cloudflare's (`_cf_*`) and the one `actuate dev` adds through Miniflare (`__miniflare_*`).

`GET /tables/:name` returns `{ "columns": [...], "rows": [...] }`.

| Query | Default | Meaning |
| --- | --- | --- |
| `limit` | `100` | 1 to 10,000 rows |
| `offset` | `0` | Rows to skip |
| `format` | JSON | `csv` returns a CSV download named `<name>.csv`. The runtime prefixes text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return with `'`, so a spreadsheet never runs them as formulas |

An unknown table returns `404 {"error":"Unknown table"}`. Tables are your own data, and the runtime doesn't [redact](#secret-values) them.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ACTUATE_CONFIG` | JSON object of configuration, validated against the actuator's `config` schema. Default `{}`. Invalid JSON or values set `configError` and fail every run. The routes [redact](#secret-values) the values of `secret()` fields from everything they return. Set it with `wrangler secret put` when it holds one |
| `ACTUATE_TOKEN` | The owner's bearer token, for every admin and run route. Keep it for yourself and your dashboards, and never give it to an agent. When it is unset (and `ACTUATE_RUN_TOKEN` is unset too), admin routes answer `503` |
| `ACTUATE_RUN_TOKEN` | Bearer token for an agent, for `GET /`, `POST /run` and `GET /runs/:runId` only. Every other route answers it with `403` |
| `ACTUATE_WEBHOOK_SECRET` | Secret for `POST /webhook`. It signs the body (`X-Hub-Signature-256`), or is sent as `x-actuate-secret` or `?secret=`. It is required to accept webhooks. When it is unset, `/webhook` answers `503` |
| `ACTUATE_APPROVAL_SECRET` | HMAC secret for approval links. If it is unset, the runtime generates one on first start and keeps it in the Durable Object's storage |
| `ACTUATE_PUBLIC_URL` | Public origin used in approval links, provider callback URLs and the self-call check, for example `https://bot.example.com`. **Set it in production.** If it is unset, the runtime uses and remembers the origin of the first request made with `ACTUATE_TOKEN` (under `actuate dev`, the first request to localhost). Until then, approval links are relative and the runtime logs a warning. A request from anyone else never sets it, so a forged `Host` header can't redirect approval links |
| `ACTUATE_DEV` | `1` only for local development (`actuate dev` sets it). Routes whose secret is unset are served open, to localhost requests not made by a web page, instead of answering `503` |

Set the secrets with `wrangler secret put` rather than in a config file.

## Cron

Cron schedules do not have an HTTP route. The Worker's `scheduled` handler receives each firing and starts a run with input `{}` and `trigger: { kind: "cron", cron: "<expression>" }`. If the input schema rejects `{}`, the runtime skips the firing and logs an error.
