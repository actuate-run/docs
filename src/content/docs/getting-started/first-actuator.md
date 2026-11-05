---
title: Your first actuator
description: Build a deposit-booking bot that sends a payment link, waits for the payment, and reminds the customer if it does not arrive.
---

This page walks through a real actuator. A clinic takes a booking, sends the customer a payment link for a deposit, and waits. If the payment webhook arrives, the actuator confirms the booking. If it does not arrive in time, the customer gets one reminder.

It uses every core part of the SDK: configuration, validated input, the database, two [capabilities](/docs/concepts/capabilities/), memoized steps and an event wait with a timeout.

## The whole file

```ts title="actuator.ts"
import { defineActuator, z, type PaymentEvent } from "@actuate/sdk";

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

    const payment = await ctx.step.waitForEvent<PaymentEvent>("payment", {
      event: `payment.${bookingId}`,
      timeout: config.reminderDelay,
    });
    if (payment?.status !== "paid") {
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

`InputSchema` is the payload of one run. It arrives by API, webhook, cron or MCP tool call, and Actuate validates it before any of your code runs, so `run` never sees a malformed phone number.

### Capabilities

`capabilities: ["payment", "messaging"]` is what puts `ctx.payment` and `ctx.messaging` on the context. Leave one out and TypeScript will not let you use it, and it is absent at runtime too. The credentials behind each capability belong to you; see [Capabilities and providers](/docs/concepts/capabilities/).

### The database

`ctx.db.migrate` creates the `bookings` table the first time any run reaches it and does nothing afterwards, so it is safe at the top of `run`. The insert is a parameterised query inside a step, so it happens once even though the runtime replays `run`. See [Database](/docs/concepts/database/).

### Steps

The runtime replays `run` from the top every time the run wakes. Each `ctx.step.do` writes its result to the run's journal, and on replay it returns that result without calling the function again. That is why the actuator inserts the booking once, and creates and sends the payment link once, even if the run wakes many times.

Two details matter here:

- `createBill` takes `amount` in major units (50 means RM 50.00) and returns a `Bill` with `id`, `url` and `status`. The step returns `bill.url`, so the reminder can reuse the same link without creating a second bill.
- Provider calls must happen inside `ctx.step.do`. Calling `ctx.messaging.send` directly in `run` throws, because it would send again on every replay.

### Waiting for the payment

`waitForEvent` suspends the run until an event with the key `payment.<bookingId>` arrives. The payment provider's webhook delivers exactly that event. The step passed `referenceId: bookingId` to `createBill`, and the payment webhook arrives as the event `payment.<referenceId>`.

While it waits, nothing runs and nothing is billed. If the event does not arrive within `reminderDelay`, `waitForEvent` resolves to `null` and the run sends a reminder instead.

Check the status, not just that an event arrived. The payload is a [`PaymentEvent`](/docs/concepts/capabilities/#payment), and a failed card attempt or an expired bill arrives on the same key with `status` `"failed"` or `"expired"`. That is why the actuator confirms the booking only when `payment?.status === "paid"`, and anything else gets the reminder. The [deposit-reminder template](/docs/guides/templates/) goes further. It waits again after the reminder and releases the slot if the deposit never comes.

The return value is the run's output, stored with the run record and returned to API and MCP callers.

## Try it locally

Start from a fresh project (`npm create actuate deposit-bot`), save the file as its `actuator.ts`, and run `npx actuate dev`. Locally, the terminal shows messages, and the payment provider is a fake whose bill URL points back at your actuator.

:::note
If you reuse the Quickstart project instead, stop `actuate dev` and delete its `.actuate/state` folder first. Its database already applied migration 0 (`CREATE TABLE greetings`), and [Actuate tracks migrations by index](/docs/concepts/database/#migrations), so `CREATE TABLE bookings` would never run and the first run would fail with `no such table: bookings`. Runs still waiting from the old code would also replay against the new file and fail.
:::

```bash
curl -X POST localhost:8787/run -H 'content-type: application/json' \
  -d '{"customerName":"Aina","phone":"+60123456789","appointmentIso":"2026-11-05T09:00:00Z"}'
```

The terminal prints the message with a link like `http://localhost:8787/events/payment.run_...`. Open it in a browser, or post the event yourself:

```bash
curl -X POST localhost:8787/events/payment.<runId> -H 'content-type: application/json' -d '{"status":"paid"}'
curl localhost:8787/runs/<runId>
```

With `@actuate/cli` 0.3 or later, `npx actuate event payment.<runId> '{"status":"paid"}' --local` does the same, and `npx actuate logs <runId> --local` shows where the run got to.

The run is `COMPLETED` with output `{ "status": "CONFIRMED", ... }`, and `curl localhost:8787/tables/bookings` shows the row. To test the reminder path, set `{"reminderDelay": "30 minutes"}` in `actuate.config.json`, restart `actuate dev` (it reads the configuration at startup), start a run and don't pay.

## Deploying it

`actuate deploy` works as in the [Quickstart](/docs/getting-started/quickstart/#6-deploy), with two differences. This actuator declares `payment` and `messaging`, so it needs the Maker plan, and the free Sandbox refuses it with `402`. It also needs providers. Set your payment and messaging credentials under Providers in the dashboard's Settings before you deploy, or the platform refuses the deploy. `actuate deploy` checks both before it uploads, and stops without using a deploy.

## Next

- [Steps and replay](/docs/concepts/steps-and-replay/) covers retries, idempotency keys and the determinism rules.
- [Sleeping and waiting](/docs/concepts/sleeping-and-waiting/) covers timeouts and events that arrive early.
- [Human approvals](/docs/concepts/approvals/) shows how to add a sign-off before money moves.
- [Write efficient actuators](/docs/guides/best-practices/) shows how to keep runs cheap, and how to test an actuator before you deploy it.
