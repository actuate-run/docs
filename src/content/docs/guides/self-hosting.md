---
title: Self-hosting on workerd
description: Run an actuator on your own Cloudflare account or any workerd host with @actuate/runtime.
---

The step engine is open source. `@actuate/runtime` runs one actuator as a Worker plus a SQLite-backed Durable Object, on Cloudflare or on plain `workerd`, with no Actuate account. It is the same engine `actuate dev` runs, and it is tested end to end on `workerd` in the Actuate repository.

What you get: durable steps, sleeps, events, approvals and questions, cron schedules, the actuator's SQLite database and the [runtime HTTP API](/docs/reference/runtime-http/), behind your own `ACTUATE_TOKEN` and `ACTUATE_RUN_TOKEN`. You bring your own provider adapters.

What you don't get, because it is part of the hosted platform:

- the MCP endpoint, OAuth sign-in for MCP clients, and the OpenAPI document;
- the dashboard, accounts and API tokens, and managed provider setup;
- [alerts](/docs/guides/alerts/): the runtime notifies nobody when a run fails or a wait is about to expire;
- [version pinning, retry and rollback](/docs/guides/retry-and-rollback/): redeploying replaces the code for every run, including runs in flight, and a failed run stays failed (start a new one with the same input instead);
- [agents](/docs/concepts/agents/): runs don't record which token started them (`ctx.trigger.agent` is never set), and there are no per-agent analytics or limits;
- plan quotas and the platform's other [guards](/docs/reference/limits/#guards-on-the-hosted-platform). The runtime's own [guards](#guards) still apply.

## 1. Install

In your actuator project:

```bash
npm install @actuate/sdk @actuate/runtime
npm install -D wrangler
```

## 2. Write the entry point

The runtime wraps your actuator in a Worker and a Durable Object class:

```ts title="entry.ts"
import { createRuntime } from "@actuate/runtime/worker";
import { consoleMessaging } from "@actuate/runtime";
import actuator from "./actuator.js";

const runtime = createRuntime(actuator, { providers: () => ({ messaging: consoleMessaging(() => {}) }) });
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
```

`runtime.worker` routes every request and cron firing to one Durable Object instance, which owns the actuator's SQLite database, journal and alarms. The exported class name must match the binding in the wrangler configuration.

`consoleMessaging(() => {})` is a stand-in that discards messages; replace it with a real adapter (step 5).

## 3. Configure wrangler

```jsonc title="wrangler.jsonc"
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-actuator",
  "main": "entry.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "ACTUATOR", "class_name": "ActuatorObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ActuatorObject"] }],
  "triggers": { "crons": [] },
  "vars": {
    "ACTUATE_CONFIG": "{\"greeting\": \"Hi\"}",
    "ACTUATE_PUBLIC_URL": "https://bot.example.com"
  }
}
```

- The binding must be named `ACTUATOR`.
- `new_sqlite_classes` makes the Durable Object SQLite-backed, which the runtime requires. Keep the migration once you have deployed; add new tagged migrations after it if you ever rename the class.
- Copy the actuator's `cron` schedules into `triggers.crons`. The runtime starts a run with input `{}` for each firing.
- `ACTUATE_CONFIG` is the actuator's configuration as a JSON string.

## 4. Set secrets and deploy

```bash
npx wrangler secret put ACTUATE_TOKEN            # required: your own token for the admin API
npx wrangler secret put ACTUATE_RUN_TOKEN        # the token your agent uses: start and read runs only
npx wrangler secret put ACTUATE_WEBHOOK_SECRET   # required to accept POST /webhook
npx wrangler secret put ACTUATE_APPROVAL_SECRET  # optional: generated if unset
npx wrangler deploy
```

The runtime fails closed: without `ACTUATE_TOKEN` the admin API answers `503`, and without `ACTUATE_WEBHOOK_SECRET` so does `/webhook`. Set `ACTUATE_PUBLIC_URL` (step 3) too, so approval links, payment callbacks and the self-call check use your real origin. Without it, the runtime waits for your first request made with `ACTUATE_TOKEN` to learn the origin, and approval links are relative until then. Don't set `ACTUATE_DEV` in production: it opens routes whose secret is missing, and exists only for `actuate dev`. The full list of variables is in the [runtime HTTP API reference](/docs/reference/runtime-http/#environment-variables).

`npx wrangler dev` runs the same thing locally.

Your agent starts runs with `ACTUATE_RUN_TOKEN`:

```bash
curl -X POST https://bot.example.com/run \
  -H "authorization: Bearer $ACTUATE_RUN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Aina"}'
```

It can also describe the actuator (`GET /`) and read a run (`GET /runs/<runId>`), and nothing else. Keep `ACTUATE_TOKEN` for yourself: it can approve, answer, post events and read tables, so an agent holding it could let its own gated runs through. See [Authentication](/docs/reference/runtime-http/#authentication).

## 5. Providers

The quickest path is the open-source adapters in `@actuate/providers`. They read the same variables as [`actuate dev`](/docs/reference/cli/#actuate-providers) (set them as Worker secrets), and they verify payment webhooks for you:

```ts
import { createRuntime } from "@actuate/runtime/worker";
import { parseProviderWebhookFromEnv, providersFromEnv } from "@actuate/providers";
import actuator from "./actuator";

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => providersFromEnv(env, publicUrl),
  providerWebhook: (kind, request, env) => parseProviderWebhookFromEnv(env, kind, request),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
```

With `ACTUATE_PAYMENT=billplz` (for example), bills carry `https://<your origin>/providers/billplz/webhook` as their callback, and signed callbacks resume the waiting run with a `PaymentEvent`.

You can also write your own. `createRuntime` takes a `providers` function that receives the Worker's environment and the public URL and returns a client for each capability. Anything you return must implement the [SDK provider interfaces](/docs/reference/sdk/#providers). Keep credentials in secrets and read them from `env`.

A minimal hand-written Telegram messaging adapter:

```ts title="entry.ts"
import { createRuntime, type RuntimeEnv } from "@actuate/runtime/worker";
import type { MessagingProvider } from "@actuate/sdk";
import actuator from "./actuator.js";

interface Env extends RuntimeEnv {
  TELEGRAM_BOT_TOKEN: string;
}

function telegram(token: string): MessagingProvider {
  return {
    async send(to, text) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: to, text }),
      });
      const body = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
      if (!body.ok) throw new Error(`Telegram: ${body.description}`);
      return { id: String(body.result?.message_id), channel: "telegram" };
    },
  };
}

const runtime = createRuntime<Env>(actuator, {
  providers: (env) => ({ messaging: telegram(env.TELEGRAM_BOT_TOKEN) }),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
```

How the runtime uses providers:

- The actuator still sees only its declared capabilities, and provider calls must still happen inside `ctx.step.do`.
- A declared capability with no provider throws on first use.
- If the actuator declares `http`, the runtime builds `ctx.http` from `http.allow` for you (HTTPS only, no redirects, never its own public URL) unless you return your own.
- Approval links are sent through `messaging` to the `notify` recipient, or printed to the console when either is missing.
- With `@actuate/providers`, payment webhooks are verified for you; with your own adapters, wire them up as below.

### Provider webhooks

Pass `providerWebhook` to serve `POST /providers/:kind/webhook`. Your function receives the kind from the URL, the request and the environment. Verify the request, then return the event to deliver, or `null` to ignore it. Throw an error named `WebhookVerificationError` to answer `401`.

```ts title="entry.ts"
import { createRuntime, type RuntimeEnv } from "@actuate/runtime/worker";
import type { PaymentEvent } from "@actuate/sdk";
import actuator from "./actuator.js";

interface Env extends RuntimeEnv {
  MYBANK_WEBHOOK_SECRET: string;
}

class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

const runtime = createRuntime<Env>(actuator, {
  providerWebhook: async (kind, request, env) => {
    if (kind !== "mybank") return null;
    // Use your provider's real signature check here.
    if (request.headers.get("x-signature") !== env.MYBANK_WEBHOOK_SECRET) {
      throw new WebhookVerificationError("Bad signature");
    }
    const body = (await request.json()) as { reference: string; state: string; amount: number };
    const payload: PaymentEvent = {
      provider: "mybank",
      status: body.state === "PAID" ? "paid" : "failed",
      referenceId: body.reference,
      amount: body.amount,
    };
    return { event: `payment.${body.reference}`, payload: { ...payload } };
  },
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
```

Point the provider at `https://<your origin>/providers/mybank/webhook`. Payment webhooks should deliver `payment.<referenceId>` with a [`PaymentEvent`](/docs/reference/sdk/#paymentevent) payload, so actuators written for the platform work unchanged.

### Configuration

`createRuntime` also takes `config: (env) => unknown` if you want to build the configuration from something other than `ACTUATE_CONFIG`.

## Using the engine directly

The engine also runs in-process, for example on `node:sqlite`, for building your own host or test harness. To test an actuator, use [`testActuator`](/docs/guides/best-practices/#unit-tests-with-testactuator) from `@actuate/cli/testing`, which is built on this and adds a clock, fake providers, the platform's guards and a rows meter. `RunManager` drives runs, and `executePass` executes your actuator:

```ts title="actuator.test.ts"
import { DatabaseSync } from "node:sqlite";
import { RunManager, consoleMessaging, executePass, fakePayment, nodeSqlite } from "@actuate/runtime";
import actuator from "./actuator.js";

let now = Date.parse("2026-11-02T00:00:00Z");
const config = actuator.config!.parse({});
const manager = new RunManager({
  sql: nodeSqlite(new DatabaseSync(":memory:")),
  approvalSecret: "test-secret",
  approvalUrl: "https://example.test/approve",
  now: () => now,
  invoke: (request, journal) =>
    executePass(actuator, request, {
      journal,
      config,
      providers: { messaging: consoleMessaging(), payment: fakePayment() },
    }),
});

const { run } = await manager.start({
  input: { customerName: "Aina", phone: "+60123456789", appointmentIso: "2026-11-05T09:00:00Z" },
  trigger: { kind: "api" },
});

// Move the clock forward and fire the alarm.
now += 2 * 3_600_000;
await manager.alarm();
console.log(manager.getRun(run.runId)?.status, manager.getSteps(run.runId));
```

`consoleMessaging()` prints messages and `fakePayment()` creates bills that are paid by posting `payment.<referenceId>` (and refunds that always succeed), the same stand-ins `actuate dev` uses. `deliverEvent(key, payload)`, `decide(token)`, `pendingApprovals()`, `listTables()` and `readTable(name)` cover the rest of the lifecycle. `manager.start` does not validate input; parse it with `actuator.input` first if you want that check in tests.

### Guards

`RunManager` takes options that bound what a run can cost. Pass them to `createRuntime` as `guards: { ... }`, or to `RunManager` when you build your own host.

| Option | Default | Effect |
| --- | --- | --- |
| `passLimits.maxWaitMs` | none | Longest sleep or wait. A sleep, or a wait with an explicit `timeout` or `until`, longer than this fails the run with an `ActuatorError`. A wait with no timeout gets this limit and then resolves to `null` |
| `passLimits.maxRetries` | `10` | Retries a step may ask for. Larger `retries` values are clamped to it |
| `admitPass(runId)` | none | Called before every pass. Return a time (epoch ms) to defer the pass until then; the run stays `WAITING` and nothing is lost. Return `null` to run now. Use it for budgets |
| `maxBufferedEvents` | `1000` | Events buffered while nobody waits for them. Beyond this, the oldest are dropped |
| `maxEventBytes` | `65536` | Largest event payload, in bytes of JSON. Larger events are refused |
| `maxPasses` | `10000` | Passes per run before the run fails |
| `maxLogLinesPerPass` | `100` | Log lines kept per pass |
| `eventBufferTtlMs` | 7 days | Buffered events older than this are deleted when the alarm runs |

Two helpers in `@actuate/runtime` 0.3 and later bring your own host closer to the hosted platform:

- `checkActuatorSql(sql, params)` throws, with the platform's message, for a statement the hosted platform [refuses](/docs/concepts/database/#what-the-platform-refuses): recursive queries (including self-referencing CTEs), `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM` and `REINDEX`, `printf`, `format`, `randomblob`, `zeroblob` and the file functions, tables starting with `_actuate_`, `_cf_` or `sqlite_`, and more than 1 MiB of bound parameters. The runtime doesn't call it for you: on its own it refuses only tables starting with `_actuate_`, and transaction control inside `ctx.db.batch` and `commitWithStep`. Call it where your host passes SQL on, if you want the platform's rules.
- `meteredNodeSqlite(db, { onStatement })` is `nodeSqlite` with a meter of the rows Durable Objects would bill. Its `meter` holds the totals (`statements`, `rowsRead`, `rowsWritten`), and `onStatement` receives each statement's SQL, parameters and cost, for example to count rows per run. Rows written match Cloudflare's count; rows read are exact for full table scans and an estimate on the low side for index searches. On a Durable Object, `durableObjectSql(storage, meter)` fills a meter from Cloudflare's own counters instead.

`manager.pruneRuns(before, limit = 500)` deletes settled runs (`COMPLETED`, `FAILED`, `CANCELLED`) last updated before `before` (epoch ms), with their steps and logs, and returns how many it removed. Your tables are never touched. Call it on a schedule to keep the journal small.

## Backups

Your data is in the Durable Object's SQLite storage on your account. Read it through `GET /tables/:name?format=csv`, or use your platform's backup tooling for Durable Objects.
