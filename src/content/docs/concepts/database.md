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

Table names starting with `_actuate_` belong to the runtime (`_actuate_runs`, `_actuate_steps`, `_actuate_events`, `_actuate_migrations`, `_actuate_logs`). Any query or migration whose SQL mentions `_actuate_` is refused with an `ActuatorError`. Don't use the prefix for your own tables.

## Browsing and exporting

Your tables are yours to read outside of runs:

- **Dashboard:** the platform has a table browser for each actuator and an **Export .sqlite / .csv** button.
- **Runtime API:** `GET /tables` lists your tables (runtime tables excluded), and `GET /tables/<name>` returns `{ columns, rows }`. Add `?format=csv` to download CSV, and page with `?limit=` (default 100, at most 10,000) and `?offset=`. See [Runtime HTTP API](/docs/reference/runtime-http/#tables).

```bash
curl 'localhost:8787/tables/bookings?format=csv' -o bookings.csv
```
