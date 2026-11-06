---
title: Write efficient actuators
description: What each plan limit counts, the coding patterns that keep runs cheap, how to test an actuator before you deploy it, and a checklist to give your coding agent.
---

Every limit on Actuate is a hard stop, so an actuator that wastes passes or rows doesn't cost you money. It stops working sooner. This page explains what uses each budget, the patterns that keep runs small, and how to check an actuator locally before you deploy it. The [limits reference](/docs/reference/limits/) has the numbers for every plan.

At the end there is a [checklist for your coding agent](#instructions-for-your-coding-agent) that you can paste into `CLAUDE.md`, `AGENTS.md` or a file in `.cursor/rules/`.

## What the limits count

| Budget | What uses it |
| --- | --- |
| Runs | Every run that starts: API, webhook, MCP tool call and cron firing. Each retry, each run in a bulk retry and each **Run again** count too |
| Passes | The first pass of a run and every wake-up after it: when a sleep ends, an event arrives, a person decides, a wait times out or a retry backoff ends. A pass longer than 5 seconds counts one more for every further 5 seconds |
| Rows written | Every row inserted, updated or deleted in your actuator's SQLite database, in your tables and in the run journal, plus every index entry those writes change |
| Rows read | Every row SQLite reads: your queries, the journal each pass loads, and table counts and exports in the dashboard |
| Outbound HTTP | Every `ctx.http` call, including each attempt of a step that retries. Messaging, payment and LLM provider calls don't count |
| Storage | The size of each actuator's SQLite database: your tables, plus the journal of runs that haven't been deleted yet and any buffered events |

Some of these costs come from the runtime, not from your SQL:

- A step writes one journal row when it completes. A step with `retries` above 0 writes its row twice: once before it runs, so a crash still counts the attempt, and once when it finishes.
- The runtime writes the run's own row when the run starts and again at the end of every pass.
- The runtime stores log lines as one row per pass, whatever the number of lines.
- Every pass loads the run's whole journal, one row per step so far, so a long run with many passes reads its journal many times.

### Measured run shapes

These measurements come from the platform's own code, with billed rows counted the way Cloudflare counts them (index writes included):

| Run shape | Passes | Rows written |
| --- | --- | --- |
| A tool call with one step | 1 | 4 |
| Ten steps | 1 | 13 |
| Ten `INSERT` statements in one step | 1 | 14 |
| Ten log lines in one step | 1 | 5 |
| A step, a sleep, then a step | 2 | 9 |
| A step, an event wait, then a step | 2 | 10 |
| One approval | 2 | 9 |

From these, each extra step costs about one row written, each inserted row costs one more (plus one for each index on the table), ten log lines cost one row, and a wait costs a second pass and about five more rows. Rows read are small in all of these, at most a few dozen per run.

### Guards on a single pass

The platform also caps what one pass can do: at most 1,000 database statements (each statement in a `ctx.db.batch` or `commitWithStep` counts), 1,000 step writes, 20,000 rows written, 5,000,000 rows read, 50 HTTP requests, 30 seconds of wall time and 50 ms of CPU. A step's stored result is at most 1 MiB. A run fails after the plan's passes per run (200 on the Sandbox). See [guards on the hosted platform](/docs/reference/limits/#guards-on-the-hosted-platform).

`actuate dev` and `actuate test` apply the same guards, for your plan, with the platform's messages, so a pass that does too much fails locally first. The CPU limit is the exception, because local machines differ too much to mirror it. See [guards in actuate dev](/docs/reference/cli/#guards-in-actuate-dev).

Steps in the same pass run in the same invocation, so splitting a heavy loop into more steps does not give it more CPU. To spread work over several invocations, process a bounded batch per run, or put a short sleep between chunks. Each sleep starts a new pass, which costs a pass.

### Hosted budgets that follow your habits

Three hosted budgets depend on how you work rather than on how many runs you have:

- **Deploys per month.** Every deploy attempt that reaches the platform counts, including one that fails its checks, and a rollback counts as a deploy. See [deploy when it works locally](#deploy-when-it-works-locally).
- **Days an earlier version runs next to the current one.** A run finishes on the version it started on. Each day an earlier version has runs waking counts once against a monthly allowance (see [plans](/docs/reference/limits/#plans)). Deploy several times while runs are waiting and several earlier versions stay in use. A run that waits in one long sleep wakes once; a run that polls every hour wakes every day and keeps its version counted every day. See [runs stay on their version](/docs/guides/retry-and-rollback/#runs-stay-on-their-version).
- **Alert emails per day.** A run that ends `FAILED` sends a [`run_failed` alert](/docs/guides/alerts/) (at most one per actuator per hour), and alert emails are capped per account per day (see [plans](/docs/reference/limits/#plans)). Return a result for outcomes you expect, such as "not found" or "rejected", instead of throwing.

## Patterns that save limits

### Write related rows in one step and one statement

Rows written are counted per row, so batching does not make the rows themselves cheaper. It saves the journal row of every extra step, a statement per row (a pass may run 1,000), and the round trip each statement makes. It also makes the write atomic. A single SQLite statement either applies completely or not at all, while a step that runs several statements and then fails keeps the ones that already ran. When the rows can't go in one statement, run the statements with [`ctx.db.batch`](/docs/concepts/database/#atomic-writes) (all or nothing) or [`ctx.db.commitWithStep`](/docs/concepts/database/#commitwithstep) (all or nothing, committed with the step's result). Both require `@actuate/runtime` 0.3.

Don't write one row per step:

```ts
for (const item of input.items) {
  await ctx.step.do(`save-${item.sku}`, () =>
    ctx.db.sql`INSERT INTO order_items (order_id, sku, qty) VALUES (${input.orderId}, ${item.sku}, ${item.qty})`,
  );
}
```

Do write them in one statement, in one step:

```ts
await ctx.step.do("save-items", () =>
  ctx.db.query(
    `INSERT INTO order_items (order_id, sku, qty)
     SELECT ?, json_extract(value, '$.sku'), json_extract(value, '$.qty') FROM json_each(?)`,
    [input.orderId, JSON.stringify(input.items)],
  ),
);
```

A multi-row `VALUES (?, ?, ?), (?, ?, ?)` works too for a handful of rows. For large batches, `json_each` is better, because the rows go in one parameter, so you don't run into SQLite's limit on the number of `?` placeholders. Bound parameters can total 1 MiB per statement.

Use an upsert instead of a read followed by a write:

```ts
// Don't: a read and a write where one statement does both.
const existing = await ctx.db.first("SELECT 1 FROM contacts WHERE email = ?", [input.email]);
if (existing) await ctx.db.query("UPDATE contacts SET name = ? WHERE email = ?", [input.name, input.email]);
else await ctx.db.query("INSERT INTO contacts (email, name) VALUES (?, ?)", [input.email, input.name]);

// Do: one statement.
await ctx.db.sql`INSERT INTO contacts (email, name) VALUES (${input.email}, ${input.name})
  ON CONFLICT (email) DO UPDATE SET name = excluded.name`;
```

Both belong inside a `ctx.step.do`, like every write.

### Batch work, but give each side effect its own step

One step for a batch of database work or computation is cheaper than one step per item. Side effects outside your database are different. If a step sends ten messages and fails on the sixth, the retry runs the whole step again and the first five are sent twice. Steps are what make a side effect happen once, so give each message, charge or refund its own step:

```ts
// Don't: a retry resends every message.
await ctx.step.do("notify-all", async () => {
  for (const c of customers) await ctx.messaging.send(c.phone, text);
});

// Do: each message is sent once, even when a later one fails.
for (const c of customers) {
  await ctx.step.do(`notify-${c.id}`, () => ctx.messaging.send(c.phone, text));
}
```

The trade-off is one journal row per item. That is the price of exactly-once, and it is worth paying for anything a customer sees or that moves money. For database writes, make the batch safe to repeat instead (one statement, or natural keys with `ON CONFLICT`), and keep it in one step.

Inside a step, `send`, `createBill` and `refund` get an [idempotency key](/docs/concepts/steps-and-replay/#keys-on-provider-calls) for each call automatically. It covers the case where the provider acted but the step was interrupted before its result was stored, at the providers that deduplicate (Stripe, Resend, and Discord with a bot token for a few minutes). Pass your own key only when calls in different steps or runs should count as one.

### Wait for events instead of polling

A sleep loop that checks for something costs a pass and several rows written on every round, and each pass reloads a journal that keeps growing. In a local test, ten rounds of "check, then sleep" took 10 passes and wrote more than 70 rows. An event wait takes 2 passes and about 10 rows, however long it waits.

```ts
// Don't: up to 48 passes and hundreds of rows written for one payment.
for (let i = 0; i < 48; i++) {
  const status = await ctx.step.do(`check-${i}`, async () => (await ctx.payment.getBill(billId)).status);
  if (status === "paid") break;
  await ctx.step.sleep(`wait-${i}`, "30 minutes");
}

// Do: one wait, resumed by the provider's webhook.
const payment = await ctx.step.waitForEvent<PaymentEvent>("payment", {
  event: `payment.${bookingId}`,
  timeout: "1 day",
});
```

- For a person's decision, use `ctx.step.waitForApproval` or `ctx.step.waitForInput`, not a loop that checks a table for an "approved" flag.
- For a point in time, use `ctx.step.sleepUntil`.
- A sleep of three days costs the same as a sleep of one minute: one more pass. Use one long sleep, not a chain of short ones.
- If an outside system has no webhook and you must poll, poll at the longest interval that works, cap the number of rounds, and lengthen the interval as you go.

See [Sleeping and waiting](/docs/concepts/sleeping-and-waiting/).

### Keep passes short

A pass that runs or waits longer than 5 seconds counts one extra pass for every further 5 seconds, because the platform pays for the time it waits. A few long LLM or API calls cost little, but a dependency that hangs on every call uses up the month's passes six times faster than usual (the platform cuts a pass off at 30 seconds).

- Set a timeout on slow calls you control, shorter than 30 seconds, and retry the step instead of waiting longer.
- Don't wait inside a step for something that takes minutes. Start it, then `waitForEvent` for its webhook, or `sleep` and check once.
- Several slow calls in one pass add up their time, whether they are in one step or several.

### Keep step results small

The runtime stores a step's result as JSON in the journal, loads it on every pass of the run, and keeps it until the run is deleted after the plan's retention period. It counts toward your database size, and on the platform it may be at most 1 MiB. Return the values you need, not whole rows, response bodies or LLM replies.

```ts
// Don't: stores every order of the customer, then sums them in code.
const orders = await ctx.step.do("load-orders", () =>
  ctx.db.query("SELECT * FROM orders WHERE customer_id = ?", [input.customerId]),
);

// Do: let SQLite do the work, and store one number.
const total = await ctx.step.do("order-total", async () => {
  const row = await ctx.db.first<{ total: number | null }>(
    "SELECT SUM(amount) AS total FROM orders WHERE customer_id = ?",
    [input.customerId],
  );
  return row?.total ?? 0;
});
```

The same applies to `ctx.http`. Read the response inside the step and return only the fields you use.

### Query with indexes and limits

A query that SQLite answers with an index reads only the rows it needs. Without one it scans the whole table, and every row it scans counts as read. A scan of a 50,000-row table on each of 1,000 runs reads 50,000,000 rows, which is the Sandbox's whole monthly budget.

- Create indexes in `ctx.db.migrate`, next to the table, for the columns you filter and sort on.
- Select the columns you need, not `SELECT *`.
- Put a `LIMIT` on every read of a table that grows.
- Avoid `COUNT(*)` over a large table on every run, because it reads every row it counts. Keep a counter row instead, or count only a bounded range.

```ts
await ctx.db.migrate([
  "CREATE TABLE orders (id TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, total REAL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX orders_email ON orders (email, updated_at)",
]);

const recent = await ctx.step.do("recent-orders", () =>
  ctx.db.query<{ id: string; status: string; total: number }>(
    "SELECT id, status, total FROM orders WHERE email = ? ORDER BY updated_at DESC LIMIT 5",
    [input.email],
  ),
);
```

Indexes also cost rows. Each one adds a row written whenever an insert or update changes it. Index the columns you query by, not every column. A partial index (`CREATE INDEX ... WHERE sent_at IS NULL`) only holds the rows you look for, so it stays small and a query over it skips the rows you are done with. `ctx.db.migrate` tracks migrations by position, so add a new index by appending a statement. See [migrations](/docs/concepts/database/#migrations).

To check a query, see [measuring rows](#measuring-rows).

### Keep cron schedules coarse and cheap

Every cron firing is a run, even when it finds nothing to do. A schedule that fires every minute starts 43,200 runs in a 30-day month, every 15 minutes 2,880, and hourly 720. On the Sandbox (at most one firing an hour), scheduled runs have their own 750 a month, enough for one hourly schedule. With a second one, the extra scheduled runs count against your 1,000 runs. See [how scheduled runs are counted](/docs/concepts/triggers/#cron).

- Use the longest interval that works.
- Make a run with nothing to do return after one cheap, indexed query. It then costs about what a one-step tool call does: one run, one pass and about 4 rows written.
- If each item already has its own run, wait in that run with `sleepUntil` instead of scanning on a schedule.

```ts
export default defineActuator({
  name: "appointment_reminders",
  description: "Sends reminders that are due, every 15 minutes.",
  input: z.object({}),
  capabilities: ["messaging"],
  cron: ["*/15 * * * *"],
  async run(ctx) {
    await ctx.db.migrate([
      "CREATE TABLE reminders (id TEXT PRIMARY KEY, phone TEXT NOT NULL, due_at INTEGER NOT NULL, sent_at INTEGER)",
      "CREATE INDEX reminders_due ON reminders (due_at) WHERE sent_at IS NULL",
    ]);
    const due = await ctx.step.do("find-due", () =>
      ctx.db.query<{ id: string; phone: string }>(
        "SELECT id, phone FROM reminders WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 20",
        [Date.now()],
      ),
    );
    if (due.length === 0) return { sent: 0 };

    for (const r of due) {
      // One step per message, marked sent in the same step, so a failed run never resends it.
      await ctx.step.do(`send-${r.id}`, async () => {
        await ctx.messaging.send(r.phone, "Your appointment is tomorrow.");
        await ctx.db.query("UPDATE reminders SET sent_at = ? WHERE id = ?", [Date.now(), r.id]);
      });
    }
    return { sent: due.length };
  },
});
```

The `LIMIT 20` keeps each run small, and the next run, 15 minutes later, picks up whatever is left. Cron runs get the input `{}`, so the input schema must accept it. See [Cron](/docs/concepts/triggers/#cron).

### Send idempotency keys

Agents and webhook senders retry. Give the call a key that names the action, and a retry returns the first run instead of starting another one:

- Over HTTP, send an `Idempotency-Key` header to `/run` or `/webhook`. See [Idempotency-Key](/docs/concepts/triggers/#idempotency-key).
- Over MCP, put the key in the call's `_meta` as `run.actuate/idempotencyKey`. See [idempotent receipts](/docs/concepts/mcp-and-openapi/#idempotent-receipts).
- Use something stable such as `refund-<orderId>` or the sender's delivery ID, not a random value per attempt.

A duplicate call returns the first run's record and starts no pass. Today, on the hosted platform, it still counts as one run against your runs per month and the run rate (and against an agent's [per-token limits](/docs/concepts/agents/#limits)), because the platform admits the call before the actuator looks up the key. So keys protect you from acting twice, but they don't make retries free.

A key only matches the same key. When separate calls for the same thing can arrive with different keys, or none, check for earlier work in a step before acting:

```ts
const done = await ctx.step.do("find-refund", () =>
  ctx.db.first<{ refund_id: string }>("SELECT refund_id FROM refunds WHERE order_id = ? AND status = 'REFUNDED'", [input.orderId]),
);
if (done) return { status: "ALREADY_REFUNDED" as const, refundId: done.refund_id };
```

### Name steps once

Replay finds a step's stored result by its name. A step renamed in a later version looks new to a run that already completed it under the old name:

- On the platform, a run stays on the version it started on, but [retrying a failed run](/docs/guides/retry-and-rollback/#retry-a-failed-run) moves it to the current version and keeps only the completed steps whose names still match. A renamed step runs again, side effect included.
- In `actuate dev` and a self-hosted runtime, a new build changes the code of every run in flight.

So choose descriptive names from the start (`send-payment-link`, not `step2`), keep them when you refactor, and build loop names from something stable such as the item's ID. The runtime numbers unnamed sleeps in the order the run reaches them (`sleep#1`, `sleep#2`), so give a name to any sleep inside a branch or a loop. See [step names](/docs/concepts/steps-and-replay/#step-names).

### Prune your own tables

The platform deletes settled runs, with their journal and logs, after the plan's retention period. It never deletes rows from your tables. A table that only grows will eventually reach your plan's database size, and queries that scan it get slower and read more.

Delete what you no longer need, in bounded batches. Deleting a row counts as writing it (plus its index entries), and a pass may write at most 20,000 rows:

```ts
// In the actuator's existing daily cron: one more step, not one more schedule.
await ctx.step.do("prune-events", () =>
  ctx.db.query("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE at < ? ORDER BY at LIMIT 5000)", [
    Date.now() - 90 * 86_400_000,
  ]),
);
```

With an index on `at`, the delete reads only the rows it removes. A [self-hosted runtime](/docs/guides/self-hosting/#guards) deletes nothing on its own, so call `manager.pruneRuns` for the journal as well.

### Keep side effects in steps

The runtime replays `run` from the top on every pass. Anything outside a step runs again each time:

- Provider calls (`ctx.messaging`, `ctx.payment`, `ctx.llm`, `ctx.http`), `fetch`, and database writes go inside `ctx.step.do`.
- So do `Date.now()`, `new Date()`, `Math.random()` and `crypto.randomUUID()`. Compute them in a step and use the stored value.
- A database read that decides which branch the run takes goes in a step too, so every replay takes the same branch.
- Never swallow the suspend signal. In a `try`/`catch` around waits, rethrow when `isSuspendSignal(err)` is true.

A write outside a step also costs rows, because it runs again, and writes rows again, on every pass. See [Steps and replay](/docs/concepts/steps-and-replay/).

### Deploy when it works locally

Every deploy attempt that reaches the platform counts against your plan's [monthly deploy budget](/docs/reference/limits/#plans), including attempts the platform refuses. So `actuate deploy` checks what it can before it uploads anything, and stops on errors, which then don't count:

- replay safety (`actuate check`);
- an actuator file that doesn't load, and a bundle over 5 MB;
- cron schedules over the plan's limits, and an input schema that rejects the `{}` every cron run gets (a warning);
- an `http.allow` entry or input regex the platform refuses;
- a capability your plan doesn't include;
- an `actuate.config.json` that isn't valid JSON or that your config schema rejects;
- when you are logged in, also a provider you haven't set up, a new actuator over the plan's number of actuators, and no deploys left this month.

When the deployed version already runs the same code, `deploy` updates only the configuration, which uses no deploy. These checks mirror the platform's. The platform runs its own again on upload, and its result is the one that counts. They need `@actuate/cli` 0.3 or later. Earlier versions only ran `actuate check`. See [the deploy checks](/docs/reference/cli/#the-deploy-checks).

So don't deploy to find out whether something works. Run `actuate check --platform` and `actuate test`, try it with `actuate dev`, and deploy once.

## Test before you deploy

Use the CLI for a quick loop by hand, and `actuate test` with `@actuate/cli/testing` for repeatable tests. Projects created with `npm create actuate` have both, and an example test in `actuator.test.ts`.

### The CLI loop

1. **`npx actuate check --platform`** lints the file for replay safety, then bundles it and runs the platform's [deploy checks](/docs/reference/cli/#the-deploy-checks) for your plan. The linter flags, outside `ctx.step.do`:
   - `fetch()` and `globalThis.fetch()` (error)
   - calls on `ctx.messaging`, `ctx.payment`, `ctx.llm` or `ctx.http` (error)
   - `Date.now()`, `new Date()` with no arguments, `Math.random()`, `crypto.randomUUID()` and `performance.now()` (error)
   - `ctx.db.commitWithStep()` (error)
   - `ctx.db.query`, `ctx.db.first` or `` ctx.db.sql`...` `` whose SQL literal starts with `INSERT`, `UPDATE`, `DELETE` or `REPLACE`, and such statements in a `ctx.db.batch([...])` (warning)

   It exits with status 1 on errors. Until you log in or pass `--plan`, it checks against the Sandbox and reports the plan's own rules (capabilities, cron limits) as warnings. The linter only reads the `run` function in one file. It doesn't follow calls into helpers, and it only sees SQL written as a literal. See [actuate check](/docs/reference/cli/#actuate-check).
2. **`npx actuate dev`** runs the actuator on a local `workerd` with the same step engine and the platform's guards, at `http://localhost:8787`. Messages and approval links print in the terminal, and payments go to a fake provider.
3. **`npx actuate run '{"name":"Aina"}' --local`** starts a run and prints where it got to after its first pass: its status, passes, the rows it wrote and read, its steps, and the command that moves it on if it waits. `--json` prints the run record instead.
4. **`npx actuate logs --local`** lists recent runs with their passes and rows, and **`npx actuate logs <runId> --local`** prints one run's steps, log lines, rows and error.
5. Drive the waits. Post an event with `npx actuate event <key> '{}' --local`, decide an approval with `npx actuate approve <runId> --local` (or `reject`), answer a question with `npx actuate answer <runId> "<text>" --local`, or open an approval link from the terminal. Fire a schedule with `curl 'localhost:8787/__scheduled?cron=<expression>'`.
6. **`npx actuate deploy --dry-run`** runs `check` and the deploy checks, prints `Bundled <name>: <size> KiB, sha256 <hash>` and each problem, and then the metadata a deploy would send: name, description, capabilities, optional capabilities, `httpAllow`, cron schedules, hints, and the input, config and output schemas as JSON Schema. It exits with status 1 when a check fails. It needs no login (when you are logged in, it also runs the checks that need your account), uploads nothing and doesn't count as a deploy.

`actuate dev` applies the platform's per-pass guards, the 1 MiB limit on step results, the SQL the platform refuses, and your plan's longest wait and passes per run, with the platform's messages. `--no-guards` turns them off. It doesn't apply the 50 ms CPU limit or the monthly budgets, so heavy computation in one pass can still be cut short once deployed. See [guards in actuate dev](/docs/reference/cli/#guards-in-actuate-dev).

`npx actuate doctor` checks the rest of your setup in one go: Node, the SDK version, the deploy checks, providers in `.dev.vars`, and your login.

### Unit tests with testActuator

`testActuator` from `@actuate/cli/testing` runs your actuator in-process, with the real step engine on `node:sqlite`, a clock you move, recording fakes for every provider, and the platform's guards. [`actuate test`](/docs/reference/cli/#actuate-test) runs the tests with `node:test` and TypeScript, with no other dependency and no configuration. Both need `@actuate/cli` 0.3 or later, which projects created with `npm create actuate` have as a dev dependency.

Here is an actuator that saves a draft, waits for a person, and sends it:

```ts title="actuator.ts"
import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "approve_message",
  description: "Records a draft, waits for a person to approve it, then sends it.",
  config: z.object({ approver: z.string().default("lead-chat") }),
  input: z.object({ to: z.string().min(1), text: z.string().min(1).max(2000) }),
  capabilities: ["messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate([
      "CREATE TABLE outgoing (run_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL)",
    ]);
    await ctx.step.do("save-draft", () =>
      ctx.db.sql`INSERT INTO outgoing VALUES (${ctx.runId}, ${input.to}, ${input.text}, 'PENDING')`,
    );
    const decision = await ctx.step.waitForApproval("review", {
      message: `Send to ${input.to}: ${input.text}`,
      notify: config.approver,
      timeout: "4 hours",
    });
    if (!decision?.approved) {
      await ctx.step.do("mark-rejected", () => ctx.db.sql`UPDATE outgoing SET status = 'REJECTED' WHERE run_id = ${ctx.runId}`);
      return { status: "REJECTED" };
    }
    const sent = await ctx.step.do("send", () => ctx.messaging.send(input.to, input.text));
    await ctx.step.do("mark-sent", () => ctx.db.sql`UPDATE outgoing SET status = 'SENT' WHERE run_id = ${ctx.runId}`);
    return { status: "SENT", messageId: sent.id };
  },
});
```

Its tests approve through the signed link, let the approval time out and check that its link is then refused, refuse bad input, and check the steps, the message sent, the rows in the table, and the passes and rows written:

```ts title="actuator.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const call = { to: "aina@example.com", text: "Your order has shipped." };

test("sends only after approval", async () => {
  const t = testActuator(actuator);
  const run = await t.start(call);
  assert.equal(run.status, "WAITING");
  assert.equal(t.messages.length, 0);
  assert.equal(t.approvals[0]?.notify, "lead-chat");

  await t.approve("review"); // through the signed link, as a click would

  assert.equal(t.run(run.runId).status, "COMPLETED");
  assert.deepEqual(t.messages.map((m) => m.to), [call.to]);
  assert.deepEqual(t.steps(run.runId).map((s) => s.name), ["save-draft", "review", "send", "mark-sent"]);
  assert.deepEqual(t.rows("outgoing").map((r) => r.status), ["SENT"]);
  // A budget: fails if a change makes this run cost more passes or rows.
  assert.equal(t.usage(run.runId).passes, 2);
  assert.ok(t.usage(run.runId).rowsWritten <= 20);
});

test("sends nothing when the approval times out", async () => {
  const t = testActuator(actuator);
  const run = await t.start(call);
  const link = t.approvals[0]!.approveUrl!; // kept, to click it too late
  await t.advance("4 hours"); // fires the timeout; no real waiting
  assert.deepEqual(t.run(run.runId).output, { status: "REJECTED" });
  assert.equal(t.messages.length, 0);
  assert.deepEqual(await t.followLink(link), { ok: false, reason: "This approval has already been decided or has expired." });
});

test("refuses an empty message before any code runs", async () => {
  const t = testActuator(actuator);
  await assert.rejects(t.start({ to: "aina@example.com", text: "" }), /text/);
});
```

```bash
npx actuate test
```

What the test actuator gives you:

| | |
| --- | --- |
| `t.start(input, { trigger, idempotencyKey })` | Starts a run and returns its record after the first pass. It validates the input with your schema first, as the platform does, and rejects a bad one |
| `t.cron(expression)` | Fires a schedule (by default the first one), which starts a run with the input `{}` |
| `t.advance(duration)`, `t.advanceTo(time)` | Move the clock, firing every sleep, retry and timeout due on the way, in order. `t.now()` reads it |
| `t.approve(step, opts)`, `t.reject(step, opts)` | Decide a `waitForApproval` through its signed link. Without a step, it decides the latest one waiting. `opts`: `runId`, `note`, `by`. Throws, saying what is waiting, when nothing matches |
| `t.answer(text, opts)` | Answer a `waitForInput` through its signed link. `opts`: `step`, `runId`, `by` |
| `t.followLink(url, opts)` | Follow an `approveUrl`, `rejectUrl` or `answerUrl` from `t.approvals` as a person would, and return `{ ok, reason }` instead of throwing, to test that an expired or used link is refused. `opts`: `note`, `text`, `by` |
| `t.event(key, payload)` | Post an event, as `POST /events/:key` does |
| `t.pay(referenceId, payment)` | Pay a bill, by posting `payment.<referenceId>` with a `PaymentEvent` filled in from the bill |
| `t.run(runId)`, `t.steps(runId)`, `t.logs(runId)` | The run record, its journal and its log lines. The record's `output` (here and from `t.start`) is typed as your `run` returns it; `t.run<T>(runId)` picks another type |
| `t.pending()` | Steps waiting for a person, oldest first |
| `t.rows(table)` | Every row of one of your tables |
| `t.query(sql, params)` | SQL straight against the database, not metered, for assertions |
| `t.usage(runId)` | The run's passes, statements, and rows read and written. Without a run ID, the totals of every run. See [measuring rows](#measuring-rows) |
| `t.messages`, `t.bills`, `t.refunds`, `t.prompts`, `t.requests`, `t.approvals` | What the fakes recorded: messages sent, bills created, refunds, LLM requests, HTTP requests, and approval and input requests with their links (each `message` a string, `""` when the step gave none) |
| `t.ownerNotifications` | Messages sent with [`ctx.notifyOwner`](/docs/concepts/actuators/#message-the-owner), each an [`OwnerNotification`](/docs/reference/sdk/#ownernotification) with `text`, `subject`, `runId`, `actuator` and `idempotencyKey`. Each is reported sent |
| `t.close()` | Closes the database, and gives `Date` back once the last open test actuator closes |

`testActuator(actuator, options)` takes:

| Option | |
| --- | --- |
| `config` | The operator configuration, parsed with your config schema, so defaults apply |
| `providers` | Replace a fake with your own provider. Set a capability to `undefined` to test an optional capability with no provider |
| `llm` | Replies for `ctx.llm.complete`, in order, or a function that answers each request. A call with no reply queued fails |
| `http` | Answers `ctx.http.fetch` after the real `http.allow` check. Return a `Response`, or any JSON value for a `200` JSON response. Without it, `ctx.http` calls fail |
| `plan` | `"sandbox"`, `"maker"` or `"agency"`, the plan whose guards apply. The default is `ACTUATE_PLAN` (which `actuate test --plan` sets), or else the Sandbox. `false` turns the guards off |
| `now` | When the clock starts. The default is Monday 5 January 2026, 00:00 UTC |
| `fakeDate` | Make `Date.now()` and `new Date()` follow the clock (default `true`) |
| `logs` | Print run logs to the console (default `false`) |

Unlike `actuate dev` and the runtime, `testActuator` doesn't redact [`secret()`](/docs/reference/sdk/#secret) config values from runs, steps, logs or owner messages, so tests can assert on the real ones. To check that a secret never shows, pass `redactSecrets: true` (`@actuate/cli` 0.4.1 or later). Runs, step results, logs, errors and `t.ownerNotifications` then show `[secret]`, and replays still see the real value.

The fakes record every call and succeed. A message gets an ID, a bill gets a URL and stays `pending` until `t.pay`, and a refund succeeds. Like real providers, the payment fake returns the first bill or refund again for a repeated idempotency key, without recording another. The guards are the ones [`actuate dev`](/docs/reference/cli/#guards-in-actuate-dev) applies. They don't check that your plan includes a capability. `actuate check --platform` does, and `actuate test` reports the deploy checks after the tests.

`t.rows` and `t.query` return plain objects, so `assert.deepEqual` from `node:assert/strict` compares a whole row against an object literal.

Tests that import `vitest` work the same, run with your project's Vitest. You can also run the linter in the same suite:

```ts
import { readFileSync } from "node:fs";
import { checkSource } from "@actuate/cli";

test("passes actuate check", () => {
  assert.deepEqual(checkSource("actuator.ts", readFileSync("actuator.ts", "utf8")), []);
});
```

`testActuator` is built on `RunManager` and `executePass` from `@actuate/runtime`, with `meteredNodeSqlite` as the database, and `t.manager` and `t.db` are its own. To build your own harness or host, you can still drive the engine directly. See [using the engine directly](/docs/guides/self-hosting/#using-the-engine-directly).

### Measuring rows

In tests, `t.usage(runId)` returns a run's passes, statements, and rows read and written, journal included, counted the way Durable Objects bill them. Pin them with an assertion, as in the test above, so a change that makes a run cost more fails the test. How exact they are:

- **Rows written** match Cloudflare's count: rows inserted, updated or deleted, in your tables and in the journal, plus the index entries written. The first run on a fresh database also counts your migrations. A run of the `hello` starter writes 16 rows under `actuate test`, and 16 under `actuate dev`.
- **Rows read** are exact for full table scans. A `SCAN <table>` counts the whole table, as Cloudflare does, even when a `LIMIT` stops it early. For an index search, the count is the rows the statement returned or changed, which is lower than Cloudflare's when the search visits rows that a further condition drops or that feed an aggregate. The `hello` run reads 13 rows under `actuate test` and 20 under `actuate dev`. Full scans are what use up a rows-read budget, and those are counted in full.
- **Passes** are exact.

For Cloudflare's own count, run the actuator under `actuate dev`. `actuate run --local` and `actuate logs --local` show the rows each run wrote and read, from the `workerd` counters the platform bills with.

To see why a query reads many rows, check how SQLite runs it with `EXPLAIN QUERY PLAN` after a run has applied your migrations. `SEARCH ... USING INDEX` reads only the matching rows; `SCAN <table>` reads the whole table:

```ts
const plan = t.query("EXPLAIN QUERY PLAN SELECT status FROM outgoing WHERE run_id = ?", ["run_1"]);
assert.ok(!plan.some((row) => String(row.detail).startsWith("SCAN")));
```

After you deploy, the **Plan** section of **Settings** in the dashboard shows the month's usage for your account: runs, scheduled runs (on the Sandbox), wake-ups, database writes and reads, HTTP requests and storage. The meters cover every actuator and update in batches, so compare them before and after a known number of runs rather than per run.

## Instructions for your coding agent

Paste this into `CLAUDE.md`, `AGENTS.md` or a file in `.cursor/rules/`, so your coding agent follows it when it writes or changes an actuator:

```markdown title="Instructions for your coding agent"
## Writing Actuate actuators

`run` is replayed from the top after every sleep, wait and retry. Completed steps return their stored result.

- Put every side effect inside `ctx.step.do`: calls on `ctx.messaging`, `ctx.payment`, `ctx.llm`, `ctx.http`, any `fetch`, and every INSERT, UPDATE or DELETE.
- Compute `Date.now()`, `new Date()`, `Math.random()` and `crypto.randomUUID()` inside a step. Do database reads that decide a branch inside a step.
- Never swallow the suspend signal: in a `try`/`catch` around waits, rethrow when `isSuspendSignal(err)` is true.
- Give steps descriptive, unique, stable names. Never rename a step that has shipped. In loops, build the name from the item's ID. Name every sleep inside a branch or loop.
- Give each external side effect (message, charge, refund) its own step. Inside a step, `ctx.messaging.send`, `ctx.payment.createBill` and `ctx.payment.refund` get an idempotency key per call automatically (`@actuate/runtime` 0.3); pass your own `idempotencyKey` only to deduplicate across different steps or runs.
- Do database work for many rows in one step and one statement: multi-row INSERT, `INSERT ... SELECT ... FROM json_each(?)`, or `INSERT ... ON CONFLICT DO UPDATE` instead of select-then-write. Make writes safe to repeat.
- When several statements must apply together, use `ctx.db.batch([...])` (all or nothing; a retried step runs it again) or, inside a step, `ctx.db.commitWithStep([...])` (applied once with the step's result; the step can't read those writes). Build each statement with ``ctx.db.statement`...` ``. Both need `@actuate/runtime` 0.3.
- Return small JSON from steps: only the fields you use, never whole tables, response bodies or LLM replies. A step result may be at most 1 MiB.
- Wait with `ctx.step.waitForEvent`, `ctx.step.waitForApproval`, `ctx.step.waitForInput` or `ctx.step.sleepUntil`. Never poll in a loop of short sleeps. Prefer one long sleep to many short ones.
- Keep passes short: a pass over 5 seconds counts one extra pass per further 5 seconds. Put timeouts under 30 seconds on slow calls, and wait for long jobs with `waitForEvent` instead of inside a step.
- Use `retries` only on steps that can fail for a while (network, providers). Throw `NonRetryableError` for errors that won't fix themselves.
- Return a status for expected outcomes (not found, rejected, over a limit) instead of throwing. A failed run sends an alert.
- Create tables and indexes with `ctx.db.migrate` at the top of `run`. Only append to its list; never edit, reorder or remove entries.
- Index the columns you filter and sort on. Select named columns, put LIMIT on reads of growing tables, and don't COUNT(*) a large table on every run.
- Don't use WITH RECURSIVE, self-referencing CTEs, printf, format, randomblob, zeroblob, PRAGMA, ATTACH, DETACH, VACUUM, REINDEX, BEGIN, COMMIT, ROLLBACK or SAVEPOINT, or table names starting with `_actuate_`, `_cf_` or `sqlite_`. The platform refuses them.
- Delete rows you no longer need, in batches of a few thousand, for example in a step of an existing daily cron. The platform never prunes your tables.
- Cron: use the longest interval that works, read due work with one indexed, LIMITed query, and return early when there is none. Cron runs get the input `{}`, so the input schema must accept it.
- Keep a pass under 1,000 statements (each statement in a batch counts), 1,000 steps, 20,000 rows written, 50 `ctx.http` calls and 50 ms of CPU. Process big batches a bounded page per run.
- Tell callers to send an idempotency key that names the action: the `Idempotency-Key` header over HTTP, `_meta["run.actuate/idempotencyKey"]` over MCP.

Before you deploy:

- Run `npx actuate check --platform` and fix every error and warning. It checks replay safety and runs the platform's deploy checks for your plan (`@actuate/cli` 0.3 or later). If it says the plan is only the default, add `--plan` with the plan you deploy on, rather than removing a capability to silence a warning.
- Write tests in `actuator.test.ts` with `testActuator` from `@actuate/cli/testing`: start runs with `t.start`, move the clock with `t.advance`, decide with `t.approve`, `t.reject` or `t.answer`, post events with `t.event`, and assert the run's status, its steps, what the fakes recorded (`t.messages`, `t.bills`), the rows in your tables (`t.rows(table)`), and its passes and rows written (`t.usage(runId)`). To test that an expired or used link is refused, keep it from `t.approvals` and call `t.followLink(url)`. Run them with `npx actuate test`.
- Run the actuator with `npx actuate dev`, start runs with `npx actuate run '<json>' --local`, move waiting runs on with `npx actuate event`, `approve`, `reject` or `answer` (each with `--local`), and read them with `npx actuate logs <runId> --local`. A `[platform guard]` message means the deployed actuator would fail the same way.
- Run `npx actuate deploy --dry-run`. It must exit with status 0. Check that the capabilities, cron schedules and `httpAllow` it prints are what you meant.
- Deploy only when all of that passes. Every deploy attempt counts against the monthly deploy budget, failed ones included.
```
