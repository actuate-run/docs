---
title: SDK API
description: Every type and function exported by @actuate/sdk.
---

```bash
npm install @actuate/sdk
```

```ts
import { defineActuator, secret, z, NonRetryableError } from "@actuate/sdk";
```

`@actuate/sdk` is ESM-only and has one dependency, Zod 4.6 or later, which it re-exports as `z`. Use that `z` so your schemas and the SDK agree on the Zod version.

Zod's error messages are English-only in deployed actuators, because `actuate deploy` and `actuate dev` drop Zod's other locales from the bundle. So `z.locales.en` works and other locales are `undefined`.

## Functions

### defineActuator

```ts
function defineActuator<C, I, O, K extends Capability = never>(
  definition: ActuatorDefinition<C, I, O, K>,
): Actuator<C, I, O, K>;
```

Declares an actuator. The default export of an actuator file must be the result of this call. Validates the definition and throws [`ActuatorError`](#actuatorerror) if `name` is invalid, `description` is empty, a capability is unknown, `"http"` is declared without `http.allow`, or [`idempotencyKey`](#idempotencykey) names a field that isn't a top-level string, number, integer or boolean field of the input schema (or is empty, or lists a field twice). Returns a frozen copy of the definition. TypeScript infers the capability list as a literal type, so `ctx` only has the clients you declared.

### secret

```ts
function secret<T extends z.ZodType>(schema: T): T;
```

Marks a config field, such as an API key, a token, a password or a webhook URL, as secret. It returns the same schema with `.meta({ writeOnly: true })`, so the field's JSON Schema gets `"writeOnly": true`, which is what the runtime and the platform look for.

```ts
config: z.object({
  apiKey: secret(z.string()),
  slack: z.object({ botToken: secret(z.string()).optional() }),
}),
```

Wrap the field itself, at any depth, including inside arrays and records. It survives `.optional()`, `.nullable()`, `.default()` and `.describe()`. Each occurrence of a secret field's value becomes `[secret]` in run logs, errors, step outputs and run records. Your code still gets the real value. Redaction skips values shorter than 6 characters, and booleans. See [keys and tokens](/docs/concepts/capabilities/#keys-and-tokens) for what is and isn't covered.

### isActuator

```ts
function isActuator(value: unknown): value is Actuator;
```

Returns true for a value that `defineActuator` returned. The CLI and runtime use it to check a file's default export.

### parseDuration

```ts
function parseDuration(value: Duration | string): number;
```

Converts a [`Duration`](#duration) to milliseconds. Throws `RangeError` for negative or non-finite numbers and for strings it does not understand.

```ts
parseDuration("2 hours"); // 7200000
parseDuration("1.5d");    // 129600000
parseDuration(500);       // 500
```

### isSuspendSignal

```ts
function isSuspendSignal(err: unknown): err is SuspendSignal;
```

Returns true for the internal signal that ends a pass when a run sleeps or waits. Use it to rethrow in a `catch` around waits. See [The suspend signal](/docs/concepts/steps-and-replay/#the-suspend-signal).

### z

This is the Zod 4 namespace, re-exported from `zod`.

### CAPABILITIES

```ts
const CAPABILITIES: readonly Capability[]; // ["messaging", "payment", "llm", "http"]
```

### NOTIFY_OWNER_MAX_TEXT, NOTIFY_OWNER_MAX_SUBJECT

```ts
const NOTIFY_OWNER_MAX_TEXT = 4_000;
const NOTIFY_OWNER_MAX_SUBJECT = 200;
```

The longest text and subject [`ctx.notifyOwner`](#notifyowner) accepts, in characters.

### NOTIFY_OWNER

```ts
const NOTIFY_OWNER = "owner";
```

The reserved `notify` value of [`waitForApproval`](#waitforapprovaloptions) and [`waitForInput`](#waitforinputoptions) that sends the signed links to the actuator's owner instead of through `ctx.messaging`. See [send the links to yourself](/docs/concepts/approvals/#send-the-links-to-yourself). Requires `@actuate/sdk` 0.5 or later.

## Definition types

### ActuatorDefinition

```ts
interface ActuatorDefinition<C, I, O, K extends Capability> {
  name: string;
  description: string;
  config?: C;
  input: I;
  output?: z.ZodType<O>;
  capabilities?: readonly K[];
  optionalCapabilities?: readonly P[]; // on ctx but possibly undefined; never required to deploy
  http?: { allow: readonly string[] };
  cron?: readonly string[];
  hints?: ToolHints;
  idempotencyKey?: readonly string[]; // input fields that say which request a call is
  run(ctx: Context<K, P>, input: z.output<I>, config: z.output<C>): Promise<O> | O;
}
```

| Field | Meaning |
| --- | --- |
| `name` | Tool name. Must match `^[a-z][a-z0-9_]{0,63}$`. The hosted platform refuses names starting with `actuate_`, which it keeps for its own tools, and so do the CLI's deploy checks |
| `description` | What the actuator does. Becomes the MCP tool description; write it for a model |
| `config` | Zod schema for operator settings. Defaults are used for anything not configured. Wrap API keys and tokens in [`secret()`](#secret). Optional |
| `input` | Zod schema for the payload of one run. Validated before any code runs |
| `output` | Zod schema for the return value. The runtime validates the return value against it, and the platform publishes it in the MCP tool and OpenAPI document. Optional |
| `capabilities` | Capabilities this actuator uses. Undeclared ones are absent from `ctx` |
| `optionalCapabilities` | Capabilities the actuator can do without. They are on `ctx` but `undefined` when no provider is configured, and never block a deploy. `http` cannot be optional. Optional |
| `http.allow` | Hostnames `ctx.http` may reach: exact (`api.github.com`) or wildcard (`*.example.com`) |
| `cron` | Cron schedules. Each firing starts a run with input `{}` |
| `hints` | What calling the tool does, for MCP clients: [`ToolHints`](#toolhints). Optional |
| `idempotencyKey` | Input fields whose values identify a request, such as `["orderId"]`. See [below](#idempotencykey). Optional; `@actuate/sdk` 0.5 or later |
| `run` | Your code: `(ctx, input, config) => output` |

`C` and `I` extend [`AnySchema`](#anyschema). `input` and `config` arrive parsed, with defaults applied.

#### idempotencyKey

```ts
idempotencyKey: ["orderId"],
```

A call over MCP or the run API (`POST /run`) that sends no idempotency key of its own gets one derived from these fields' values, so a retried tool call returns the first call's run instead of starting a second one.

- Each name is a top-level field of the input schema whose type is a string, number, integer or boolean, or an enum or literal of those. `defineActuator` throws `ActuatorError` otherwise, and for an empty list or a name listed twice. The [deploy checks](/docs/reference/cli/#the-deploy-checks) also require each field to be required, with no `.optional()` and no `.default()` (rule `idempotency-key`).
- The key is `input:` and the SHA-256 of the fields' values, in the order you list them, as the caller sent them. Zod's defaults, coercion and transforms don't apply, so `"A-1"` and `"a-1"` give different keys.
- It matches a run with the same key that is running or waiting, or that completed in the last 24 hours. A failed or cancelled run never matches.
- A key the caller sends (MCP `_meta["run.actuate/idempotencyKey"]`, or the `Idempotency-Key` header) is used instead, and matches a run with that key whatever its status. Send a new one to force a new run.
- Cron runs and webhooks never get a derived key. On the hosted platform, neither do runs the owner starts (the dashboard's **Start run** and **Run again**, and `actuate run`).
- A call whose input lacks one of the fields gets no derived key. The deploy checks rule that out on the platform, but self-hosted runs and tests don't check.
- Declaring it makes the MCP tool `idempotentHint: true`, unless `hints.idempotent` is `false`.

See [key fields](/docs/concepts/mcp-and-openapi/#key-fields).

### ToolHints

```ts
interface ToolHints {
  /** Only reads; never changes anything. */
  readOnly?: boolean;
  /** Calling twice with the same arguments has the same effect as calling once. */
  idempotent?: boolean;
  /** May delete or irreversibly change data. */
  destructive?: boolean;
  /** Talks to the outside world (messages, payments, other APIs). */
  openWorld?: boolean;
}
```

The hosted MCP server publishes these as the MCP tool's annotations. MCP clients use them to decide how to ask a person before calling the tool.

| Hint | MCP annotation | Default |
| --- | --- | --- |
| `readOnly` | `readOnlyHint` | `false` |
| `idempotent` | `idempotentHint` | `false`, or `true` for a read-only tool or one with [`idempotencyKey`](#idempotencykey) |
| `destructive` | `destructiveHint` | `true`, or `false` for a read-only tool |
| `openWorld` | `openWorldHint` | `true` if the actuator declares any capability, `false` otherwise |

These are the values the hosted MCP server sends when a hint is unset. It always sends all four. It sends a tool marked both `readOnly` and `destructive` as not read-only.

See [MCP and OpenAPI](/docs/concepts/mcp-and-openapi/#tool-hints).

### Actuator

```ts
interface Actuator<C, I, O, K> extends ActuatorDefinition<C, I, O, K> {
  readonly __actuate: 1;
}
```

The value `defineActuator` returns.

### AnySchema

```ts
type AnySchema = z.ZodType;
```

## Context

### Context

```ts
type Context<K extends Capability = never> = BaseContext & Pick<Providers, K>;
```

The `ctx` passed to `run`, which is the base context plus one client per declared capability.

### BaseContext

```ts
interface BaseContext {
  runId: string;
  actuator: string;
  trigger: Trigger;
  step: Step;
  db: Db;
  log: Logger;
  notifyOwner(text: string, options?: NotifyOwnerOptions): Promise<NotifyOwnerResult>;
}
```

| Field | Meaning |
| --- | --- |
| `runId` | Unique per run, reused across every replay of the run. Looks like `run_` followed by 28 hex characters, sortable by creation time |
| `actuator` | The actuator's `name` |
| `trigger` | How the run started |
| `step` | Durable steps: [`Step`](#step) |
| `db` | The actuator's SQLite database: [`Db`](#db) |
| `log` | The run's log: [`Logger`](#logger) |
| `notifyOwner` | Send the actuator's owner a short message: [`notifyOwner`](#notifyowner) |

`notifyOwner` is new in `@actuate/sdk` 0.4. If you build a `BaseContext` yourself, for example in a hand-written test context, add it.

### notifyOwner

```ts
notifyOwner(text: string, options?: NotifyOwnerOptions): Promise<NotifyOwnerResult>;
```

Sends the actuator's owner a short message, for things a person should hear about ("3 refunds have waited more than a day"). To message customers, use `ctx.messaging`. It needs no capability. On the hosted platform, Actuate emails it to the account's address, and sends it to the alert channel on Maker and Agency. Under `actuate dev`, it appears in the terminal. See [Message the owner](/docs/concepts/actuators/#message-the-owner).

- Call it inside `ctx.step.do`. Outside a step it throws `ActuatorError`, and `actuate check` reports it (`no-notify-outside-step`).
- `text` is 1 to 4,000 characters and not only whitespace. `subject` is one line of at most 200 characters, with no line breaks or other control characters. Anything else throws `ActuatorError`.
- Each message gets an idempotency key derived from the step's: `<runId>:<stepName>:notifyOwner:<n>`, where `n` counts this step attempt's `notifyOwner` calls from 0, as for [provider calls](/docs/concepts/steps-and-replay/#keys-on-provider-calls). A retried step sends its messages with the same keys. On the platform, Actuate remembers a key for 48 hours and sends the message once; see [Message the owner](/docs/concepts/actuators/#on-the-platform).
- A message the notifier doesn't send, for example past a daily cap, resolves to `{ sent: false, reason }` instead of throwing, and the runtime logs the reason as a `warn` line. With no notifier at all (self-hosted without one), the runtime logs the message itself as an `info` line and the call resolves to `{ sent: false, reason }`.
- Secret config values in `text` and `subject` become `[secret]` before the runtime hands the message on (not in `@actuate/cli/testing`, which records the real text).

### NotifyOwnerOptions

```ts
interface NotifyOwnerOptions {
  /** One line, at most 200 characters. */
  subject?: string;
}
```

### NotifyOwnerResult

```ts
interface NotifyOwnerResult {
  /** Whether the message went out. */
  sent: boolean;
  /** Why not, when it didn't: no notifier configured, a daily cap reached, ... */
  reason?: string;
}
```

### OwnerNotification

```ts
interface OwnerNotification {
  text: string;
  subject?: string;
  runId: string;
  actuator: string;
  /** `<runId>:<stepName>:notifyOwner:<n>`: the same on every retry of the step. */
  idempotencyKey: string;
}
```

One `ctx.notifyOwner` message, as the runtime hands it to an [`OwnerNotifier`](#ownernotifier).

### OwnerNotifier

```ts
interface OwnerNotifier {
  notify(message: OwnerNotification): Promise<NotifyOwnerResult>;
}
```

Delivers `ctx.notifyOwner` messages. Self-hosted, you write one and pass it to `createRuntime` (see [Self-hosting](/docs/guides/self-hosting/#messages-to-the-owner)). Deduplicate on `idempotencyKey`, so a retried step never sends a message twice. Return `{ sent: false, reason }` for a limit you chose, such as a daily cap. The runtime logs the reason and the step continues. Throw only for a failure worth retrying the step for.

### Trigger

```ts
type TriggerKind = "webhook" | "cron" | "mcp" | "manual" | "api";

interface Trigger {
  kind: TriggerKind;
  /** The cron expression, for cron triggers. */
  cron?: string;
}
```

On the hosted platform, runs started with an API token (over MCP or the gateway's `/a/<id>/run`) also carry `agent: { id: string; name: string }`, which is the ID and name of the token that started the run. The `Trigger` type doesn't declare it yet, so read it with a cast:

```ts
const agent = (ctx.trigger as { agent?: { id: string; name: string } }).agent;
```

The open-source runtime, `actuate dev`, webhooks and cron never set it. See [Triggers](/docs/concepts/triggers/) and [Agents](/docs/concepts/agents/).

### Logger

```ts
interface Logger {
  info(message: string, data?: Json): void;
  warn(message: string, data?: Json): void;
  error(message: string, data?: Json): void;
}
```

Writes to the run's log, shown by `actuate logs <runId>` and the dashboard. The runtime stores lines together at the end of each pass.

- A pass keeps at most 100 lines. After that, the runtime adds one warning line and drops further lines in that pass.
- The runtime truncates messages at 2,000 characters.
- The runtime replaces `data` larger than about 4 KB of JSON with `{ truncated: "<the first 4,000 characters>" }`.

The journal doesn't record log calls, so a call outside a step writes its line again on every pass.

## Steps

### Step

```ts
interface Step {
  do<T>(name: string, fn: (info: StepInfo) => T | Promise<T>): Promise<T>;
  do<T>(name: string, options: StepOptions, fn: (info: StepInfo) => T | Promise<T>): Promise<T>;
  sleep(duration: Duration): Promise<void>;
  sleep(name: string, duration: Duration): Promise<void>;
  sleepUntil(name: string, until: Date | number): Promise<void>;
  waitForEvent<T = Json>(name: string, options: WaitForEventOptions): Promise<T | null>;
  waitForApproval(name: string, options?: WaitForApprovalOptions): Promise<ApprovalResult | null>;
  waitForInput(name: string, options: WaitForInputOptions): Promise<InputResult | null>;
}
```

| Method | Behaviour |
| --- | --- |
| `do(name, [options,] fn)` | Runs `fn` once per run and stores its JSON result. On replay returns the stored result without calling `fn`. Retries per `options`. [More](/docs/concepts/steps-and-replay/#ctxstepdo) |
| `sleep([name,] duration)` | Suspends the run for `duration`. Unnamed sleeps are named `sleep#1`, `sleep#2` and so on, in call order. [More](/docs/concepts/sleeping-and-waiting/#sleep) |
| `sleepUntil(name, until)` | Suspends until a `Date` or epoch-ms time. Completes immediately if it has passed. [More](/docs/concepts/sleeping-and-waiting/#sleepuntil) |
| `waitForEvent(name, options)` | Suspends until an event with key `options.event` is posted and resolves to its payload (never `null`; an empty event is `{}`), or resolves to `null` after `options.timeout` or at `options.until`. Consumes a buffered event if one arrived first. [More](/docs/concepts/sleeping-and-waiting/#waitforevent) |
| `waitForApproval(name, options?)` | Suspends until a person decides through a signed link, or resolves to `null` after the timeout (default 7 days). [More](/docs/concepts/approvals/) |
| `waitForInput(name, options)` | Suspends until a person answers a short text form through a signed link, or resolves to `null` after the timeout (default 7 days). [More](/docs/concepts/approvals/#asking-for-input) |

Rules for every method:

- `name` is 1 to 200 characters and **unique within a run**. A repeated name throws `ActuatorError`.
- Steps cannot be nested. Calling any `ctx.step.*` inside a `do` function throws `ActuatorError`.
- Timeouts resolve to `null`; they never throw. But a timeout longer than the plan's longest wait throws `ActuatorError` when the wait starts.

### StepOptions

```ts
interface StepOptions {
  /** How many times to retry after the first failure. Default 0. */
  retries?: number;
  /** Delay before the first retry; doubles on each further retry. Default "1 second". */
  backoff?: Duration;
}
```

### StepInfo

```ts
interface StepInfo {
  /** `<runId>:<stepName>`. The same on every attempt and replay of this step. */
  idempotencyKey: string;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  /** The host's clock when the step started, epoch ms. Use it instead of Date.now(); tests can control it. */
  now: number;
}
```

The runtime passes it to every `ctx.step.do` function.

Provider calls in the step that take an idempotency key (`messaging.send`, `payment.createBill`, `payment.refund`) get one derived from `idempotencyKey` when you pass none: `<idempotencyKey>:<method>:<n>`, where `n` counts that method's calls in this attempt of the step from 0. In a step named `notify`, the second `send` gets `<runId>:notify:send:1`. The runtime uses a key you pass as is. See [keys on provider calls](/docs/concepts/steps-and-replay/#keys-on-provider-calls). Requires `@actuate/runtime` 0.3.

### WaitForEventOptions

```ts
interface WaitForEventOptions {
  /** The event key to wait for, e.g. `payment.${bookingId}`. */
  event: string;
  /** Give up after this long and resolve to `null`. Default: wait forever (or the plan's longest wait). */
  timeout?: Duration;
  /** Give up at this moment instead (use one of `timeout` or `until`). An event ends the wait early. */
  until?: Date | number;
}
```

Passing both `timeout` and `until` throws `ActuatorError`.

### WaitForApprovalOptions

```ts
interface WaitForApprovalOptions {
  /** Shown to the approver. */
  message?: string;
  /** Who gets the signed links: a recipient the messaging provider understands, "owner", or { to, channel }. */
  notify?: Notify;
  /** Give up after this long and resolve to `null`. Default "7 days". */
  timeout?: Duration;
}
```

`notify: "owner"` (reserved, never a default) sends the links to the actuator's owner the way [`ctx.notifyOwner`](#notifyowner) does, with no messaging provider needed. On the hosted platform that is an email to the account, and the account's alert channel when it is Telegram, Slack, Discord or email (never a custom webhook, so the links never reach another agent). Self-hosted, it is the `notifyOwner` notifier given to `createRuntime`, or the worker's console without one. Under `actuate dev`, it is the terminal. When the links can't go out (a daily cap reached), the step still waits, the request is in the approval queue, and the run's log gets a `warn` line. Any other value is a messaging recipient, as before. See [send the links to yourself](/docs/concepts/approvals/#send-the-links-to-yourself).

Telegram, Slack and Discord can put **Approve** and **Reject** buttons on the message when their credentials allow it, and the links stay in the text. A button decision resolves with `via: "chat"`. See [Approve from chat](/docs/guides/approval-buttons/).

### Notify

```ts
type Notify = string | { to: string; channel?: string };
```

`Notify` says who a `waitForApproval` or `waitForInput` notifies. A string is a messaging recipient, or `"owner"`. `{ to, channel }` sends to `to` through the messaging channel you name, such as `"slack"` or `"telegram"`, when you have several. Without `channel`, the default channel sends, as with a string. Requires `@actuate/sdk` and `@actuate/runtime` 0.5 or later.

```ts
const decision = await ctx.step.waitForApproval("manager-ok", {
  message: "Refund RM480?",
  notify: { to: "C0123456789", channel: "slack" },
});
```

- A channel that isn't configured always fails the delivery, even when you have only one messaging channel, so a recipient meant for one channel never goes out through another. The run's log gets an `error` line, `Could not deliver approval link for "<step>"`, and the step still waits. Decide it from the approval queue.
- `channel` is a channel name of 1 to 32 letters, digits and hyphens, and `to` a non-empty string. `{ to: "owner" }` isn't allowed, so write `notify: "owner"` instead. `waitForApproval` and `waitForInput` throw `ActuatorError` for a `notify` they can't use.
- [`ctx.messaging.send(to, text, { channel })`](#messagingprovider) follows the same rule. See [Several channels](/docs/concepts/capabilities/#several-channels).

### ApprovalResult

```ts
interface ApprovalResult {
  approved: boolean;
  /** ISO timestamp of the decision. */
  at: string;
  /** Optional note typed by the approver (on the approval page or in the dashboard). */
  note?: string;
  /**
   * Who decided: the signed-in account (dashboard: email; API: email and token name), the name typed on the link
   * page (self-reported), or for a chat button `<channel>:<user id> (<display name>)`.
   */
  by?: string;
  /** Where it came from: a signed link, the dashboard, the API, or a chat button. */
  via?: "link" | "dashboard" | "api" | "chat";
}
```

`via: "chat"` means someone clicked **Approve** or **Reject** in Telegram, Slack or Discord, or a custom webhook's receiver decided. `by` is then the channel and the clicker's user ID, with their display name in brackets when the chat app gives one, such as `telegram:123456789 (Wei Tan)` or `slack:U01ABC2DEF (alice)`. The chat app's signature proves the user ID, and the name is whatever the person chose. A custom webhook's receiver asserts both, as `custom-webhook:<id> (<name>)`, so `via: "chat"` alone doesn't mean a verified person. Where that matters, also check that `by` doesn't start with `custom-webhook:`. Chat decisions have no `note`. See [who decided](/docs/guides/approval-buttons/#who-decided). `"chat"` is new in `@actuate/sdk` 0.5.

### WaitForInputOptions

```ts
interface WaitForInputOptions {
  /** The question shown on the form. */
  prompt: string;
  /** Who gets the signed link, as for waitForApproval. */
  notify?: Notify;
  /** Pre-filled text, e.g. a draft to edit. */
  initial?: string;
  /** Longest answer accepted, characters. Default 4,000, at most 20,000. */
  maxLength?: number;
  /** Give up after this long and resolve to `null`. Default "7 days". */
  timeout?: Duration;
}
```

`prompt` is required; without it `waitForInput` throws `ActuatorError`. `notify` works as for [`waitForApproval`](#waitforapprovaloptions), including `"owner"` and [`{ to, channel }`](#notify).

### InputResult

```ts
interface InputResult {
  /** The answer, trimmed. Never empty, never longer than maxLength. */
  text: string;
  /** ISO timestamp of the answer. */
  at: string;
  /** Who decided: the signed-in account (dashboard: email; API: email and token name), or the name typed on the link page (self-reported). */
  by?: string;
  /** Where it came from. */
  via?: "link" | "dashboard" | "api";
}
```

### Duration

```ts
type Duration = number | `${number}${string}`;
```

Milliseconds as a number, or a string such as `"30 minutes"`, `"2h"`, `"3 days"`. Units: `ms`, `s`/`sec`/`second`, `m`/`min`/`minute`, `h`/`hr`/`hour`, `d`/`day`, `w`/`week`, with plurals. See [Durations](/docs/concepts/sleeping-and-waiting/#durations).

## Database

### Db

```ts
interface Db {
  query<T extends object = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T extends object = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  sql<T extends object = Row>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]>;
  statement(strings: TemplateStringsArray, ...values: SqlValue[]): DbStatement;
  batch<T extends object = Row>(statements: readonly DbStatement[]): Promise<T[][]>;
  commitWithStep(statements: readonly DbStatement[]): void;
  migrate(statements: readonly string[]): Promise<void>;
}
```

| Method | Behaviour |
| --- | --- |
| `query(sql, params?)` | Runs one statement with `?` placeholders and returns all rows |
| `first(sql, params?)` | Like `query`, returning the first row or `null` |
| `` sql`...` `` | Tagged template. Each interpolated value becomes a bound parameter, never SQL. Throws if called as a plain function |
| `` statement`...` `` | Tagged template. Builds a [`DbStatement`](#dbstatement) for `batch` or `commitWithStep` without running it. Interpolated values become bound parameters, as in `sql` |
| `batch(statements)` | Runs the statements in order in one transaction, all or nothing, and resolves to each one's rows (`RETURNING` rows, or `[]`). If one fails, none is applied and the error names it. A retried step runs the batch again |
| `commitWithStep(statements)` | Inside `ctx.step.do` only. Queues the statements to apply in the same transaction that records the step as completed, so they apply once, never on a failed attempt or a replay. The step can't read their effects. If one fails, none is applied and the attempt fails |
| `migrate(statements)` | Applies each statement once per actuator, tracked by its index, in a transaction. Append new entries; never edit or reorder shipped ones |

The runtime refuses SQL that mentions a table starting with `_actuate_`, with `ActuatorError`. In `batch` and `commitWithStep`, it also refuses a statement that controls a transaction (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`). `statement`, `batch` and `commitWithStep` require `@actuate/runtime` 0.3. A host on an older runtime rejects them and writes nothing. See [Database](/docs/concepts/database/#atomic-writes).

### DbStatement

```ts
interface DbStatement {
  /** One statement with `?` placeholders. */
  sql: string;
  params?: readonly SqlValue[];
}
```

One parameterised statement for `batch` and `commitWithStep`. Build it with `` ctx.db.statement`...` `` or write it as an object.

### SqlValue

```ts
type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
```

SQLite stores booleans as `1` and `0`.

### Row

```ts
type Row = Record<string, SqlValue>;
```

## Values

### Json

```ts
type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };
```

The runtime stores step outputs, event payloads and run results as JSON. What you get back is the JSON round-trip of what you returned.

## Errors

### NonRetryableError

```ts
class NonRetryableError extends Error {
  constructor(message: string);
}
```

Throw it from a step to fail immediately, skipping any remaining retries.

### ActuatorError

```ts
class ActuatorError extends Error {
  constructor(message: string);
}
```

It is thrown when an actuator breaks one of the SDK's rules: an invalid definition, a duplicate or nested step name, a provider call or `ctx.notifyOwner` outside a step, an unconfigured capability, a reserved table, or a return value that does not match the `output` schema.

### SuspendSignal

```ts
class SuspendSignal extends Error {
  readonly __actuateSuspend: true;
  readonly reason: string;
  constructor(reason: string);
}
```

The runtime throws it when a run must pause. **Never catch it** in actuator code. If you catch errors around waits, rethrow it using [`isSuspendSignal`](#issuspendsignal).

## Providers

### Providers

```ts
interface Providers {
  messaging: MessagingProvider;
  payment: PaymentProvider;
  llm: LlmProvider;
  http: HttpProvider;
}

type Capability = keyof Providers; // "messaging" | "payment" | "llm" | "http"
```

Call every provider method inside `ctx.step.do`. See [Capabilities and providers](/docs/concepts/capabilities/).

### MessagingProvider

```ts
interface MessagingProvider {
  send(to: string, text: string, options?: MessagingSendOptions): Promise<MessageReceipt>;
}

interface MessagingSendOptions {
  /** "html" sends <b>, <i>, <a href>, <code>, <pre> where supported (Telegram, email; the custom webhook adds it as `html`); other channels get plain text. Default "text". */
  format?: "text" | "html";
  /** Which configured channel sends: "telegram", "whatsapp", "slack", "discord", "custom-webhook" or "email". Default: the first. A channel that isn't configured is refused, even when only one is. */
  channel?: string;
  /** Email subject, when the channel is email. The custom webhook sends it as `subject`. */
  subject?: string;
  /** WhatsApp template for messages outside the 24-hour service window. */
  template?: { name: string; language: string; variables?: string[] };
  /** Passed to providers that deduplicate (Resend; Discord with a bot token, for a few minutes; the custom webhook's message ID). Defaults to a key for this call, derived from the step's key. */
  idempotencyKey?: string;
  /** Set only by Actuate's own approval and input notifications; removed from sends your code makes. */
  approval?: ApprovalPrompt;
}

/** A step waiting for a person, as an approval notification describes it to the messaging provider. */
interface ApprovalPrompt {
  /** "approval" carries approveUrl and rejectUrl; "input" carries answerUrl. */
  kind: "approval" | "input";
  actuator: string;
  step: string;
  /** The approval message, or the question for input (secret config values redacted). */
  message?: string;
  /** Signed links to the confirm page: opening one shows the page (GET), and only its button decides (POST). */
  approveUrl?: string;
  rejectUrl?: string;
  answerUrl?: string;
  /** When the links stop working, epoch ms. */
  expiresAt: number;
  /** On approvals, when the runtime made a button nonce: what a provider puts on Approve and Reject buttons. */
  buttons?: { route: string; nonce: string };
}

interface MessageReceipt {
  id: string;
  channel: string;
}
```

`to` is a phone number, chat ID or email address, depending on the provider. The [custom webhook](/docs/guides/custom-webhook/) passes it to your endpoint unchanged.

`approval` lets a provider render a request as a card with link buttons, as the custom webhook's [approval requests](/docs/guides/custom-webhook/#approval-requests) do. The runtime sets it on the messages it sends for `waitForApproval` and `waitForInput` with a `notify` recipient, and removes it from sends made through `ctx.messaging`, so actuator code can't fake an approval card. Providers that don't know it ignore it, and the text always carries the same links. Requires `@actuate/sdk` and `@actuate/runtime` 0.5 or later. The runtime sets `buttons` only on approvals sent to a `notify` recipient, never on questions or `notify: "owner"`. Telegram, Slack and Discord put it on interactive [approval buttons](/docs/guides/approval-buttons/), and the custom webhook turns it into [`approval.decide`](/docs/guides/approval-buttons/#decide-from-your-own-server). It decides nothing alone, because the provider that sent it must also verify the click.

### PaymentProvider

```ts
interface PaymentProvider {
  createBill(request: CreateBillRequest): Promise<Bill>;
  getBill(id: string): Promise<Bill>;
  refund?(request: RefundRequest): Promise<{ id: string; status: "pending" | "succeeded" | "failed" }>;
}

interface CreateBillRequest {
  /** Amount in major units, e.g. 50 for RM 50.00. */
  amount: number;
  /** ISO 4217 code. Defaults to "MYR". */
  currency?: string;
  /** Your own reference. The payment webhook carries it back as event `payment.<referenceId>`. */
  referenceId: string;
  description?: string;
  customer?: { name?: string; email?: string; phone?: string };
  /** Where the payer is sent after paying. */
  returnUrl?: string;
  /** Passed to providers that deduplicate (Stripe). Defaults to a key for this call, derived from the step's key. */
  idempotencyKey?: string;
}

interface Bill {
  id: string;
  url: string;
  status: "pending" | "paid" | "failed" | "expired" | "refunded";
  amount: number;
  currency: string;
  referenceId: string;
}

interface RefundRequest {
  billId: string;
  /** Major units. Omit for a full refund. */
  amount?: number;
  reason?: string;
  /** Passed to providers that deduplicate (Stripe). Defaults to a key for this call, derived from the step's key. */
  idempotencyKey?: string;
}
```

`refund` is optional because not every provider supports it. Call it as `ctx.payment.refund?.(...)`.

### PaymentEvent

```ts
interface PaymentEvent {
  provider: string;
  status: "paid" | "failed" | "expired" | "refunded" | "pending";
  referenceId: string;
  billId?: string;
  amount?: number;
  currency?: string;
}
```

The payload of the `payment.<referenceId>` event a payment provider's webhook delivers:

```ts
const paid = await ctx.step.waitForEvent<PaymentEvent>("paid", { event: `payment.${bookingId}`, timeout: "1 day" });
```

Before acting on it, check `status`, and that `billId`, `amount` and `currency` match the bill you created. See [Payment](/docs/concepts/capabilities/#payment).

### InboundMessage

```ts
interface InboundMessage {
  channel: string;  // "whatsapp" | "telegram" | "custom-webhook"
  from: string;     // phone number (digits), Telegram chat ID, or the custom webhook reply's `from`: pass it to messaging.send to reply
  text: string;     // the text, a button's title, or a media caption ("" for media without one)
  type: string;     // "text", "button", "interactive", "image", ... as the provider reports it
  id: string;       // the provider's message ID
  at: number;       // when it was sent, ms since the epoch
  name?: string;    // the sender's display name, when the provider includes it
}
```

The payload of the `message.<channel>.<from>` event an inbound message delivers. See [Receiving messages](/docs/concepts/capabilities/#receiving-messages).

### LlmProvider

```ts
interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

interface LlmRequest {
  model?: string;
  system?: string;
  prompt?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

interface LlmResponse {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}
```

### HttpProvider

```ts
interface HttpProvider {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}
```

It makes outbound HTTPS requests, restricted to the hostnames in `http.allow`. It doesn't follow redirects, and it refuses the actuator's own URL.
