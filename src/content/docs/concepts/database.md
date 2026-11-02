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
| `migrate(statements)` | Applies new schema migrations |

Parameters can be strings, numbers, bigints, booleans (stored as `1` and `0`), `null`, `Uint8Array` or `ArrayBuffer`. The type argument (`query<T>`) types the rows; it is not checked at runtime.

Because `sql` binds every interpolated value, you cannot interpolate identifiers such as table or column names. Write those in the SQL text.

## Writes belong in steps

`run` is [replayed](/docs/concepts/steps-and-replay/) from the top after every pause, so a write outside a step runs again on every pass. Put inserts, updates and deletes inside `ctx.step.do`:

```ts
await ctx.step.do("save-booking", () =>
  ctx.db.sql`INSERT INTO bookings (id, name, status) VALUES (${ctx.runId}, ${input.customerName}, 'PENDING')`,
);
```

`actuate check` warns about literal `INSERT`, `UPDATE`, `DELETE` and `REPLACE` statements outside a step.

Reads outside a step are fine when they only feed a log line or a return value. If a read decides which branch the run takes, do it in a step so every replay sees the same answer.

## Migrations

```ts
await ctx.db.migrate([
  "CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, phone TEXT, status TEXT)",
  "CREATE INDEX bookings_phone ON bookings (phone)",
  "ALTER TABLE bookings ADD COLUMN paid_at TEXT", // added in a later version
]);
```

`migrate` applies each entry **once per actuator, tracked by its index** in the array. Entries that have already been applied are skipped; new entries are applied in order, in a transaction. That makes it cheap and safe to call at the top of every run, before your first step, and it keeps `CREATE TABLE` out of your business logic.

The rules that follow from tracking by index:

- **Append, never edit.** Once an entry has shipped, changing its text has no effect on databases where it already ran.
- **Never reorder or delete entries.** Index 2 must always mean the same statement.
- To undo something, append a new statement that undoes it.

## Reserved tables

Table names starting with `_actuate_` belong to the runtime (`_actuate_runs`, `_actuate_steps`, `_actuate_events`, `_actuate_migrations`, `_actuate_logs`). Any query or migration whose SQL mentions `_actuate_` is refused with an `ActuatorError`. Don't use the prefix for your own tables. On the platform, `_cf_` and `sqlite_` tables are refused too.

## What the platform refuses

On the hosted platform, every statement is checked by the host before it runs, outside your code, so it cannot be bypassed. A single SQLite statement can do unbounded work, so these are refused with a readable error:

| Refused | Examples |
| --- | --- |
| Recursive queries | `WITH RECURSIVE ...` |
| Generator and file functions | `randomblob()`, `zeroblob()`, `printf()`, `format()`, `load_extension()`, `readfile()`, `writefile()` |
| Database commands | `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, `REINDEX` |
| Runtime and system tables | `_actuate_*`, `_cf_*`, `sqlite_*` |

And these limits apply:

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

Recursive CTEs are mostly used to generate a series: dates, slots, numbers. Generate it in TypeScript inside a step instead:

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

Your tables are yours to read outside of runs:

- **Dashboard:** the platform has a table browser for each actuator with row counts (counted up to 10,000, then shown as "10,000+", because counting reads rows), a CSV download per table, and **Export database (.sql)**: a SQL dump of all your tables, indexes, views and triggers (runtime tables excluded). Load it into a local file with `sqlite3 mine.db < mine.sql`. The same dump is `GET /v1/actuators/<name>/export.sql` with a full API token. Each export, `.sql` or CSV, holds up to a thousandth of your plan's monthly rows-read budget (Sandbox 50,000 rows, Maker 1,000,000, Agency 5,000,000). A `.sql` export that reaches it ends with a `-- Truncated` comment; for CSV, the dashboard tells you. Exports read rows, so they count against your monthly [rows-read budget](/docs/reference/limits/).
- **Runtime API:** `GET /tables` lists your tables (runtime tables excluded), and `GET /tables/<name>` returns `{ columns, rows }`. Add `?format=csv` to download CSV (text cells starting with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets don't run them as formulas), and page with `?limit=` (default 100, at most 10,000) and `?offset=`. See [Runtime HTTP API](/docs/reference/runtime-http/#tables).

```bash
curl 'localhost:8787/tables/bookings?format=csv' -o bookings.csv
```
