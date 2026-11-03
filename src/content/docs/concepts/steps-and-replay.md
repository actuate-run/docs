---
title: Steps and replay
description: How the journal, memoization, retries and idempotency keys work, and the determinism rules that follow from replay.
---

Actuate does not keep your code running while it waits. When a run sleeps or waits, the invocation ends and memory drops to zero. When it wakes, **`run` is called again from the top**, and every step that already finished returns its stored result instantly. Execution continues past the line where it stopped.

This is called replay. It is what makes a three-day wait free, and it gives you one rule:

:::caution[The rule]
Anything with a side effect or a value that changes between calls (network, provider calls, database writes, `Date.now()`, random numbers) belongs inside `ctx.step.do`.
:::

## The journal

Every actuator's SQLite database has a reserved table, `_actuate_steps`, keyed by `(run_id, step_name)`. Each step writes one row:

| Status | Meaning |
| --- | --- |
| `RUNNING` | The step's function is executing |
| `COMPLETED` | Finished; `output_json` holds the result |
| `RETRYING` | Failed; will run again at `wake_at` |
| `FAILED` | Failed permanently |
| `SLEEPING` | A sleep, waking at `wake_at` |
| `WAITING_EVENT` | Waiting for an event, until `wake_at` if there is a timeout |
| `WAITING_APPROVAL` | Waiting for a person, until `wake_at` |

You can see the journal for any run with `actuate logs <runId>`, `GET /runs/<runId>` on the [runtime API](/docs/reference/runtime-http/), or in the dashboard.

## ctx.step.do

```ts
const bill = await ctx.step.do("create-bill", async () => {
  return ctx.payment.createBill({ amount: 50, referenceId: ctx.runId });
});
```

1. The runtime looks up `(runId, "create-bill")` in the journal.
2. If a `COMPLETED` row exists, it returns the stored output without calling your function.
3. Otherwise it calls the function, stores the result, and returns it.

The result is stored as JSON and **the JSON round-trip is what you get back, on the first pass as well as on replays**. A `Date` comes back as an ISO string, `undefined` properties disappear, and class instances become plain objects. Return plain JSON values from steps.

### Step names

- Step names must be **unique within a run**. Using a name twice throws an `ActuatorError`. In a loop, include the index or the item's ID:

  ```ts
  for (const [i, phone] of input.phones.entries()) {
    await ctx.step.do(`remind-${i}`, () => ctx.messaging.send(phone, "See you tomorrow"));
  }
  ```

- Names are 1 to 200 characters.
- Steps cannot be nested. Calling any `ctx.step.*` inside a `ctx.step.do` function throws.
- Names are how replay finds results. If a run in flight replays against code where a step was renamed, that step runs again. On the hosted platform a run keeps the version it started on, so a deploy doesn't do this to runs in flight, but [retrying a failed run](/docs/guides/retry-and-rollback/#retry-a-failed-run) moves it to the current version. In `actuate dev` and a self-hosted runtime, a deploy changes the code of every run, including those in flight.

## Retries and backoff

By default a step that throws fails once and the error propagates out of `ctx.step.do`. Ask for retries per step:

```ts
const res = await ctx.step.do("fetch-rates", { retries: 3, backoff: "10 seconds" }, async () => {
  const r = await ctx.http.fetch("https://api.example.com/rates");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { usd: number };
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `retries` | `0` | How many times to retry after the first failure. Capped at 10 |
| `backoff` | `"1 second"` | Delay before the first retry; doubles on each further retry |

With `retries: 3, backoff: "10 seconds"` the step runs up to four times, waiting 10, 20 and 40 seconds between attempts. Between attempts the run is suspended like a sleep (status `RETRYING`), so a backoff costs nothing.

When the retries are used up, the step is marked `FAILED` and `ctx.step.do` throws. If you don't catch it, the run fails.

### NonRetryableError

Throw `NonRetryableError` to fail immediately, without using the remaining retries. Use it for errors that will not fix themselves, such as a declined card or a validation failure:

```ts
import { NonRetryableError } from "@actuate/sdk";

await ctx.step.do("charge", { retries: 5 }, async () => {
  const bill = await ctx.payment.getBill(billId);
  if (bill.status === "failed") throw new NonRetryableError("Payment failed");
  return bill.status;
});
```

### Catching a failed step

You can catch a step failure and take another path. The failure is recorded in the journal, so on every replay the same step throws again with the same message and your code takes the same path. Catch it broadly: on replays the error is rethrown as a generic step failure carrying the original message, not as the original error class.

## Idempotency keys

Every step function receives a `StepInfo`:

```ts
await ctx.step.do("refund", async ({ idempotencyKey, attempt }) => {
  ctx.log.info(`refund attempt ${attempt} (${idempotencyKey})`);
  return ctx.payment.refund?.({ billId });
});
```

- `idempotencyKey` is `<runId>:<stepName>`. It is the same on every attempt and every replay.
- `attempt` is 1 on the first try, 2 on the first retry, and so on.

Why it matters: a step can be interrupted after the provider acted but before the result was stored (a crash, a deploy, a CPU limit). The step then runs again. The journal makes the common case exactly-once; an idempotency key covers that last gap at the provider.

### Keys on provider calls

You don't need to pass a key yourself. Inside `ctx.step.do`, each call to `ctx.messaging.send`, `ctx.payment.createBill` or `ctx.payment.refund` gets one when you pass none (in `send`'s options, or in the request):

```text
<runId>:<stepName>:<method>:<n>
```

`n` counts that method's calls in the current attempt of the step, from 0. In a step named `notify` that sends two messages, the first gets `<runId>:notify:send:0` and the second `<runId>:notify:send:1`. So two calls in one step are never deduplicated against each other, and a retried or replayed step gives each call the same key it had before. Calls are counted per method, so an extra `send` on a retry doesn't change the key of the `refund` after it.

A key you pass yourself is used as is. Keys longer than 255 characters (a long custom run ID) are shortened to 255, ending in a hash of the whole key, so different keys stay different.

:::note
Default keys require `@actuate/runtime` 0.3. On the hosted platform they apply once the platform runs that version.
:::

Only some providers can use the key:

| Provider | Deduplicates | How |
| --- | --- | --- |
| Stripe | `createBill`, `refund` | `Idempotency-Key` header, kept for 24 hours |
| Resend (email) | `send` | `Idempotency-Key` header, kept for 24 hours |
| Discord with a bot token | `send` | A nonce with `enforce_nonce`, checked for a few minutes only |
| Discord webhooks, Telegram, WhatsApp, Slack | No | Their APIs take no key. A retried send can arrive twice |
| Chip, ToyyibPay, Billplz | No | Their APIs take no key. A retried call can create a second, unpaid bill (or, at Chip, repeat a partial refund) |

Two things follow at Stripe and Resend:

- A retry after the key has expired (a backoff longer than 24 hours) is not deduplicated.
- A retry that sends different parameters with the same key is rejected with an error. Build a step's provider requests from its input and earlier step results, not from `Date.now()` or values that change between attempts.

For providers that can't deduplicate, keep the call in a step of its own and give it no `retries`, or check whether it already happened before you repeat it.

On the hosted platform, retrying a failed run from its page (or the retry API) is not a step retry: the keys derived from the run get `:retry<n>`, so the fixed step is a new call at the provider. See [Retry a failed run](/docs/guides/retry-and-rollback/#retry-a-failed-run).

Pass your own key when you want calls in **different steps or different runs** to count as one, for example `refund-${orderId}` so that two runs for the same order refund it once (within Stripe's 24 hours). Never pass the same key to two different calls: the provider answers the second with the first one's result, or with an error if the parameters differ.

## Determinism rules

Code outside steps runs again on every replay, so it must produce the same decisions every time.

| Do this outside a step | Not this |
| --- | --- |
| Read `input`, `config`, `ctx.runId` | `Date.now()`, `new Date()`, `performance.now()` |
| Branch on step results | `Math.random()`, `crypto.randomUUID()` |
| Pure computation | `fetch`, provider calls, database writes |

To use the current time or a random value, compute it in a step:

```ts
const startedAt = await ctx.step.do("started-at", () => new Date().toISOString());
```

Database reads outside a step are allowed, but if the result decides which branch you take, read it inside a step so every replay sees the same value.

`ctx.log` calls are not journaled. A log line outside a step is written again on each pass; put it inside the step if you want it once. A pass keeps at most 100 log lines.

The runtime enforces some of this: provider calls outside `ctx.step.do` throw an `ActuatorError`. [`actuate check`](/docs/reference/cli/#actuate-check) flags the rest before you deploy.

## The suspend signal

Sleeps, waits and retry backoffs end a pass by throwing an internal `SuspendSignal`. **Never catch it.** If you wrap waits in `try`/`catch`, rethrow what you don't recognise:

```ts
import { isSuspendSignal } from "@actuate/sdk";

try {
  await ctx.step.waitForEvent("reply", { event: `reply.${ctx.runId}`, timeout: "1 day" });
} catch (err) {
  if (isSuspendSignal(err)) throw err;
  // handle your own errors
}
```

If your code swallows the signal anyway, the runtime still suspends the run when the pass ends and any further `ctx.step.*` call throws, but any other code after your `catch` still executes on that pass.

## Passes

Each time `run` executes from the top is a pass. A run that keeps suspending and waking is normal; one that never settles is not. The open-source runtime fails a run after 10,000 passes.

Every pass, and every step it writes, counts against your plan's budgets. [Write efficient actuators](/docs/guides/best-practices/) shows what each one costs and how to keep runs small.
