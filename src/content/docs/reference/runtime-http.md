---
title: Runtime HTTP API
description: Every route of the open-source runtime served by actuate dev and self-hosted workers, with auth rules and environment variables.
---

The open-source runtime (`@actuate/runtime/worker`) serves one actuator over HTTP. This is the API you talk to under `actuate dev` at `http://localhost:8787` and when you [self-host](/docs/guides/self-hosting/). The hosted platform puts its own gateway in front, with MCP, OpenAPI and account authentication.

All responses are JSON unless noted. Trailing slashes are ignored.

## Authentication

Routes are either **public** or **admin**.

- **Admin** routes require `Authorization: Bearer <ACTUATE_TOKEN>` when `ACTUATE_TOKEN` is set, and return `401 {"error":"unauthorized"}` otherwise. **When `ACTUATE_TOKEN` is unset, admin routes are open**, which is only appropriate for local development.
- **Public** routes never need the token. `/webhook` has its own optional secret, and `/approve` is protected by the signed token in the link.

## Routes

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| `GET` | [`/health`](#health) | public | Liveness check |
| `GET` | [`/approve?token=`](#approve) | public | Approval confirmation page |
| `POST` | [`/approve`](#approve) | public | Apply an approval decision |
| `POST` | [`/webhook`](#webhook) | webhook secret | Start a run (trigger `webhook`) |
| `POST` | [`/providers/:kind/webhook`](#provider-webhooks) | your verifier | A provider webhook, delivered as an event. Only with `providerWebhook` |
| `GET` | [`/`](#describe) | admin | Describe the actuator |
| `POST` | [`/run`](#run) | admin | Start a run (trigger `api`) |
| `GET` | [`/runs`](#runs) | admin | List runs |
| `GET` | [`/runs/:runId`](#get-a-run) | admin | A run with its steps and logs |
| `POST` | [`/runs/:runId/cancel`](#cancel-and-resume) | admin | Cancel a run |
| `POST` | [`/runs/:runId/resume`](#cancel-and-resume) | admin | Run another pass now |
| `GET` | [`/approvals`](#approvals) | admin | Pending approvals |
| `POST` | [`/runs/:runId/approvals/:step/approve`](#approvals) | admin | Approve directly |
| `POST` | [`/runs/:runId/approvals/:step/reject`](#approvals) | admin | Reject directly |
| `POST`, `GET` | [`/events/:key`](#events) | admin | Post an event |
| `GET` | [`/tables`](#tables) | admin | List your tables |
| `GET` | [`/tables/:name`](#tables) | admin | Read a table as JSON or CSV |

Unknown routes return `404 {"error":"not found"}`. Unexpected errors return `500 {"error":"<message>"}`.

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

## Health

`GET /health` returns `{"ok": true}`.

## Approve

`GET /approve?token=<token>` returns an HTML page that names the decision ("Approve “manager-ok”") with a single button. It changes nothing.

`POST /approve` with a form field `token` applies the decision and resumes the run. It returns an HTML page and status `200` on success, or `410` when the token is invalid, expired or already used. Links are single use: once a step is decided, both of its links return `410`. See [Human approvals](/docs/concepts/approvals/).

## Webhook

`POST /webhook` starts a run with the JSON body as input and `trigger.kind = "webhook"`. Same validation, responses and `Idempotency-Key` handling as [`POST /run`](#run).

When `ACTUATE_WEBHOOK_SECRET` is set, the request must carry it as the `x-actuate-secret` header or the `secret` query parameter, or it gets `401`. The admin token is not required.

## Provider webhooks

`POST /providers/:kind/webhook` exists only when you pass a `providerWebhook` function to `createRuntime` (see [Self-hosting](/docs/guides/self-hosting/#5-providers)). `:kind` is lowercase letters, digits and hyphens, for example `stripe`. Your function verifies the request and returns the event to deliver:

| Your function | Response |
| --- | --- |
| Returns `{ event, payload }` | The event is delivered as by [`POST /events/:key`](#events): `{ "event", "resumed", "buffered" }` |
| Returns `null` | `{ "ignored": true }` |
| Throws an error named `WebhookVerificationError` | `401 {"error": "<message>"}` |

The route needs no admin token: verification is your function's job.

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

`input` and `config` are JSON Schema generated from the Zod schemas (input side, so fields with defaults are optional). `configError` is a message when the configuration is invalid; while it is set, every run fails with a `ConfigError`.

## Run

`POST /run` starts a run with the JSON body as input and `trigger.kind = "api"`.

| Response | When |
| --- | --- |
| `201` + run record | A new run was started. The record reflects the end of its first pass |
| `200` + run record | The `Idempotency-Key` header matched an existing run; nothing new was started |
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

- `steps`: the journal, in order: `{ name, status, output, wakeAt, event, attempts, error, updatedAt }`;
- `logs`: up to 500 log lines, in pass order: `{ ts, level, message, data }`. Each pass keeps at most 100 lines (then one warning line); messages are cut at 2,000 characters, and `data` larger than about 4 KB is replaced by `{ "truncated": "<first 4,000 characters of its JSON>" }`.

`404` if the run does not exist.

## Cancel and resume

`POST /runs/:runId/cancel` cancels a `RUNNING` or `WAITING` run and returns `{"cancelled": true}`, or `{"cancelled": false}` if it had already settled. A cancelled run never wakes.

`POST /runs/:runId/resume` runs another pass immediately and returns the run record. Sleeps, retries and waits that are not due yet suspend again, so it only moves a run forward when what it waits for is already due. It does nothing to settled (`COMPLETED`, `FAILED`, `CANCELLED`) runs.

## Approvals

`GET /approvals` lists steps waiting for a decision, oldest first:

```json
[{ "runId": "run_...", "step": "manager-ok", "message": "Refund RM80 to Aina?", "expiresAt": 1793664000000, "since": 1793577600000 }]
```

`POST /runs/:runId/approvals/:step/approve` (or `/reject`) decides without the signed link. An optional JSON body `{"note": "..."}` is stored in the result's `note`. Returns `{"ok": true, "runId", "step", "approved"}`, or `{"ok": false, "reason"}` if the step is not waiting for a decision.

## Events

`POST /events/:key` posts an event with the JSON body as its payload, up to 64 KiB of JSON. Every step waiting on `key` completes with the payload and its run resumes; if none is waiting, the event is buffered for the next wait (for up to 7 days).

```json
{ "resumed": ["run_01a1998e44009c41f2e07b3d5a18"], "buffered": false }
```

- A body that is missing, not JSON, or `null` is delivered as `{}`. An event is never delivered as `null`, so `null` from a wait always means a timeout.
- A larger payload is refused with `500 {"error":"Event payload is too large."}`.
- If no step is waiting, the event is buffered. At most 1,000 events are buffered per actuator; beyond that the oldest are dropped.
- `GET /events/:key` posts the event too, so the local fake payment provider's bill links can be opened in a browser. For `payment.<referenceId>` keys the payload is `{"provider":"dev","status":"paid","referenceId":"<referenceId>","via":"GET"}`; for other keys it is `{"via":"GET"}`.
- Keys starting with `approval:` are reserved; posting one is refused.

The response returns after the resumed runs' next pass.

## Tables

`GET /tables` lists your tables, excluding runtime (`_actuate_*`) and SQLite internal tables: `["bookings", "greetings"]`.

`GET /tables/:name` returns `{ "columns": [...], "rows": [...] }`.

| Query | Default | Meaning |
| --- | --- | --- |
| `limit` | `100` | 1 to 10,000 rows |
| `offset` | `0` | Rows to skip |
| `format` | JSON | `csv` returns a CSV download named `<name>.csv` |

An unknown table returns `404 {"error":"Unknown table"}`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ACTUATE_CONFIG` | JSON object of configuration, validated against the actuator's `config` schema. Default `{}`. Invalid JSON or values set `configError` and fail every run |
| `ACTUATE_TOKEN` | Bearer token for the admin routes. Unset means open: local development only |
| `ACTUATE_WEBHOOK_SECRET` | Shared secret for `POST /webhook`, sent as `x-actuate-secret` or `?secret=`. Unset means the webhook is open |
| `ACTUATE_APPROVAL_SECRET` | HMAC secret for approval links. If unset, one is generated on first start and kept in the Durable Object's storage |
| `ACTUATE_PUBLIC_URL` | Public origin used in approval links, e.g. `https://bot.example.com`. If unset, the origin of the first request is used and remembered |

Set the secrets with `wrangler secret put` rather than in a config file.

## Cron

Cron schedules do not have an HTTP route. The Worker's `scheduled` handler receives each firing and starts a run with input `{}` and `trigger: { kind: "cron", cron: "<expression>" }`. If the input schema rejects `{}`, the firing is skipped and an error is logged.
