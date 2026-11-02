---
title: Self-hosting on workerd
description: Run an actuator on your own Cloudflare account or any workerd host with @actuate/runtime.
---

The step engine is open source. `@actuate/runtime` runs one actuator as a Worker plus a SQLite-backed Durable Object, on Cloudflare or on plain `workerd`, with no Actuate account. It is the same engine `actuate dev` runs, and it is tested end to end on `workerd` in the Actuate repository.

What you get: durable steps, sleeps, events, approvals, the actuator's SQLite database and the [runtime HTTP API](/docs/reference/runtime-http/). What you don't: the hosted MCP endpoint and OpenAPI document, the dashboard, managed provider setup and quotas. You bring your own provider adapters.

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
npx wrangler secret put ACTUATE_TOKEN            # bearer token for the admin API
npx wrangler secret put ACTUATE_WEBHOOK_SECRET   # if you use POST /webhook
npx wrangler secret put ACTUATE_APPROVAL_SECRET  # optional: generated if unset
npx wrangler deploy
```

**Always set `ACTUATE_TOKEN` in production.** Without it, anyone who knows the URL can start runs, post events and read your tables. The full list of variables is in the [runtime HTTP API reference](/docs/reference/runtime-http/#environment-variables).

`npx wrangler dev` runs the same thing locally.

```bash
curl -X POST https://bot.example.com/run \
  -H "authorization: Bearer $ACTUATE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Aina"}'
```

## 5. Providers

`createRuntime` takes a `providers` function that receives the Worker's environment and the public URL and returns a client for each capability. Anything you return must implement the [SDK provider interfaces](/docs/reference/sdk/#providers). Keep credentials in secrets and read them from `env`.

A minimal Telegram messaging adapter:

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
- Payment providers are yours to wire up. For the payment webhook, add a small route in your Worker, in front of `runtime.worker`, that verifies the provider's signature and posts the event `payment.<referenceId>` to `POST /events/:key`.

`createRuntime` also takes `config: (env) => unknown` if you want to build the configuration from something other than `ACTUATE_CONFIG`.

## Testing in Node

The engine also runs in-process on `node:sqlite`, which is handy for unit tests. `RunManager` drives runs, and `executePass` executes your actuator:

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

`consoleMessaging()` prints messages and `fakePayment()` creates bills that are paid by posting `payment.<referenceId>`, the same stand-ins `actuate dev` uses. `deliverEvent(key, payload)`, `decide(token)`, `pendingApprovals()`, `listTables()` and `readTable(name)` cover the rest of the lifecycle. `manager.start` does not validate input; parse it with `actuator.input` first if you want that check in tests.

## Backups

Your data is in the Durable Object's SQLite storage on your account. Read it through `GET /tables/:name?format=csv`, or use your platform's backup tooling for Durable Objects.
