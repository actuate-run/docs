---
title: Your first actuator
description: Build a deposit-booking bot that sends a payment link, waits for the payment, and reminds the customer if it does not arrive.
---

This page walks through a real actuator: a clinic takes a booking, sends the customer a payment link for a deposit, and waits. If the payment webhook arrives, the booking is confirmed. If it does not arrive in time, the customer gets one reminder.

It uses every core primitive: configuration, validated input, the database, two [capabilities](/docs/concepts/capabilities/), memoized steps and an event wait with a timeout.

## The whole file

```ts title="actuator.ts"
import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  businessName: z.string().default("Klinik Pergigian Senyum"),
  depositAmountRM: z.number().min(10).max(500).default(50),
  reminderDelay: z.enum(["30 minutes", "2 hours", "24 hours"]).default("2 hours"),
});

export const InputSchema = z.object({
  customerName: z.string(),
  phone: z.string().regex(/^\+60\d{9,10}$/),
  appointmentIso: z.string().datetime(),
});

export default defineActuator({
  name: "deposit_booking",
  description: "Books a slot, sends a payment link, waits for the webhook or reminds.",
  config: ConfigSchema,
  input: InputSchema,
  capabilities: ["payment", "messaging"], // declared, not ambient
  async run(ctx, input, config) {
    await ctx.db.migrate([
      "CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, phone TEXT, status TEXT)",
    ]);

    const bookingId = await ctx.step.do("save-booking", async () => {
      await ctx.db.query(
        "INSERT INTO bookings (id, name, phone, status) VALUES (?, ?, ?, 'PENDING')",
        [ctx.runId, input.customerName, input.phone],
      );
      return ctx.runId;
    });

    const payUrl = await ctx.step.do("send-link", async () => {
      const bill = await ctx.payment.createBill({ amount: config.depositAmountRM, referenceId: bookingId });
      await ctx.messaging.send(
        input.phone,
        `Hi ${input.customerName}, confirm your ${config.businessName} booking with a RM${config.depositAmountRM} deposit: ${bill.url}`,
      );
      return bill.url;
    });

    const paid = await ctx.step.waitForEvent("payment", {
      event: `payment.${bookingId}`,
      timeout: config.reminderDelay,
    });
    if (!paid) {
      await ctx.step.do("remind", () => ctx.messaging.send(input.phone, `Reminder: ${payUrl}`));
      return { status: "REMINDER_SENT", bookingId };
    }

    await ctx.step.do("confirm", () =>
      ctx.db.query("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?", [bookingId]),
    );
    return { status: "CONFIRMED", bookingId };
  },
});
```

## Walkthrough

### Configuration and input

`ConfigSchema` is what the operator sets once: the business name, the deposit and the reminder delay. Every field has a default, so the actuator runs with an empty configuration. Locally, configuration comes from `actuate.config.json`; on the platform the dashboard renders this schema as a form.

`InputSchema` is the payload of one run. It arrives by API, webhook, cron or MCP tool call and is validated before any of your code runs, so `run` never sees a malformed phone number.

### Capabilities

`capabilities: ["payment", "messaging"]` is what puts `ctx.payment` and `ctx.messaging` on the context. Leave one out and TypeScript will not let you use it, and it is absent at runtime too. The credentials behind each capability belong to you; see [Capabilities and providers](/docs/concepts/capabilities/).

### The database

`ctx.db.migrate` creates the `bookings` table the first time any run reaches it and does nothing afterwards, so it is safe at the top of `run`. The insert is a parameterised query inside a step, so it happens once even though `run` is replayed. See [Database](/docs/concepts/database/).

### Steps

`run` is replayed from the top every time the run wakes. Each `ctx.step.do` writes its result to the run's journal, and on replay it returns that result without calling the function again. That is why the booking is inserted once and the payment link is created and sent once, even if the run wakes many times.

Two details matter here:

- `createBill` takes `amount` in major units (50 means RM 50.00) and returns a `Bill` with `id`, `url` and `status`. The step returns `bill.url`, so the reminder can reuse the same link without creating a second bill.
- Provider calls must happen inside `ctx.step.do`. Calling `ctx.messaging.send` directly in `run` throws, because it would send again on every replay.

### Waiting for the payment

`waitForEvent` suspends the run until an event with the key `payment.<bookingId>` arrives. The payment provider's webhook delivers exactly that: `createBill` was given `referenceId: bookingId`, and the payment webhook surfaces as the event `payment.<referenceId>`.

While it waits nothing runs and nothing is billed. If the event does not arrive within `reminderDelay`, `waitForEvent` resolves to `null` and the run sends a reminder instead.

The return value is the run's output, stored with the run record and returned to API and MCP callers.

## Try it locally

Save the file as `actuator.ts` in the project from the [Quickstart](/docs/getting-started/quickstart/) and run `npx actuate dev`. Locally, messages are printed in the terminal and the payment provider is a fake whose bill URL points back at your actuator.

```bash
curl -X POST localhost:8787/run -H 'content-type: application/json' \
  -d '{"customerName":"Aina","phone":"+60123456789","appointmentIso":"2026-11-05T09:00:00Z"}'
```

The terminal prints the message with a link like `http://localhost:8787/events/payment.run_...`. Open it in a browser, or post the event yourself:

```bash
curl -X POST localhost:8787/events/payment.<runId> -H 'content-type: application/json' -d '{"status":"paid"}'
curl localhost:8787/runs/<runId>
```

The run is `COMPLETED` with output `{ "status": "CONFIRMED", ... }`, and `curl localhost:8787/tables/bookings` shows the row. To test the reminder path, set `{"reminderDelay": "30 minutes"}` in `actuate.config.json`, restart `actuate dev` (it reads the configuration at startup), start a run and don't pay.

## Next

- [Steps and replay](/docs/concepts/steps-and-replay/): retries, idempotency keys and the determinism rules.
- [Sleeping and waiting](/docs/concepts/sleeping-and-waiting/): timeouts and events that arrive early.
- [Human approvals](/docs/concepts/approvals/): add a sign-off before money moves.
