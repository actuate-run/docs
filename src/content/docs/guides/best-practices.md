---
title: Write efficient actuators
description: What each plan limit counts, the coding patterns that keep runs cheap, how to test an actuator before you deploy it, and a checklist to give your coding agent.
---

Every limit on Actuate is a hard stop, so an actuator that wastes passes or rows doesn't cost you money: it stops working sooner. This page explains what uses each budget, the patterns that keep runs small, and how to check an actuator locally before you deploy it. The [limits reference](/docs/reference/limits/) has the numbers for every plan.

At the end there is a [checklist for your coding agent](#instructions-for-your-coding-agent) that you can paste into `CLAUDE.md`, `AGENTS.md` or a file in `.cursor/rules/`.

## What the limits count

| Budget | What uses it |
| --- | --- |
| Runs | Every run that starts: API, webhook, MCP tool call and cron firing. Each retry, each run in a bulk retry and each **Run again** count too |
| Passes | The first pass of a run and every wake-up after it: when a sleep ends, an event arrives, a person decides, a wait times out or a retry backoff ends |
| Rows written | Every row inserted, updated or deleted in your actuator's SQLite database, in your tables and in the run journal, plus every index entry those writes change |
| Rows read | Every row SQLite reads: your queries, the journal each pass loads, and table counts and exports in the dashboard |
| Outbound HTTP | Every `ctx.http` call, including each attempt of a step that retries. Messaging, payment and LLM provider calls don't count |
| Storage | The size of each actuator's SQLite database: your tables, plus the journal of runs that haven't been deleted yet and any buffered events |

Some of these costs come from the runtime, not from your SQL:

- A step writes one journal row when it completes. A step with `retries` above 0 writes its row twice: once before it runs, so a crash still counts the attempt, and once when it finishes.
- The run's own row is written when the run starts and again at the end of every pass.
- Log lines are stored as one row per pass, whatever the number of lines.
- Every pass loads the run's whole journal, one row per step so far, so a long run with many passes reads its journal many times.

### Measured run shapes

These are measured on the platform's own code, with billed rows counted the way Cloudflare counts them (index writes included):

| Run shape | Passes | Rows written |
| --- | --- | --- |
| A tool call with one step | 1 | 4 |
| Ten steps | 1 | 13 |
| Ten `INSERT` statements in one step | 1 | 14 |
| Ten log lines in one step | 1 | 5 |
| A step, a sleep, then a step | 2 | 9 |
| A step, an event wait, then a step | 2 | 10 |
| One approval | 2 | 9 |

What follows from them: each extra step costs about one row written, each inserted row costs one more (plus one for each index on the table), ten log lines cost one row, and a wait costs a second pass and about five more rows. Rows read are small in all of these: a few dozen at most per run.

### Guards on a single pass

The platform also caps what one pass can do: at most 1,000 database statements, 1,000 step writes, 20,000 rows written, 5,000,000 rows read, 50 HTTP requests, 30 seconds of wall time and 50 ms of CPU. A step's stored result is at most 1 MiB. A run fails after the plan's passes per run (200 on the Sandbox). See [guards on the hosted platform](/docs/reference/limits/#guards-on-the-hosted-platform).

Steps in the same pass run in the same invocation, so splitting a heavy loop into more steps does not give it more CPU. To spread work over several invocations, process a bounded batch per run, or put a short sleep between chunks: each sleep starts a new pass, which costs a pass.

### Hosted budgets that follow your habits

Three hosted budgets depend on how you work rather than on how many runs you have:

- **Deploys per month.** Every deploy attempt that reaches the platform counts, including one that fails its checks, and a rollback counts as a deploy. See [deploy when it works locally](#deploy-when-it-works-locally).
- **Days an earlier version runs next to the current one.** A run finishes on the version it started on. Each day an earlier version has runs waking counts once against a monthly allowance (see [plans](/docs/reference/limits/#plans)). Deploy several times while runs are waiting and several earlier versions stay in use. A run that waits in one long sleep wakes once; a run that polls every hour wakes every day and keeps its version counted every day. See [runs stay on their version](/docs/guides/retry-and-rollback/#runs-stay-on-their-version).
- **Alert emails per day.** A run that ends `FAILED` sends a [`run_failed` alert](/docs/guides/alerts/) (at most one per actuator per hour), and alert emails are capped per account per day (see [plans](/docs/reference/limits/#plans)). Return a result for outcomes you expect, such as "not found" or "rejected", instead of throwing.

## Patterns that save limits

### Write related rows in one step and one statement

Rows written are counted per row, so batching does not make the rows themselves cheaper. It saves the journal row of every extra step, a statement per row (a pass may run 1,000), and the round trip each statement makes. It also makes the write atomic: a single SQLite statement either applies completely or not at all, while a step that runs several statements and then fails keeps the ones that already ran.

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

A multi-row `VALUES (?, ?, ?), (?, ?, ?)` works too for a handful of rows. For large batches, `json_each` is better: the rows travel as one parameter, so you don't run into SQLite's limit on the number of `?` placeholders. Bound parameters can total 1 MiB per statement.

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
  await ctx.step.do(`notify-${c.id}`, ({ idempotencyKey }) => ctx.messaging.send(c.phone, text, { idempotencyKey }));
}
```

The trade-off is one journal row per item. That is the price of exactly-once, and it is worth paying for anything a customer sees or that moves money. For database writes, make the batch safe to repeat instead (one statement, or natural keys with `ON CONFLICT`), and keep it in one step.

Pass the step's `idempotencyKey` to every provider call that accepts one. It covers the case where the provider acted but the step was interrupted before its result was stored.

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

### Keep step results small

A step's result is stored as JSON in the journal, loaded on every pass of the run, and kept until the run is deleted after the plan's retention period. It counts toward your database size, and on the platform it may be at most 1 MiB. Return the values you need, not whole rows, response bodies or LLM replies.

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

The same goes for `ctx.http`: read the response inside the step and return only the fields you use.

### Query with indexes and limits

A query that SQLite answers with an index reads only the rows it needs. Without one it scans the whole table, and every row it scans counts as read. A scan of a 50,000-row table on each of 1,000 runs reads 50,000,000 rows, which is the Sandbox's whole monthly budget.

- Create indexes in `ctx.db.migrate`, next to the table, for the columns you filter and sort on.
- Select the columns you need, not `SELECT *`.
- Put a `LIMIT` on every read of a table that grows.
- Avoid `COUNT(*)` over a large table on every run; it reads every row it counts. Keep a counter row instead, or count only a bounded range.

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

Indexes are not free either: each one adds a row written whenever an insert or update changes it. Index the columns you query by, not every column. A partial index (`CREATE INDEX ... WHERE sent_at IS NULL`) only holds the rows you look for, so it stays small and a query over it skips the rows you are done with. Migrations are tracked by position, so add a new index by appending a statement; see [migrations](/docs/concepts/database/#migrations).

To check a query, see [measuring rows](#measuring-rows).

### Keep cron schedules coarse and cheap

Every cron firing is a run, even when it finds nothing to do. A schedule that fires every minute starts 43,200 runs in a 30-day month, every 15 minutes 2,880, and hourly 720. On the Sandbox (1,000 runs a month, at most one firing an hour) an hourly schedule uses most of the month's runs by itself.

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
      await ctx.step.do(`send-${r.id}`, async ({ idempotencyKey }) => {
        await ctx.messaging.send(r.phone, "Your appointment is tomorrow.", { idempotencyKey });
        await ctx.db.query("UPDATE reminders SET sent_at = ? WHERE id = ?", [Date.now(), r.id]);
      });
    }
    return { sent: due.length };
  },
});
```

The `LIMIT 20` keeps each run small; whatever is left is picked up 15 minutes later. Cron runs get the input `{}`, so the input schema must accept it. See [Cron](/docs/concepts/triggers/#cron).

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

So choose descriptive names from the start (`send-payment-link`, not `step2`), keep them when you refactor, and build loop names from something stable such as the item's ID. Unnamed sleeps are numbered in the order the run reaches them (`sleep#1`, `sleep#2`), so give a name to any sleep inside a branch or a loop. See [step names](/docs/concepts/steps-and-replay/#step-names).

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

With an index on `at`, the delete reads only the rows it removes. A [self-hosted runtime](/docs/guides/self-hosting/#guards) deletes nothing on its own: call `manager.pruneRuns` for the journal as well.

### Keep side effects in steps

`run` is replayed from the top on every pass. Anything outside a step runs again each time:

- Provider calls (`ctx.messaging`, `ctx.payment`, `ctx.llm`, `ctx.http`), `fetch`, and database writes go inside `ctx.step.do`.
- So do `Date.now()`, `new Date()`, `Math.random()` and `crypto.randomUUID()`: compute them in a step and use the stored value.
- A database read that decides which branch the run takes goes in a step too, so every replay takes the same branch.
- Never swallow the suspend signal. In a `try`/`catch` around waits, rethrow when `isSuspendSignal(err)` is true.

A write outside a step is also a cost: it runs again, and writes rows again, on every pass. See [Steps and replay](/docs/concepts/steps-and-replay/).

### Deploy when it works locally

Every deploy attempt that reaches the platform counts against your plan's [monthly deploy budget](/docs/reference/limits/#plans), including attempts the platform refuses. `actuate deploy` runs `actuate check` first and stops on errors before it uploads anything, so those don't count. Everything after the upload does: a bundle that fails to load, a cron schedule over the plan's limits, an `http.allow` entry or input regex the platform refuses, a capability your plan doesn't include, a provider you haven't set up, or a configuration your schema rejects.

So don't deploy to find out whether something works. Run it with `actuate dev`, test it, look at `actuate deploy --dry-run`, and deploy once.

## Test before you deploy

There is no `actuate test` command. Use the CLI for a quick loop by hand, and a test runner such as Vitest with `@actuate/runtime` for repeatable tests.

### The CLI loop

1. **`npx actuate check`** lints the file for replay safety. It flags, outside `ctx.step.do`:
   - `fetch()` and `globalThis.fetch()` (error)
   - calls on `ctx.messaging`, `ctx.payment`, `ctx.llm` or `ctx.http` (error)
   - `Date.now()`, `new Date()` with no arguments, `Math.random()`, `crypto.randomUUID()` and `performance.now()` (error)
   - `ctx.db.query`, `ctx.db.first` or `` ctx.db.sql`...` `` whose SQL literal starts with `INSERT`, `UPDATE`, `DELETE` or `REPLACE` (warning)

   It exits with status 1 on errors. It only reads the `run` function in one file: it doesn't follow calls into helpers, and it only sees SQL written as a literal. See [actuate check](/docs/reference/cli/#actuate-check).
2. **`npx actuate dev`** runs the actuator on a local `workerd` with the same step engine, at `http://localhost:8787`. Messages and approval links print in the terminal, and payments go to a fake provider.
3. **`npx actuate run '{"name":"Aina"}' --local`** starts a run and prints the run record after its first pass, including `status` and `passes`.
4. **`npx actuate logs --local`** lists recent runs, and **`npx actuate logs <runId> --local`** prints one run's steps, log lines and error. The number of steps is the number of journal rows the run wrote.
5. Drive the waits: post an event with `curl -X POST localhost:8787/events/<key> -d '{}'`, open an approval link from the terminal, or fire a schedule with `curl 'localhost:8787/__scheduled?cron=<expression>'`.
6. **`npx actuate deploy --dry-run`** runs `check`, bundles the file, prints `Bundled <name>: <size> KiB, sha256 <hash>`, and then the metadata a deploy would send: name, description, capabilities, optional capabilities, `httpAllow`, cron schedules, hints, and the input, config and output schemas as JSON Schema. It needs no login, uploads nothing and doesn't count as a deploy. It doesn't run the platform's checks either, so read the output: are the capabilities on your plan, are the cron schedules within its limits, is `http.allow` what you meant?

`actuate dev` doesn't enforce the platform's guards: no per-pass caps, no 1 MiB limit on step results, no SQL refusals, no plan limit on waits and no budgets. Code that works locally can still hit them, which is what tests are for.

### Unit tests with the engine

The engine runs in-process on `node:sqlite` (Node.js 22.13 or later runs it without a flag), the same way the [templates](/docs/guides/templates/) test themselves. `RunManager` drives runs and `executePass` runs your actuator, with a clock you control and fake providers. Install the runtime at the same version as `@actuate/sdk`:

```bash
npm install -D vitest @actuate/runtime
```

Add `"test": "vitest run"` to `package.json`. Here is an actuator that saves a draft, waits for a person, and sends it:

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

And its tests: approve through the signed link, let the approval time out, and check the steps, the passes, the rows in the table and the rows written:

```ts title="actuator.test.ts"
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RunManager, executePass, nodeSqlite, type ApprovalRequest } from "@actuate/runtime";
import actuator from "./actuator.js";

function setup() {
  let now = Date.parse("2026-11-02T00:00:00Z");
  const db = new DatabaseSync(":memory:");
  const sent: Array<{ to: string; text: string }> = [];
  const approvals: ApprovalRequest[] = [];
  const config = actuator.config!.parse({});
  const manager = new RunManager({
    sql: nodeSqlite(db),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    notifyApproval: async (request) => void approvals.push(request),
    invoke: (request, journal) =>
      executePass(actuator, request, {
        journal,
        config,
        providers: {
          messaging: {
            async send(to, text) {
              sent.push({ to, text });
              return { id: `msg-${sent.length}`, channel: "test" };
            },
          },
        },
      }),
  });
  return {
    db,
    manager,
    sent,
    approvals,
    // manager.start doesn't validate input; parse it as the platform does.
    start: (input: unknown) => manager.start({ input: actuator.input.parse(input), trigger: { kind: "api" } }),
    // Move the clock forward and fire the alarm, as the Durable Object would.
    advance: async (ms: number) => {
      now += ms;
      await manager.alarm();
    },
    // Rows inserted, updated or deleted on this connection so far.
    changes: () => Number(db.prepare("SELECT total_changes() AS n").get()!.n),
  };
}

const token = (url: string) => new URL(url).searchParams.get("token")!;
const call = { to: "aina@example.com", text: "Your order has shipped." };

describe("approve_message", () => {
  it("sends only after approval", async () => {
    const t = setup();
    const before = t.changes();

    const { run } = await t.start(call);
    expect(run.status).toBe("WAITING");
    expect(t.sent).toHaveLength(0);

    await t.manager.decide(token(t.approvals[0]!.approveUrl!));

    const done = t.manager.getRun(run.runId)!;
    expect(done.status).toBe("COMPLETED");
    expect(done.passes).toBe(2);
    expect(t.sent).toEqual([call]);
    expect(t.manager.getSteps(run.runId).map((s) => s.name)).toEqual(["save-draft", "review", "send", "mark-sent"]);
    expect(t.manager.readTable("outgoing").rows).toEqual([expect.objectContaining({ status: "SENT" })]);
    // A budget: fails if a change makes this run write more rows.
    expect(t.changes() - before).toBeLessThanOrEqual(12);
  });

  it("sends nothing when the approval times out", async () => {
    const t = setup();
    const { run } = await t.start(call);
    await t.advance(4 * 3_600_000);
    expect(t.manager.getRun(run.runId)!.output).toEqual({ status: "REJECTED" });
    expect(t.sent).toHaveLength(0);
  });
});
```

The rest of the lifecycle is on the same `RunManager`: `deliverEvent(key, payload)` resolves a `waitForEvent` (and pays a bill, with the key `payment.<referenceId>`), `decide(token, { note })` approves with a note or `decide(token, { text })` answers a `waitForInput`, `advance` fires sleeps, retries and timeouts, and `getLogs(runId)` returns the log lines. `consoleMessaging()` and `fakePayment()` from `@actuate/runtime` are ready-made stand-ins if you don't need to record calls.

You can run the linter in the same suite, as the templates do:

```ts
import { readFileSync } from "node:fs";
import { checkSource } from "@actuate/cli";

it("passes actuate check", () => {
  expect(checkSource("actuator.ts", readFileSync("actuator.ts", "utf8"))).toEqual([]);
});
```

### Measuring rows

The runtime has a meter, `newSqlMeter()`, but it only works with Durable Object storage (`durableObjectSql`), which is what the platform uses to bill. `nodeSqlite` has no meter, so in tests you estimate:

- **Rows written.** SQLite's `total_changes()` counts rows inserted, updated and deleted on the connection, journal included, as in the test above. Take the difference across a run, and pin it with an assertion so a change that adds writes fails the test. The platform's count is a little higher: it also counts every index entry written, and it records the version each run started on. The first run on a fresh database also records your migrations.
- **Rows read.** There is no counter in `node:sqlite`. Check how SQLite runs each query with `EXPLAIN QUERY PLAN` after a run has applied your migrations. `SEARCH ... USING INDEX` reads only the matching rows; `SCAN <table>` reads the whole table:

  ```ts
  const plan = t.db.prepare("EXPLAIN QUERY PLAN SELECT status FROM outgoing WHERE run_id = ?").all("run_1");
  expect(plan.map((row) => String(row.detail))).not.toContainEqual(expect.stringMatching(/^SCAN/));
  ```

  Add to that the journal each pass loads: one row per step the run has so far.
- **Passes.** The run record's `passes` field, in tests and in the output of `actuate run`.

After you deploy, **Settings → Plan** in the dashboard shows the month's usage for your account: runs, wake-ups, database writes and reads, HTTP requests and storage. The meters cover every actuator and update in batches, so compare them before and after a known number of runs rather than per run.

## Instructions for your coding agent

Paste this into `CLAUDE.md`, `AGENTS.md` or a file in `.cursor/rules/`, so your coding agent follows it when it writes or changes an actuator:

```markdown title="Instructions for your coding agent"
## Writing Actuate actuators

`run` is replayed from the top after every sleep, wait and retry. Completed steps return their stored result.

- Put every side effect inside `ctx.step.do`: calls on `ctx.messaging`, `ctx.payment`, `ctx.llm`, `ctx.http`, any `fetch`, and every INSERT, UPDATE or DELETE.
- Compute `Date.now()`, `new Date()`, `Math.random()` and `crypto.randomUUID()` inside a step. Do database reads that decide a branch inside a step.
- Never swallow the suspend signal: in a `try`/`catch` around waits, rethrow when `isSuspendSignal(err)` is true.
- Give steps descriptive, unique, stable names. Never rename a step that has shipped. In loops, build the name from the item's ID. Name every sleep inside a branch or loop.
- Give each external side effect (message, charge, refund) its own step, and pass the step's `idempotencyKey` to the provider.
- Do database work for many rows in one step and one statement: multi-row INSERT, `INSERT ... SELECT ... FROM json_each(?)`, or `INSERT ... ON CONFLICT DO UPDATE` instead of select-then-write. Make writes safe to repeat.
- Return small JSON from steps: only the fields you use, never whole tables, response bodies or LLM replies. A step result may be at most 1 MiB.
- Wait with `ctx.step.waitForEvent`, `ctx.step.waitForApproval`, `ctx.step.waitForInput` or `ctx.step.sleepUntil`. Never poll in a loop of short sleeps. Prefer one long sleep to many short ones.
- Use `retries` only on steps that can fail for a while (network, providers). Throw `NonRetryableError` for errors that won't fix themselves.
- Return a status for expected outcomes (not found, rejected, over a limit) instead of throwing. A failed run sends an alert.
- Create tables and indexes with `ctx.db.migrate` at the top of `run`. Only append to its list; never edit, reorder or remove entries.
- Index the columns you filter and sort on. Select named columns, put LIMIT on reads of growing tables, and don't COUNT(*) a large table on every run.
- Don't use WITH RECURSIVE, self-referencing CTEs, printf, format, randomblob, zeroblob, PRAGMA, ATTACH, DETACH, VACUUM or REINDEX, or table names starting with `_actuate_`, `_cf_` or `sqlite_`. The platform refuses them.
- Delete rows you no longer need, in batches of a few thousand, for example in a step of an existing daily cron. The platform never prunes your tables.
- Cron: use the longest interval that works, read due work with one indexed, LIMITed query, and return early when there is none. Cron runs get the input `{}`, so the input schema must accept it.
- Keep a pass under 1,000 statements, 1,000 steps, 20,000 rows written, 50 `ctx.http` calls and 50 ms of CPU. Process big batches a bounded page per run.
- Tell callers to send an idempotency key that names the action: the `Idempotency-Key` header over HTTP, `_meta["run.actuate/idempotencyKey"]` over MCP.

Before you deploy:

- Run `npx actuate check` and fix every error and warning.
- Run the actuator with `npx actuate dev`, start runs with `npx actuate run '<json>' --local`, and read them with `npx actuate logs <runId> --local`.
- Write Vitest tests with `RunManager`, `executePass` and `nodeSqlite` from `@actuate/runtime` on `node:sqlite`: start runs, drive sleeps and approvals with a fake clock, and assert the steps, `passes`, table rows and `total_changes()`. There is no `actuate test` command.
- Run `npx actuate deploy --dry-run` and check the capabilities, cron schedules and `httpAllow` it prints.
- Deploy only when all of that passes. Every deploy attempt counts against the monthly deploy budget, failed ones included.
```
