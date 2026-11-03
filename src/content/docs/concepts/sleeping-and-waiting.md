---
title: Sleeping and waiting
description: sleep, sleepUntil and waitForEvent - durations, timeouts and events that arrive before anyone is waiting.
---

A run can pause for seconds or weeks. While it is paused, nothing runs: the invocation has ended, a Durable Object alarm holds the wake time, and you are not billed for compute. When the alarm fires or the awaited event arrives, `run` [replays](/docs/concepts/steps-and-replay/) and continues past the line where it stopped.

## Durations

Anywhere a duration is accepted you can pass milliseconds as a number or a string such as `"500ms"`, `"30 seconds"`, `"10s"`, `"2 hours"`, `"24h"`, `"3 days"` or `"2 weeks"`.

| Unit | Accepted spellings |
| --- | --- |
| Milliseconds | `ms`, `millisecond`, `milliseconds` |
| Seconds | `s`, `sec`, `secs`, `second`, `seconds` |
| Minutes | `m`, `min`, `mins`, `minute`, `minutes` |
| Hours | `h`, `hr`, `hrs`, `hour`, `hours` |
| Days | `d`, `day`, `days` |
| Weeks | `w`, `week`, `weeks` |

The number may have a decimal part (`"1.5 hours"`), and the space is optional. Anything else throws a `RangeError`. The `Duration` type accepts string literals that start with a number; a value typed as plain `string` needs a Zod enum or a cast.

## sleep

```ts
await ctx.step.sleep("1 day");
await ctx.step.sleep("second-nudge", "3 days");
```

The short form names the step `sleep#1`, `sleep#2` and so on, in the order the run reaches unnamed sleeps. That is deterministic as long as your control flow is. When a sleep sits inside a branch or a loop, give it a name so the numbering cannot shift between passes; in a loop, include the index in the name.

The wake time is fixed the first time the run reaches the sleep. Replays do not restart the clock.

## sleepUntil

```ts
const appointment = new Date(input.appointmentIso);
await ctx.step.sleepUntil("day-before", appointment.getTime() - 86_400_000);
await ctx.step.do("remind", () => ctx.messaging.send(input.phone, "See you tomorrow!"));
```

Pause until a point in time, given as a `Date` or epoch milliseconds. If that time has already passed, the step completes immediately. `sleepUntil` always takes a name.

## waitForEvent

```ts
import type { PaymentEvent } from "@actuate/sdk";

const payment = await ctx.step.waitForEvent<PaymentEvent>("payment", {
  event: `payment.${bookingId}`,
  timeout: "2 hours",
});
if (payment === null) {
  // timed out
} else if (payment.status === "paid") {
  // confirm the booking
}
```

Pause until an event with the key `event` is posted, then resolve to its JSON payload.

| Option | Default | Meaning |
| --- | --- | --- |
| `event` | required | The event key, for example `payment.${bookingId}` |
| `timeout` | none: wait forever | Give up after this long and resolve to `null` |
| `until` | none | Give up at this moment instead, as a `Date` or epoch ms. Use `timeout` or `until`, not both |

`until` is for deadlines that are a point in time, such as "pay before the appointment". An event still ends the wait early:

```ts
const paid = await ctx.step.waitForEvent<PaymentEvent>("deposit", {
  event: `payment.${bookingId}`,
  until: new Date(input.appointmentIso),
});
```

Like a sleep, the deadline is fixed the first time the run reaches the wait. A deadline already in the past times out on the next pass.

**Plan limits.** On a plan with a longest wait (the Sandbox allows 7 days), a `timeout` or `until` beyond it throws `ActuatorError` when the wait starts, so you find out instead of the run waking early. A wait with neither is open-ended and gets the plan's maximum. The same rule applies to the timeouts of `waitForApproval` and `waitForInput`.

**On timeout `waitForEvent` resolves to `null`; it does not throw.** Always handle the `null` case. An event is never delivered as `null`: an event posted with no body, or a `null` body, arrives as `{}`. So `null` from a wait always means the timeout passed.

### Posting events

Events are identified only by their key. Make keys specific enough to name one thing, usually by including an ID you created: `payment.${bookingId}`, `reply.${ctx.runId}`.

- **Payment webhooks.** When a payment provider confirms a bill, the webhook is delivered as the event `payment.<referenceId>`, using the `referenceId` you passed to `createBill`. See [Capabilities and providers](/docs/concepts/capabilities/#payment).
- **Your own systems.** Post to the actuator's events endpoint: `POST /events/<key>` with a JSON body on the [runtime API](/docs/reference/runtime-http/#events). The body is the payload, up to 64 KiB of JSON. On the platform this needs a **full** API token: an event can complete a payment or a reply your run is waiting for, so agent (run-scoped) tokens cannot post one.

When an event arrives, every step waiting on that key completes with the payload and its run resumes. That includes steps in different runs.

### Events that arrive early

An event can arrive before the run reaches its wait, for example when a customer pays within a second of receiving the link. Nothing is lost: an event that no step is waiting for is **buffered**. When a run later reaches `waitForEvent` with that key, it takes the oldest buffered event and continues without suspending.

- Each buffered event is consumed by one wait.
- An actuator buffers at most 1,000 events. Beyond that, the oldest are dropped.
- Buffered events that nobody claims are dropped after 7 days.
- An event that arrives after a wait timed out is buffered like any other, and a later wait on the same key can pick it up. Another reason to make keys specific.

## Waiting for a person

`ctx.step.waitForApproval` and `ctx.step.waitForInput` are waits that only a person can end, through a signed link. See [Human approvals and input](/docs/concepts/approvals/).

## Combining waits

Waits run one at a time; there is no `Promise.all` over steps. A common pattern is a wait with a timeout followed by a reminder and a second, longer wait:

```ts
let paid = await ctx.step.waitForEvent("payment", { event: `payment.${bookingId}`, timeout: "2 hours" });
if (!paid) {
  await ctx.step.do("remind", () => ctx.messaging.send(input.phone, `Reminder: ${payUrl}`));
  paid = await ctx.step.waitForEvent("payment-after-reminder", { event: `payment.${bookingId}`, timeout: "1 day" });
}
```

The second wait has a different step name but the same event key, so a payment that arrives at any point completes whichever wait is current.
