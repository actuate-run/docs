---
title: Platform API
description: The hosted platform's HTTP routes for runs, retries, versions and rollbacks, alerts, agents and tokens, plus the gateway's run and MCP routes and the OAuth endpoints for MCP clients.
---

The hosted platform has two HTTP services:

- **The gateway**, at `https://run.actuate.run`, starts and reads runs, and serves the MCP endpoints, webhooks, approval pages and OpenAPI documents. Agents talk to it.
- **The API**, at `https://api.actuate.run`, handles everything an owner does (deploy, configure, retry, roll back, alerts, tokens). The CLI and the dashboard talk to it. It is also the OAuth sign-in server for MCP clients.

None of this exists in the open-source runtime, which serves one actuator on its own [runtime HTTP API](/docs/reference/runtime-http/). Responses are JSON. Errors are `{ "error": "<message>" }` with a status code. See [errors](#errors) for the extra fields some carry.

## Authentication

| Credential | Gateway | API (`/v1`) |
| --- | --- | --- |
| **Full** API token (`ak_...`, scope `full`) | Every route below | Every route below |
| **Agent** API token (`ak_...`, scope `run`) | Starting and reading runs, MCP, SSE, OpenAPI. Not events | `GET /v1/me` only; every other route answers `403` |
| **OAuth access token** from an MCP sign-in (`oat_...`) | The MCP endpoint it was issued for only. See [MCP authorization](#mcp-authorization) | Not accepted |

Send tokens as `Authorization: Bearer <token>`. Create API tokens in the dashboard under API tokens in Settings, or with [`POST /v1/tokens`](#tokens). A revoked token stops working on the gateway within 30 seconds.

## Gateway routes

| Method | Path | Credential | What it does |
| --- | --- | --- | --- |
| `POST` | `/mcp` | API token, or OAuth token for `/mcp` | MCP endpoint with every active actuator as a tool |
| `POST` | `/a/:id/mcp` | API token, or OAuth token for this URL or `/mcp` | MCP endpoint for one actuator |
| `GET` | `/sse`, `/a/:id/sse` | API token | Legacy HTTP+SSE transport; messages go to `/messages` or `/a/:id/messages` |
| `POST` | `/a/:id/run` | API token | Start a run (trigger `api`), with optional `Idempotency-Key` |
| `GET` | `/a/:id/runs/:runId` | API token | One run with its steps and logs |
| `POST` | `/a/:id/events/:key` | Full token | Post an event |
| `POST` | `/a/:id/webhook` | Webhook secret or signature | Start a run (trigger `webhook`). See [Triggers](/docs/concepts/triggers/#webhook) |
| `GET` | `/a/:id/openapi.json` | API token | The actuator's OpenAPI document |
| `GET` | `/.well-known/oauth-protected-resource`, `.../mcp`, `.../a/:id/mcp` | none | OAuth protected resource metadata. See [MCP authorization](#mcp-authorization) |
| `GET` | `/.well-known/oauth-authorization-server` | none | The authorization server metadata, for MCP clients on the 2025-03-26 spec. See [MCP authorization](#mcp-authorization) |

`:id` is the actuator's ID (`act_...`), shown in the dashboard and printed by `actuate deploy`. A run started on `/a/:id/run` or over MCP records the token that started it in [`trigger.agent`](/docs/concepts/agents/), and counts against that token's [limits](/docs/concepts/agents/#limits).

## Errors

When a run can't start, the error body also has the fields an MCP [tool error](/docs/guides/connect-your-agent/#tool-errors) has, so a script can branch on them instead of on the message. This applies to the gateway's `/a/:id/run` and webhook routes, including refusals before the request reaches the actuator, and to the API's run, rerun and retry routes (single and bulk):

```json
{ "error": "Rate limit: 600 runs per 60s on the Maker plan.", "code": "RATE_LIMITED", "retryable": true, "retryAfterSeconds": 4 }
```

| Field | Meaning |
| --- | --- |
| `code` | What went wrong (below) |
| `retryable` | Whether the same request may succeed later, unchanged, without the owner doing anything |
| `retryAfterSeconds` | With `RATE_LIMITED`, when there is room again. Also sent as a `Retry-After` header |
| `resetsAt` | With `BUDGET_EXHAUSTED`, when the monthly budget resets, in ISO 8601 |
| `issues` | With `INVALID_ARGUMENTS` for input the schema rejects, each problem, as `{ path, field, message }`, where `path` is a JSON Pointer such as `/amount` |

| Status | `code` |
| --- | --- |
| `400` | `INVALID_ARGUMENTS`, when the input doesn't match the schema, or the body isn't JSON (the message gives the line and column, never the text around the error) |
| `403` | `ACCOUNT_SUSPENDED` |
| `404` | `NOT_FOUND`, when there is no such actuator, or no such run to retry or run again |
| `413` | `PAYLOAD_TOO_LARGE`, when the body is over 256 KiB on the gateway |
| `423` | `ACTUATOR_PAUSED`, or `ACCOUNT_SUSPENDED` |
| `429` | `RATE_LIMITED`, `BUDGET_EXHAUSTED` or `STORAGE_FULL` (the account's total storage) |
| `507` | `STORAGE_FULL`, when the actuator's database is over the plan's limit |

Only `RATE_LIMITED` and `INTERNAL` (an unexpected `500` on the gateway) are retryable. A retry of a run that isn't `FAILED` is a plain `409`, with no code. On the gateway, `GET /a/:id/runs/:runId` answers an unknown run with `NOT_FOUND`. Other errors, such as `401` for a missing token, are `{ "error" }` alone.

## Run records

Run records on the platform have the same fields as in the [runtime](/docs/reference/runtime-http/#the-run-record), plus:

| Field | Meaning |
| --- | --- |
| `version` | The actuator version the run is pinned to, or `null` for runs started before versions were recorded (those run on the current version). See [Fix, retry and roll back](/docs/guides/retry-and-rollback/) |
| `extraWakeups` | Wake-ups this run's long passes counted on top of their own. A pass longer than 5 seconds counts one more for every further 5 seconds. It resets when the run is retried. See [limits](/docs/reference/limits/#plans) |
| `trigger.agent` | `{ "id": "tok_...", "name": "..." }` for runs started over MCP or `/a/:id/run`. It holds the token's ID and its name when the run started, never the token itself |

```json
{
  "runId": "run_01a19b8e7c2d4f60a1b2c3d4e5f6",
  "status": "FAILED",
  "trigger": { "kind": "mcp", "agent": { "id": "tok_5mXq2Lr0aBc9Df1G", "name": "Claude" } },
  "version": 7,
  "input": { "orderId": "ORD-1042", "amount": 120, "reason": "damaged" },
  "output": null,
  "error": { "name": "Error", "message": "Billplz: 503 Service Unavailable" },
  "idempotencyKey": null,
  "wakeAt": null,
  "passes": 3,
  "createdAt": 1793577600000,
  "updatedAt": 1793577612000
}
```

## Runs, retries and versions

These routes are all under `https://api.actuate.run/v1`, and need a full token. `:name` is the actuator's `name`.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/actuators/:name/runs` | List runs, newest first. `limit` (default 50), `status`, and `before` (the last run ID of the previous page) |
| `GET` | `/actuators/:name/runs/:runId` | One run with its steps and logs |
| `POST` | `/actuators/:name/run` | Start a run (trigger `api`), with optional `Idempotency-Key` |
| `POST` | `/actuators/:name/runs/:runId/cancel` | Cancel a run |
| `POST` | `/actuators/:name/runs/:runId/resume` | Run another pass now |
| `POST` | [`/actuators/:name/runs/:runId/retry`](#retry-a-failed-run) | Retry a failed run from the step that failed |
| `POST` | [`/actuators/:name/runs/retry-failed`](#retry-failed-runs) | Retry the runs that failed since a time |
| `POST` | [`/actuators/:name/runs/:runId/rerun`](#run-again) | Start a new run with an earlier run's input |
| `GET` | [`/actuators/:name/versions`](#versions) | Version history |
| `POST` | [`/actuators/:name/rollback`](#roll-back) | Make an earlier version current again |

### Retry a failed run

`POST /v1/actuators/:name/runs/:runId/retry` takes no body. It continues the same run on the current version. Completed steps keep their results, and every other step runs again. It counts as a run. See [Fix, retry and roll back](/docs/guides/retry-and-rollback/#retry-a-failed-run).

```json
{ "ok": true, "retried": ["run_01a19b8e7c2d4f60a1b2c3d4e5f6"], "version": 8, "more": false, "run": { "runId": "run_01a19b8e7c2d4f60a1b2c3d4e5f6", "status": "WAITING", "version": 8, "...": "..." } }
```

The run comes back `WAITING`, due now, and continues in the background.

| Status | When |
| --- | --- |
| `404` | No such actuator or run |
| `409` | The run is not `FAILED` |
| `423` | The actuator is paused (resume it first), or the account is suspended |
| `429` | The plan's run rate or a monthly budget is used up |
| `507` | The actuator's database is over the plan's size limit |

### Retry failed runs

`POST /v1/actuators/:name/runs/retry-failed`

```json
{ "since": "2026-11-03T09:00:00Z", "limit": 100 }
```

Retries every run that failed at or after `since` (epoch milliseconds or an ISO date) and hasn't already been retried on the current version, oldest first, at most `limit` per call (1 to 100, default 100). Each retry counts as a run.

```json
{ "ok": true, "retried": ["run_01a1...", "run_01a2..."], "version": 8, "more": true }
```

`more: true` means failed runs remain, so call again. If the run budget runs out part way, the response has `stopped` with the reason. If it runs out before any run is retried, the call fails with `429`. `400` means `since` is not a time. The other errors are the same as for a single retry.

### Run again

`POST /v1/actuators/:name/runs/:runId/rerun` takes an optional `Idempotency-Key` header. It starts a **new** run (new run ID, trigger `api`, current version) with the input of `:runId`, which can be in any state. The platform validates the input against the current schema, like `POST /run`. It returns the new run record with `rerunOf` set to the old run ID, `201` for a new run.

### Versions

`GET /v1/actuators/:name/versions` returns the 50 most recent versions, newest first:

```json
{
  "current": 8,
  "versions": [
    { "version": 8, "codeHash": "9f2c...", "createdAt": 1793664000000, "current": true, "sameCodeAs": 6 },
    { "version": 7, "codeHash": "41ab...", "createdAt": 1793577600000, "current": false, "sameCodeAs": null },
    { "version": 6, "codeHash": "9f2c...", "createdAt": 1793491200000, "current": false, "sameCodeAs": null }
  ]
}
```

`sameCodeAs` names the version that first shipped the same code, which is how a rollback shows up.

### Roll back

`POST /v1/actuators/:name/rollback`

```json
{ "version": 6 }
```

This makes version 6's code, metadata and cron schedules current again as a **new** version (current + 1). Add `"config": { ... }` to replace the configuration at the same time, merged with the stored [secret fields](#configuration) as a config save is. Otherwise the platform keeps the current configuration, which must fit version 6's config schema. It returns:

```json
{ "id": "act_8KcN2fQ1xY7pLm3T", "name": "refund_order", "version": 9, "rolledBackTo": 6, "codeHash": "9f2c..." }
```

| Status | When |
| --- | --- |
| `400` | `version` is not a positive whole number |
| `402` | Your plan can't use a capability that version needs |
| `403` | The account is suspended |
| `404` | No such actuator or version |
| `409` | The version is already current; a provider that version needs isn't configured; the current config doesn't fit (the response has `issues`); or another deploy landed at the same moment |
| `422` | The version no longer passes the deploy checks (cron schedules, `http.allow`, input patterns) |
| `429` | The plan's deploy attempts per day (UTC) or per month are used up. Failed deploys count; a rollback counts once it passes its checks |

## Configuration

These routes are under `https://api.actuate.run/v1`, and need a full token.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/actuators/:name/config` | The configuration, without the values of secret fields |
| `PUT` | `/actuators/:name/config` | Replace the configuration, with `{ "config": { ... } }` |

`GET` returns the stored configuration with `null` in place of every [secret field](/docs/concepts/capabilities/#keys-and-tokens) that holds a value, and `secrets`, which says which secret fields are set:

```json
{
  "config": { "region": "eu", "apiKey": null },
  "secrets": { "apiKey": { "set": true }, "slack.botToken": { "set": false } }
}
```

`secrets` has an entry for every secret field the config schema declares, written with dots between keys, `[]` for each element of an array and `*` for each value of a record (`webhooks[].secret`, `keys.*`), plus one for each such field that holds a value (`webhooks[0].secret`, `keys.eu`). No route returns a secret's value.

`PUT` returns `{ "ok": true }`, plus `warnings` when the save dropped secrets: `["Secrets in a list whose length changed are not kept (webhooks): enter them again."]`. The platform merges the configuration you send with the stored secrets before it validates it. A secret field you leave out or send as `null` keeps its value, `""` removes it, and a list that changed length keeps none of its secrets. See [keys and tokens](/docs/concepts/capabilities/#keys-and-tokens) for the rules. A deploy that sends a configuration, and a [rollback](#roll-back) with `config`, merge the same way and return the same `warnings`.

The platform decides which fields are secret over every version the actuator has had. A field any version marked secret stays masked and kept, even after you roll back to a version where it was a plain field. The actuator's metadata that `GET /v1/actuators/:name` returns leaves out secret fields' default values.

| Status | When |
| --- | --- |
| `400` | The merged configuration doesn't match the config schema. The message is `Invalid config: ...`, with `issues`, and it names any list whose secrets were dropped, so you can enter them again. Messages never quote a secret value |
| `400` | The body isn't JSON. The message gives the line and column, not the text around the error |
| `400` | The configuration has a `__proto__` key anywhere, holds more than 5,000 values, or its schemas declare more than 500 secret fields |
| `404` | No such actuator (`NOT_FOUND`) |
| `409` | Another save, deploy or rollback changed the configuration while this one was saving it: `The config changed while this request was saving it (another save, deploy or rollback). Load it again and retry.` The body also has `"code": "CONFIG_CHANGED"` and `"retryable": true`. Nothing was written |

## Alerts

These routes are under `https://api.actuate.run/v1`, and need a full token. See [Alerts](/docs/guides/alerts/).

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/alerts` | The account's alert settings |
| `PUT` | `/alerts` | Change which alerts you get and the messaging channel |
| `POST` | `/alerts/test` | Send a test alert now |
| `GET` | `/actuators/:name/alerts` | One actuator's alert settings: `{ "muted": false, "runCompleted": false }` |
| `PUT` | `/actuators/:name/alerts` | Mute or unmute one actuator, or switch its "run completed" alerts on or off |

`GET /v1/alerts`:

```json
{
  "email": "aina@kedai.example",
  "kinds": { "run_failed": true, "paused": true, "wait_expiring": true, "cron_missed": true, "provider_auth": true },
  "runCompleted": ["refund_order"],
  "channel": { "kind": "telegram", "to": "123456789", "configured": true },
  "channelsAllowed": true,
  "availableChannels": ["telegram", "resend"]
}
```

`runCompleted` lists the actuators with [run completed](/docs/guides/alerts/#runs-that-finish-after-waiting) alerts switched on. That kind is set per actuator, so it isn't in `kinds`. `channel` is `null` for email only. `configured: false` means the provider was removed since, so alerts go by email only. `availableChannels` lists the messaging providers configured under Providers in Settings.

`PUT /v1/alerts` takes either field, or both, and returns the new settings:

```json
{ "kinds": { "wait_expiring": false }, "channel": { "kind": "telegram", "to": "123456789" } }
```

- `kinds` sets any subset of the [alert kinds](/docs/guides/alerts/#what-you-are-alerted-about) to `true` or `false`; kinds you leave out keep their setting. An unknown kind or a non-boolean returns `400`, and so does `run_completed`, which is switched on per actuator (below).
- `channel` is `{ kind, to }` to also send alerts to a messaging provider, or `null` for email only. `kind` must be a messaging provider you have configured (`409` otherwise). `to` is one recipient ID or address, at most 200 characters, with no spaces (`400` otherwise). On the Sandbox plan, setting a channel returns `402`.

`POST /v1/alerts/test` sends a test alert to your email and the channel, whatever the toggles and mutes say, and reports each:

```json
{ "ok": true, "email": "sent", "channel": "sent" }
```

`channel` is `"off"` with no channel set, or `{ "error": "<what the provider said>" }` when sending failed. You can send one test per account every 30 seconds, and another returns `429`.

`PUT /v1/actuators/:name/alerts` takes `muted`, `runCompleted`, or both, as booleans, and returns the actuator's settings:

```json
{ "runCompleted": true }
```

`muted: true` drops every alert for the actuator, "run completed" included. A body with neither field, or a value that isn't a boolean, returns `400`, and an unknown actuator returns `404`.

## Agents and tokens

These routes are under `https://api.actuate.run/v1`, and need a full token. Agent tokens can't read analytics or change limits, their own included. See [Agents](/docs/concepts/agents/).

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/tokens` | Every token on the account, including revoked ones and MCP connections |
| `POST` | `/tokens` | Create an API token |
| `PATCH` | `/tokens/:id` | Rename a token, change its limits, or let it cancel its runs |
| `DELETE` | `/tokens/:id` | Revoke a token or MCP connection |
| `GET` | `/agents` | Usage per token over a period |
| `GET` | `/agents/:tokenId/usage` | One token's usage per tool and per day |

### Tokens

`POST /v1/tokens`:

```json
{ "name": "support-bot", "scope": "run", "limits": { "runsPerHour": 200, "tools": { "refund_order": 5 } } }
```

`scope` is `"run"` (an agent token, the default) or `"full"`. `limits` is optional and only allowed on agent tokens. The response has the token itself, shown only this once:

```json
{ "id": "tok_Hn3vQ8sWk2Ze0RbY", "token": "ak_...", "scope": "run", "limits": { "runsPerHour": 200, "tools": { "refund_order": 5 } } }
```

`GET /v1/tokens` returns rows with `id`, `name`, `scope`, `kind` (`"api"`, or `"oauth"` for an MCP connection), `oauth_client_id` and `resource` (the client and MCP URL of a connection), `created_at`, `last_used_at`, `revoked_at` and `canCancelRuns` (whether the token may use `actuate_cancel_run`, always `true` for a full token).

`PATCH /v1/tokens/:id` takes any of `name` (1 to 64 characters), `limits` and `canCancelRuns`, and returns the token as an agent (below).

- `"limits": null` removes the limits. Setting limits on a full token returns `400`.
- `"canCancelRuns": true` lets an agent token, or an MCP connection, cancel the runs it started with [`actuate_cancel_run`](/docs/guides/connect-your-agent/#cancel-a-run); `false` takes it away. It must be a boolean, and setting it on a full token returns `400`, because full tokens can always cancel.
- A revoked or unknown token returns `404`. The gateway picks up changes within 30 seconds.

### Usage

`GET /v1/agents?days=7` lists the account's tokens (the newest 500) with their totals over the last `days` UTC days, today included. `days` defaults to 30 and is capped at your plan's [analytics retention](/docs/reference/limits/#plans). Revoked tokens are listed only while they have calls in the period.

```json
{
  "days": 7,
  "retentionDays": 60,
  "agents": [
    {
      "id": "tok_5mXq2Lr0aBc9Df1G",
      "name": "Claude",
      "scope": "run",
      "createdAt": 1793491200000,
      "lastUsedAt": 1793664000000,
      "revokedAt": null,
      "limits": { "tools": { "refund_order": 5 } },
      "canCancelRuns": false,
      "usage": { "calls": 412, "invalid": 9, "refused": 0, "limited": 3, "completed": 380, "failed": 12, "approved": 14, "rejected": 2, "p50Ms": 250, "p95Ms": 1000 }
    }
  ]
}
```

`canCancelRuns` says whether the token may use `actuate_cancel_run`, and is always `true` for a full token. `usage` is `null` for a token with no calls in the period. [Agents](/docs/concepts/agents/#analytics) describes the counters.

`GET /v1/agents/:tokenId/usage?days=7` returns `agent` (as above, without `usage`), `days`, `retentionDays`, `tools` (totals per actuator, with `p50Ms` and `p95Ms`) and `daily` (one row per UTC day and actuator, with the counters and `p95Ms`).

## MCP authorization

MCP clients can sign users in with OAuth 2.1 instead of asking for a token. The gateway is the protected resource, and `https://api.actuate.run` is the authorization server. This section is for people building MCP clients. To connect an existing client, see [Connect your agent](/docs/guides/connect-your-agent/#sign-in-from-your-mcp-client).

### Discovery

A `POST` to an MCP endpoint without a usable token gets:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://run.actuate.run/.well-known/oauth-protected-resource/mcp", scope="mcp"
```

A token that was sent but is expired, revoked or for another endpoint adds `error="invalid_token"`. The gateway serves the protected resource metadata (RFC 9728) for each endpoint, path-suffixed:

| URL | `resource` |
| --- | --- |
| `https://run.actuate.run/.well-known/oauth-protected-resource/mcp` | `https://run.actuate.run/mcp` |
| `https://run.actuate.run/.well-known/oauth-protected-resource/a/<id>/mcp` | `https://run.actuate.run/a/<id>/mcp` |
| `https://run.actuate.run/.well-known/oauth-protected-resource` | `https://run.actuate.run`, treated as `/mcp` |

```json
{
  "resource": "https://run.actuate.run/mcp",
  "authorization_servers": ["https://api.actuate.run"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp"],
  "resource_name": "Actuate",
  "resource_documentation": "https://actuate.run/docs"
}
```

The authorization server metadata (RFC 8414) is at `https://api.actuate.run/.well-known/oauth-authorization-server`. It lists the endpoints below, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true` and `authorization_response_iss_parameter_supported: true`. Both metadata documents allow any origin (CORS) and may be cached for 5 minutes. The gateway also serves the same authorization server document at `https://run.actuate.run/.well-known/oauth-authorization-server`, for clients on the 2025-03-26 MCP spec that look for it on the MCP server's origin. Its `issuer` is still `https://api.actuate.run`, so clients that insist the issuer match the host they fetched it from won't accept it.

### Clients

Actuate supports only public clients. There are no client secrets, and PKCE is required. A client identifies itself in one of two ways:

- **A Client ID Metadata Document (preferred).** The `client_id` is an `https` URL of a JSON document you host. Actuate fetches it when a user signs in and shows its `client_name` with the host it came from. The URL must be in normalised form, have a path, and have no query, fragment or credentials. Its host must be a public DNS name (no IP addresses, single-label names, `.local`, `.internal`, `.test` and similar, or Actuate's own hosts). Actuate fetches the document with a 3-second timeout and doesn't follow redirects. It must be at most 5 KB of JSON, its `client_id` must equal its URL, it must have no `client_secret`, `token_endpoint_auth_method` must be absent or `"none"`, `grant_types`, if present, must include `authorization_code`, and it needs 1 to 10 `redirect_uris`. Actuate caches a valid document for its `Cache-Control: max-age`, between 60 seconds and 1 hour (5 minutes by default), and not at all with `no-store`.
- **Dynamic Client Registration (RFC 7591).** `POST /oauth/register` with JSON: 1 to 5 `redirect_uris`, and optionally `client_name`, `grant_types` (only `authorization_code` and `refresh_token`) and `response_types` (only `code`). The response has a `client_id` (`dcr_...`) and `token_endpoint_auth_method: "none"`, whatever you asked for. The consent page marks these clients **unverified**. Actuate deletes registrations that no user approves within 24 hours.

Redirect URIs may be `https`, `http` on `localhost`, `127.0.0.1` or `[::1]` only, or a private-use scheme for native apps (such as `cursor://`). Actuate refuses `javascript:`, `data:`, `file:` and other unsafe schemes, fragments and credentials. The `redirect_uri` of a request must match a registered one exactly, except that a loopback redirect (`http://localhost`, `http://127.0.0.1` or `http://[::1]`) may use any port. Its host, path and query must still match, so `localhost` and `127.0.0.1` are not interchangeable.

### OAuth endpoints

On `https://api.actuate.run`:

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/oauth/authorize` | Start a sign-in. Redirects the browser to the consent page in the dashboard |
| `POST` | `/oauth/token` | Exchange a code, or refresh |
| `POST` | `/oauth/register` | Dynamic Client Registration |
| `POST` | `/oauth/revoke` | Revoke a connection (RFC 7009) |

**`/oauth/authorize`** takes `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` with `code_challenge_method=S256`, an optional `state` (at most 2,048 characters) and one `resource`, which is the MCP URL the user pasted, such as `https://run.actuate.run/mcp` or `https://run.actuate.run/a/<id>/mcp` (RFC 8707). Without a `resource` (clients on MCP specs before 2025-06-18), the connection is to `https://run.actuate.run/mcp`, every actuator in the account, and the consent page says so. Actuate refuses more than one. `scope` is not needed, because every token gets `mcp`. Actuate shows an unknown client or an unregistered redirect URI to the user as an error page, and never redirects to it. Other problems redirect back with `error` (`unsupported_response_type`, `invalid_request`, `invalid_target`). The sign-in request is valid for 10 minutes.

After the user decides, the browser returns to `redirect_uri` with `code` and `state`, or `error=access_denied`, plus `iss=https://api.actuate.run` (RFC 9207). The code is valid for 5 minutes, once.

**`/oauth/token`** takes form-encoded parameters (JSON is accepted too), at most 16 KB, with `client_id` in the body or as the user name of HTTP Basic auth:

- `grant_type=authorization_code` with `code`, `redirect_uri` and `code_verifier`. A wrong verifier uses up the code. A code presented a second time revokes the connection it was exchanged for.
- `grant_type=refresh_token` with `refresh_token`. Every refresh returns a new refresh token. The previous one stays valid until the new one is first used. Sending it again (a retry after a lost response, or another session of the same app) returns the same pair, with a fresh access-token lifetime. Once the new refresh token has been used, Actuate refuses older ones with `invalid_grant`. Nothing is revoked, so a session that fell behind signs in again and the others continue.
- `resource` is optional on both. If sent, it must name the same endpoint as the authorization request (`invalid_target` otherwise).

```json
{ "access_token": "oat_...", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "ort_...", "scope": "mcp" }
```

Access tokens last 1 hour and refresh tokens 30 days. Errors are standard OAuth errors (`invalid_grant`, `invalid_client`, `invalid_request`, `unsupported_grant_type`) with an `error_description`.

**`/oauth/revoke`** takes `token` (the access or the refresh token) and, optionally, `client_id`, and revokes the whole connection. If `client_id` is sent it must be the client the token was issued to. It always answers `200`, including for unknown tokens.

Sign-in, token and revocation calls are limited to 60 per minute and registrations to 20 per minute, per IP address. Above that, `/oauth/authorize` shows an error page and the others answer `429` with `slow_down`.

### Using the token

Send the access token as `Authorization: Bearer <token>` to the MCP endpoint named in `resource`. A token for `https://run.actuate.run/mcp` also works on that account's `/a/<id>/mcp` endpoints. No other route accepts the token, including the run API, SSE, the OpenAPI document and `api.actuate.run`. In the account it appears as an agent token named after the client (under API tokens in Settings, tagged **connected app**), with the same access as any agent token, and the owner can revoke it there.
