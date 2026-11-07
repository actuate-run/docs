---
title: Triggers
description: Runs start from the API, a webhook, a cron schedule or an MCP tool call.
---

A run starts when something sends the actuator an input. Every trigger validates the input against the actuator's `input` schema before any code runs. `ctx.trigger` tells `run` how it started:

```ts
if (ctx.trigger.kind === "cron") ctx.log.info(`Scheduled run: ${ctx.trigger.cron}`);
```

| `ctx.trigger.kind` | Started by |
| --- | --- |
| `api` | `POST /run`, `actuate run` |
| `webhook` | `POST /webhook` |
| `cron` | A cron schedule; `ctx.trigger.cron` is the expression |
| `mcp` | An MCP tool call |
| `manual` | Reserved for runs started by hand |

On the hosted platform, a run started with an API token, over MCP or `POST https://run.actuate.run/a/<id>/run`, also has `ctx.trigger.agent`, which is the `{ id, name }` of the token that started it (never the token itself). It is absent for webhooks, cron and the open-source runtime. See [Agents](/docs/concepts/agents/#which-agent-started-a-run).

A request to `/run` or `/webhook` returns after the run's **first pass**. The response is the run record with status `COMPLETED`, `FAILED` or `WAITING`. A run that finishes without waiting returns its output immediately; one that sleeps returns `WAITING` and continues in the background.

## API

```bash
curl -X POST "$ACTUATOR_URL/run" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1042' \
  -d '{"customerName":"Aina","phone":"+60123456789","appointmentIso":"2026-11-05T09:00:00Z"}'
```

`$ACTUATOR_URL` is the actuator's address, which is `http://localhost:8787` under `actuate dev`, or your own origin when [self-hosting](/docs/guides/self-hosting/). On the platform, the OpenAPI document describes the endpoint. The body is the input. A new run returns `201 Created`; invalid input returns `400` with `{ "error": "Invalid input", "issues": [...] }` and creates no run. On the platform, the error names each field and what is wrong with it, for example `{ "error": "Invalid input: amount must be at least 1; email is required", "issues": [{ "path": "/amount", "field": "amount", "message": "must be at least 1" }, ...] }`. The platform checks config saved in the dashboard or at deploy the same way.

### Idempotency-Key

Send an `Idempotency-Key` header to make retries safe. The first request with a key starts a run; any later request with the same key returns that same run, with `200 OK` instead of `201`, and starts nothing. If the duplicate arrives while the first request is still in its first pass, it waits and returns the result. Actuate stores the key with the run, so it works across hours and days.

Use a key that names the thing you are doing (an order ID, a webhook delivery ID), not a random value per attempt.

When the actuator declares [`idempotencyKey`](/docs/reference/sdk/#idempotencykey) fields, a `/run` request without the header gets a key derived from those fields' values. A repeat returns the run that is still running or waiting, or that completed in the last 24 hours, with `200 OK`. An `Idempotency-Key` header you send replaces the derived key. `/webhook` and cron never derive a key, and on the hosted platform neither do runs you start yourself from the dashboard or with `actuate run`. See [key fields](/docs/concepts/mcp-and-openapi/#key-fields).

`actuate run '<json>'` starts a run through the API from the command line.

## Webhook

`POST /webhook` starts a run with the request body as input, exactly like `/run` but with `trigger.kind = "webhook"`, and it honours `Idempotency-Key` too. `actuate deploy` prints the webhook URL.

Point a third-party webhook at it when the sender's JSON body can be your input. Every actuator has a webhook secret (on the platform, in the dashboard's **Connect** tab). A request proves it knows the secret in one of two ways:

- **A signature of the body**, GitHub-style, as `X-Hub-Signature-256: sha256=<HMAC-SHA256 hex>`. This is the preferred way. The secret never travels, and nobody can replay a captured delivery as a new run, because Actuate deduplicates a signed delivery by its signature.
- **The secret itself**, as the `x-actuate-secret` header.

`?secret=` in the URL still works on the platform but is **deprecated**, because URLs end up in proxy, sender and request logs. Responses to it carry `Deprecation: true` and a `Warning` header. If a sender can only be given a URL, check whether it can sign the body instead (GitHub, Stripe-style senders and most webhook tools can), switch, and then rotate the secret.

If the secret leaks, rotate it with **Rotate secret** in the Connect tab, or with `POST /v1/actuators/<name>/webhook-secret` and a full API token. The new secret works at once; the old one stops within 30 seconds. See [Runtime HTTP API](/docs/reference/runtime-http/#webhook) for the self-hosted route.

Provider webhooks are different. They do not start runs. They become [events](/docs/concepts/sleeping-and-waiting/#posting-events) that waiting runs resume on, such as `payment.<referenceId>` for payments and `message.whatsapp.<phone>` for [inbound messages](/docs/concepts/capabilities/#receiving-messages).

The [custom webhook](/docs/guides/custom-webhook/) messaging channel is one of these provider webhooks, not this trigger. It sends messages out to a URL you choose, and replies to its reply URL become `message.custom-webhook.<from>` events. It has its own signing secret, separate from the webhook secret and `ACTUATE_WEBHOOK_SECRET`.

## Cron

```ts
export default defineActuator({
  name: "daily_report",
  description: "Sends yesterday's bookings to the owner every morning.",
  input: z.object({ chatId: z.string().default("123456789") }),
  capabilities: ["messaging"],
  cron: ["0 1 * * *"], // 01:00 UTC
  async run(ctx, input) {
    // ...
  },
});
```

Each firing starts a run with **the input `{}`**, parsed by your input schema. So an actuator with a cron schedule needs an input schema that accepts `{}`. Make the fields optional or give them defaults, and keep settings like recipients in `config`. If the schema rejects `{}`, the firing is skipped and an error is logged.

Cron expressions use the standard five fields. On Cloudflare they run in UTC.

On the platform, the deploy checks your schedules:

- An actuator can have at most 3 schedules on the Sandbox and 5 on other plans.
- The plan's shortest interval (1 hour on the Sandbox, 1 minute otherwise) applies to all of an actuator's schedules **together**. Two hourly schedules offset by 30 minutes fire every 30 minutes, so the Sandbox refuses them.

Each firing is a run, counted like this:

- On the Sandbox, scheduled runs have their own 750 a month, enough for one hourly schedule (at most 744 firings in a 31-day month). After 750, further scheduled runs count against your 1,000 runs. Runs started any other way never use the 750. Once your 1,000 runs are used up, other waiting runs pause until the reset, but runs your schedules started keep going while scheduled runs remain.
- On Maker and Agency, scheduled runs count against runs per month, like every other run.

On every plan, a scheduled run's wake-ups, rows and HTTP requests count against the monthly budgets, and its start against the run rate. When the runs a schedule can use are used up, its firings are skipped until the 1st (UTC). On the Sandbox, the Plan section of Settings shows **Scheduled runs** next to **Runs**. See [plans](/docs/reference/limits/#plans).

Locally, `actuate dev` registers the schedules. To fire one without waiting, call wrangler's test route: `curl 'localhost:8787/__scheduled?cron=0+1+*+*+*'`.

## MCP tool calls

On the platform every actuator is also an MCP tool. The platform validates an agent's tool call against the input schema, and the call starts a run with `trigger.kind = "mcp"` and `trigger.agent` set to the calling token. A retried tool call returns the first call's receipt instead of running twice when it has the same `_meta` idempotency key, the same values in the actuator's [key fields](/docs/concepts/mcp-and-openapi/#key-fields), or, for session-based clients, the same JSON-RPC `id` in the same session. See [idempotent receipts](/docs/concepts/mcp-and-openapi/#idempotent-receipts). Use the streamable HTTP endpoint. The platform caps legacy SSE sessions per account (Sandbox 2, Maker 5, Agency 20 open at once), and refuses a session over the cap with `429`. See [MCP and OpenAPI](/docs/concepts/mcp-and-openapi/).

## Events are not triggers

`POST /events/<key>` does not start a run. It resumes runs that are already [waiting for that event](/docs/concepts/sleeping-and-waiting/#waitforevent), or buffers it for the next wait.
