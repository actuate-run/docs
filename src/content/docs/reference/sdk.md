---
title: SDK API
description: Every type and function exported by @actuate/sdk.
---

```bash
npm install @actuate/sdk
```

```ts
import { defineActuator, z, NonRetryableError } from "@actuate/sdk";
```

`@actuate/sdk` is ESM-only and has one dependency, Zod 4.6 or later, which it re-exports as `z`. Use that `z` so your schemas and the SDK agree on the Zod version.

Zod's error messages are English-only in deployed actuators: `actuate deploy` and `actuate dev` drop Zod's other locales from the bundle, so `z.locales.en` works and other locales are `undefined`.

## Functions

### defineActuator

```ts
function defineActuator<C, I, O, K extends Capability = never>(
  definition: ActuatorDefinition<C, I, O, K>,
): Actuator<C, I, O, K>;
```

Declares an actuator. The default export of an actuator file must be the result of this call. Validates the definition and throws [`ActuatorError`](#actuatorerror) if `name` is invalid, `description` is empty, a capability is unknown, or `"http"` is declared without `http.allow`. Returns a frozen copy of the definition. The capability list is inferred as a literal type, so `ctx` only has the clients you declared.

### isActuator

```ts
function isActuator(value: unknown): value is Actuator;
```

True for a value returned by `defineActuator`. The CLI and runtime use it to check a file's default export.

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

True for the internal signal that ends a pass when a run sleeps or waits. Use it to rethrow in a `catch` around waits. See [The suspend signal](/docs/concepts/steps-and-replay/#the-suspend-signal).

### z

The Zod 4 namespace, re-exported from `zod`.

### CAPABILITIES

```ts
const CAPABILITIES: readonly Capability[]; // ["messaging", "payment", "llm", "http"]
```

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
  run(ctx: Context<K, P>, input: z.output<I>, config: z.output<C>): Promise<O> | O;
}
```

| Field | Meaning |
| --- | --- |
| `name` | Tool name. Must match `^[a-z][a-z0-9_]{0,63}$` |
| `description` | What the actuator does. Becomes the MCP tool description; write it for a model |
| `config` | Zod schema for operator settings. Defaults are used for anything not configured. Optional |
| `input` | Zod schema for the payload of one run. Validated before any code runs |
| `output` | Zod schema for the return value. The return value is validated against it, and it is published in the MCP tool and OpenAPI document. Optional |
| `capabilities` | Capabilities this actuator uses. Undeclared ones are absent from `ctx` |
| `http.allow` | Hostnames `ctx.http` may reach: exact (`api.github.com`) or wildcard (`*.example.com`) |
| `cron` | Cron schedules. Each firing starts a run with input `{}` |
| `hints` | What calling the tool does, for MCP clients: [`ToolHints`](#toolhints). Optional |
| `run` | Your code: `(ctx, input, config) => output` |

`C` and `I` extend [`AnySchema`](#anyschema). `input` and `config` arrive parsed, with defaults applied.

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

Published as the MCP tool's annotations. MCP clients use them to decide how to ask a person before calling the tool.

| Hint | MCP annotation | Default |
| --- | --- | --- |
| `readOnly` | `readOnlyHint` | `false` |
| `idempotent` | `idempotentHint` | `false` |
| `destructive` | `destructiveHint` | `true`, unless `readOnly` is `true` |
| `openWorld` | `openWorldHint` | `true` |

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

The `ctx` passed to `run`: the base context plus one client per declared capability.

### BaseContext

```ts
interface BaseContext {
  runId: string;
  actuator: string;
  trigger: Trigger;
  step: Step;
  db: Db;
  log: Logger;
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

### Trigger

```ts
type TriggerKind = "webhook" | "cron" | "mcp" | "manual" | "api";

interface Trigger {
  kind: TriggerKind;
  /** The cron expression, for cron triggers. */
  cron?: string;
}
```

See [Triggers](/docs/concepts/triggers/).

### Logger

```ts
interface Logger {
  info(message: string, data?: Json): void;
  warn(message: string, data?: Json): void;
  error(message: string, data?: Json): void;
}
```

Writes to the run's log, shown by `actuate logs <runId>` and the dashboard. Lines are stored together at the end of each pass.

- At most 100 lines per pass. After that, one warning line is added and further lines in that pass are dropped.
- Messages are truncated at 2,000 characters.
- `data` larger than about 4 KB of JSON is replaced by `{ truncated: "<the first 4,000 characters>" }`.

Log calls are not journaled: a call outside a step is written again on every pass.

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
| `sleep([name,] duration)` | Suspends the run for `duration`. Unnamed sleeps are named `sleep#1`, `sleep#2`, … in call order. [More](/docs/concepts/sleeping-and-waiting/#sleep) |
| `sleepUntil(name, until)` | Suspends until a `Date` or epoch-ms time. Completes immediately if it has passed. [More](/docs/concepts/sleeping-and-waiting/#sleepuntil) |
| `waitForEvent(name, options)` | Suspends until an event with key `options.event` is posted and resolves to its payload (never `null`; an empty event is `{}`), or resolves to `null` after `options.timeout` or at `options.until`. Consumes a buffered event if one arrived first. [More](/docs/concepts/sleeping-and-waiting/#waitforevent) |
| `waitForApproval(name, options?)` | Suspends until a person decides through a signed link, or resolves to `null` after the timeout (default 7 days). [More](/docs/concepts/approvals/) |
| `waitForInput(name, options)` | Suspends until a person answers a short text form through a signed link, or resolves to `null` after the timeout (default 7 days). [More](/docs/concepts/approvals/#asking-for-input) |

Rules for every method:

- `name` is 1 to 200 characters and **unique within a run**. A repeated name throws `ActuatorError`.
- Steps cannot be nested: calling any `ctx.step.*` inside a `do` function throws `ActuatorError`.
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
  /** `<runId>:<stepName>`. Stable for this run and step. */
  idempotencyKey: string;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  /** The host's clock when the step started, epoch ms. Use it instead of Date.now(); tests can control it. */
  now: number;
}
```

Passed to every `ctx.step.do` function.

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
  /** Who gets the signed links: a chat ID, phone or email understood by the messaging provider. */
  notify?: string;
  /** Give up after this long and resolve to `null`. Default "7 days". */
  timeout?: Duration;
}
```

### ApprovalResult

```ts
interface ApprovalResult {
  approved: boolean;
  /** ISO timestamp of the decision. */
  at: string;
  /** Optional note typed by the approver (on the approval page or in the dashboard). */
  note?: string;
  /** Who decided: the signed-in account (dashboard: email; API: email and token name), or the name typed on the link page (self-reported). */
  by?: string;
  /** Where it came from. */
  via?: "link" | "dashboard" | "api";
}
```

### WaitForInputOptions

```ts
interface WaitForInputOptions {
  /** The question shown on the form. */
  prompt: string;
  /** Who gets the signed link: a chat ID, phone or email understood by the messaging provider. */
  notify?: string;
  /** Pre-filled text, e.g. a draft to edit. */
  initial?: string;
  /** Longest answer accepted, characters. Default 4,000, at most 20,000. */
  maxLength?: number;
  /** Give up after this long and resolve to `null`. Default "7 days". */
  timeout?: Duration;
}
```

`prompt` is required; without it `waitForInput` throws `ActuatorError`.

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
  migrate(statements: readonly string[]): Promise<void>;
}
```

| Method | Behaviour |
| --- | --- |
| `query(sql, params?)` | Runs one statement with `?` placeholders and returns all rows |
| `first(sql, params?)` | Like `query`, returning the first row or `null` |
| `` sql`...` `` | Tagged template. Each interpolated value becomes a bound parameter, never SQL. Throws if called as a plain function |
| `migrate(statements)` | Applies each statement once per actuator, tracked by its index, in a transaction. Append new entries; never edit or reorder shipped ones |

SQL that mentions a table starting with `_actuate_` is refused with `ActuatorError`. See [Database](/docs/concepts/database/).

### SqlValue

```ts
type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
```

Booleans are stored as `1` and `0`.

### Row

```ts
type Row = Record<string, SqlValue>;
```

## Values

### Json

```ts
type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };
```

Step outputs, event payloads and run results are stored as JSON. What you get back is the JSON round-trip of what you returned.

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

Thrown when an actuator breaks one of the SDK's rules: an invalid definition, a duplicate or nested step name, a provider call outside a step, an unconfigured capability, a reserved table, or a return value that does not match the `output` schema.

### SuspendSignal

```ts
class SuspendSignal extends Error {
  readonly __actuateSuspend: true;
  readonly reason: string;
  constructor(reason: string);
}
```

Thrown by the runtime when a run must pause. **Never catch it** in actuator code; if you catch errors around waits, rethrow it using [`isSuspendSignal`](#issuspendsignal).

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

Every provider method must be called inside `ctx.step.do`. See [Capabilities and providers](/docs/concepts/capabilities/).

### MessagingProvider

```ts
interface MessagingProvider {
  send(to: string, text: string, options?: MessagingSendOptions): Promise<MessageReceipt>;
}

interface MessagingSendOptions {
  /** Provider-specific channel override, e.g. "telegram" | "whatsapp" | "email". */
  /** "html" sends <b>, <i>, <a href>, <code>, <pre> where supported (Telegram, email); other channels get plain text. Default "text". */
  format?: "text" | "html";
  channel?: string;
  /** Email subject, when the channel is email. */
  subject?: string;
  /** WhatsApp template for messages outside the 24-hour service window. */
  template?: { name: string; language: string; variables?: string[] };
  /** Defaults to the current step's idempotency key. */
  idempotencyKey?: string;
}

interface MessageReceipt {
  id: string;
  channel: string;
}
```

`to` is a phone number, chat ID or email address, depending on the provider.

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

### InboundMessage

```ts
interface InboundMessage {
  channel: string;  // "whatsapp" | "telegram"
  from: string;     // phone number (digits) or Telegram chat ID: pass it to messaging.send to reply
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

Outbound HTTPS restricted to the hostnames in `http.allow`. Redirects are not followed, and the actuator's own URL is refused.
