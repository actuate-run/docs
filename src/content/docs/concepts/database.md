---
title: Database
description: Each actuator has its own SQLite database, queried with parameterised SQL and migrated with ctx.db.migrate.
---

Every actuator has its own SQLite database, shared by all of its runs. It lives next to the run journal in the actuator's Durable Object, so queries are local and fast.

`ctx.db` exposes only parameterised statements. There is deliberately no string-interpolated `exec`, so user input can never become SQL.

## Querying

```ts
// ? placeholders
const rows = await ctx.db.query<{ id: string; status: string }>(
  "SELECT id, status FROM bookings WHERE phone = ?",
  [input.phone],
);

// First row or null
const booking = await ctx.db.first<{ status: string }>("SELECT status FROM bookings WHERE id = ?", [id]);

// Tagged template: interpolated values become bound parameters, never SQL
const pending = await ctx.db.sql<{ id: string }>`SELECT id FROM bookings WHERE status = ${"PENDING"}`;
```

| Method | Returns |
| --- | --- |
| `query(sql, params?)` | All rows, as objects keyed by column name |
| `first(sql, params?)` | The first row, or `null` |
| `` sql`...` `` | All rows. Each `${value}` becomes a `?` parameter |
| `` statement`...` `` | A statement for `batch` or `commitWithStep`, built like `sql` but not run |
| `batch(statements)` | Runs several statements all or nothing and returns each one's rows. See [Atomic writes](#atomic-writes) |
| `commitWithStep(statements)` | Queues writes that commit with the current step. See [Atomic writes](#atomic-writes) |
| `migrate(statements)` | Applies new schema migrations |

Parameters can be strings, numbers, bigints, booleans (stored as `1` and `0`), `null`, `Uint8Array` or `ArrayBuffer`. The type argument (`query<T>`) types the rows, but nothing checks it at runtime.

Because `sql` binds every interpolated value, you cannot interpolate identifiers such as table or column names. Write those in the SQL text.

## Writes belong in steps

The runtime [replays](/docs/concepts/steps-and-replay/) `run` from the top after every pause, so a write outside a step runs again on every pass. Put inserts, updates and deletes inside `ctx.step.do`:

```ts
await ctx.step.do("save-booking", () =>
  ctx.db.sql`INSERT INTO bookings (id, name, status) VALUES (${ctx.runId}, ${input.customerName}, 'PENDING')`,
);
```

`actuate check` warns about literal `INSERT`, `UPDATE`, `DELETE` and `REPLACE` statements outside a step.

Reads outside a step are fine when they only feed a log line or a return value. If a read decides which branch the run takes, do it in a step so every replay sees the same answer.

## Atomic writes

Each statement is atomic on its own, but a step that runs several statements and then fails keeps the ones that already ran. When writes must happen together, use `batch` or `commitWithStep`.

:::note
`batch` and `commitWithStep` require `@actuate/runtime` 0.3. On the hosted platform they work once the platform runs that version. An older host rejects them with an error and writes nothing.
:::

### batch

`ctx.db.batch(statements)` runs the statements in order in one transaction. Either all of them apply or none do. It resolves to each statement's rows, in order: the `RETURNING` rows of a write, or an empty array for a write without `RETURNING`.

```ts
await ctx.step.do("place-order", () =>
  ctx.db.batch([
    ctx.db.statement`UPDATE stock SET qty = qty - ${input.qty} WHERE sku = ${input.sku}`,
    ctx.db.statement`INSERT INTO orders (id, sku, qty) VALUES (${ctx.runId}, ${input.sku}, ${input.qty})`,
  ]),
);
```

Build each statement with the `` ctx.db.statement`...` `` tagged template, which binds every `${value}` like `sql` does, or write it as `{ sql, params }`:

```ts
const orderId = await ctx.step.do("checkout", async () => {
  const [, [order]] = await ctx.db.batch<{ id: string }>([
    { sql: "DELETE FROM carts WHERE id = ?", params: [input.cartId] },
    { sql: "INSERT INTO orders (id, cart_id) VALUES (?, ?) RETURNING id", params: [ctx.runId, input.cartId] },
  ]);
  return order.id;
});
```

Later statements see the writes of earlier ones, and nothing else runs in between. If a statement fails, the batch applies none of them, and the error says which one: `Statement 2 of 2 failed, so none were applied: ...`. The batch refuses statements that control a transaction (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`), because the batch is already one transaction.

A batch is atomic on its own, not together with the step around it. If the step throws after the batch and is retried, the batch runs again. Make it safe to repeat (with natural keys or `ON CONFLICT`), or use `commitWithStep`.

### commitWithStep

`ctx.db.commitWithStep(statements)` works only inside `ctx.step.do`; outside a step it throws an `ActuatorError`. It doesn't run the statements. It queues them, and they commit in the same transaction that records the step as completed:

```ts
await ctx.step.do("charge", async () => {
  const bill = await ctx.payment.createBill({ amount: input.amount, referenceId: ctx.runId });
  ctx.db.commitWithStep([
    ctx.db.statement`INSERT INTO bills (id, booking_id, url) VALUES (${bill.id}, ${input.bookingId}, ${bill.url})`,
    ctx.db.statement`UPDATE bookings SET status = 'BILLED' WHERE id = ${input.bookingId}`,
  ]);
  return { billId: bill.id, url: bill.url };
});
```

- If the step throws or is retried, none of the queued writes applies. A retry starts with nothing queued.
- Once the step has completed, they never apply again, even when the runtime replays the run. So they happen exactly once, with the step's result.
- If one of them fails, none applies, the journal doesn't record the step as completed, and the attempt fails with that error (and retries if the step has `retries`).
- They run after the step function returns, so the step can't read their effects or their rows.

### Which to use

| | `batch` | `commitWithStep` |
| --- | --- | --- |
| All or nothing | Yes | Yes |
| Tied to the step's result | No, a retried step runs it again | Yes, exactly once with the step |
| The step can read the writes and rows | Yes | No |

Use `commitWithStep` for writes that record what the step did, such as a bill ID or a "sent" flag. Use `batch` when the step needs the rows back or reads what it wrote.

The same checks as `query` apply to every statement in either one. The runtime refuses tables starting with `_actuate_`. On the hosted platform, the host checks each statement like any other, and each one counts toward the 1,000 statements a pass may run, so a batch of 50 statements counts as 50.

## Migrations

```ts
await ctx.db.migrate([
  "CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, phone TEXT, status TEXT)",
  "CREATE INDEX bookings_phone ON bookings (phone)",
  "ALTER TABLE bookings ADD COLUMN paid_at TEXT", // added in a later version
]);
```

`migrate` applies each entry **once per actuator, tracked by its index** in the array. It skips entries that have already been applied, and applies new entries in order, in a transaction. That makes it cheap and safe to call at the top of every run, before your first step, and it keeps `CREATE TABLE` out of your business logic.

The rules that follow from tracking by index:

- **Append, never edit.** Once an entry has shipped, changing its text has no effect on databases where it already ran.
- **Never reorder or delete entries.** Index 2 must always mean the same statement.
- To undo something, append a new statement that undoes it.

## Reserved tables

Table names starting with `_actuate_` belong to the runtime (`_actuate_runs`, `_actuate_steps`, `_actuate_events`, `_actuate_migrations`, `_actuate_logs`). The runtime throws an `ActuatorError` for any query or migration whose SQL mentions `_actuate_`. Don't use the prefix for your own tables. On the platform, the host also refuses `_cf_` and `sqlite_` tables.

## What the platform refuses

On the hosted platform, the host checks every statement before it runs, outside your code, so your code cannot bypass the check. The check reads the statement the way SQLite does (strings, quoted names and comments), so quoting or commenting cannot hide part of it. A single SQLite statement can do unbounded work, so the host refuses these with a readable error:

| Refused | Examples |
| --- | --- |
| Recursive queries | `WITH RECURSIVE ...`, and any CTE that refers to itself (SQLite makes it recursive even without the keyword) |
| Generator and file functions | `randomblob()`, `zeroblob()`, `printf()`, `format()`, `load_extension()`, `readfile()`, `writefile()` |
| Database commands | `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, `REINDEX` |
| Transaction control | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`. Use [`batch` or `commitWithStep`](#atomic-writes) for writes that belong together |
| Runtime and system tables | `_actuate_*`, `_cf_*`, `sqlite_*` |

These limits also apply:

| Limit | Value |
| --- | --- |
| Bound parameters | 1 MiB in total per statement |
| SQL text | 100,000 characters per statement |
| One step's stored result | 1 MiB |
| Rows read per pass | 5,000,000 |
| Rows written per pass | 20,000 |
| Database size | Your plan's per-actuator limit, checked before each run and again after every statement |

When a statement would push the database over its size limit, the statement fails and the run fails with it. Rows read and written also count toward your plan's [monthly budgets](/docs/reference/limits/#plans).

`actuate dev` and the open-source runtime only enforce the `_actuate_` rule, so test against these limits before you rely on SQL that the platform refuses.

### Instead of a recursive query

The usual use of a recursive CTE is to generate a series of dates, slots or numbers. Generate it in TypeScript inside a step instead:

```ts
// 30 daily slots from the appointment date, written once.
await ctx.step.do("create-slots", async () => {
  const start = Date.parse(input.fromIso);
  for (let day = 0; day < 30; day++) {
    const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    await ctx.db.sql`INSERT OR IGNORE INTO slots (date, status) VALUES (${date}, 'OPEN')`;
  }
});
```

For a series you query often, keep a small numbers table (`CREATE TABLE numbers (n INTEGER PRIMARY KEY)`, filled once in a step) and join against it. For tree-shaped data such as categories or replies, walk the levels in a loop with one query per level, or store each row's full path (`/1/4/9/`) and match with `LIKE '/1/4/%'`.

Build formatted strings (the job of `printf` or `format`) in TypeScript, not in SQL.

## Browsing and exporting

You can read your tables outside of runs:

- In the dashboard, the platform has a table browser for each actuator. It has row counts (counted up to 10,000, then shown as "10,000+", because counting reads rows), a CSV download per table, and **Export database (.sql)**, which produces a SQL dump of all your tables, indexes, views and triggers (runtime tables excluded). Load it into a local file with `sqlite3 mine.db < mine.sql`. With a full API token, `GET /v1/actuators/<name>/export.sql` returns the same dump. Each export, `.sql` or CSV, holds up to a thousandth of your plan's monthly rows-read budget (Sandbox 50,000 rows, Maker 1,000,000, Agency 5,000,000). A `.sql` export that reaches it ends with a `-- Truncated` comment; for CSV, the dashboard tells you. Exports read rows, so they count against your monthly [rows-read budget](/docs/reference/limits/).
- On the runtime API, `GET /tables` lists your tables (runtime tables excluded), and `GET /tables/<name>` returns `{ columns, rows }`. Add `?format=csv` to download CSV (the runtime prefixes text cells starting with `=`, `+`, `-` or `@` with `'`, so spreadsheets don't run them as formulas), and page with `?limit=` (default 100, at most 10,000) and `?offset=`. See [Runtime HTTP API](/docs/reference/runtime-http/#tables).

```bash
curl 'localhost:8787/tables/bookings?format=csv' -o bookings.csv
```
