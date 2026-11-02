---
title: Capabilities and providers
description: Messaging, payment, LLM and HTTP are declared by the actuator, backed by your own credentials, and only usable inside steps.
---

An actuator has no ambient access to the outside world. It gets a client for each **capability** it declares, and nothing else:

```ts
export default defineActuator({
  name: "deposit_booking",
  description: "Books a slot, sends a payment link, waits for the webhook or reminds.",
  input: InputSchema,
  capabilities: ["payment", "messaging"], // declared, not ambient
  async run(ctx, input) {
    ctx.payment;   // PaymentProvider
    ctx.messaging; // MessagingProvider
    // ctx.llm and ctx.http do not exist here: a type error, and undefined at runtime
  },
});
```

There are four capabilities:

| Capability | Client | Launch providers | Credentials held by |
| --- | --- | --- | --- |
| `messaging` | `ctx.messaging` | Telegram Bot API (default: free, live in two minutes), WhatsApp Cloud API (your own Meta app and WABA), email via Resend or SMTP | You |
| `payment` | `ctx.payment` | Stripe, Chip, ToyyibPay, Billplz | You |
| `llm` | `ctx.llm` | Anthropic, OpenAI, Google, with your API key | You |
| `http` | `ctx.http` | Outbound `fetch` to domains you allow-list | You, per domain |

## Bring your own credentials

A provider is a small adapter that you configure with your own credentials: your Telegram bot token, your Stripe account, your LLM API key. Actuate stores the secret and injects a typed client into `ctx`. It never holds a platform-wide WhatsApp, payment or LLM account, so the account, the customer relationship and the policy risk stay with you (or your client).

Telegram is the default messaging channel because you can have a working bot with no business verification. WhatsApp is supported from launch and suits a business that already has, or is setting up, its own WhatsApp Business account.

The adapters are open source in [`@actuate/providers`](https://github.com/actuate-run/actuate/tree/main/packages/providers), so the same clients run in `actuate dev` and on a self-hosted runtime with your keys from environment variables (see [`actuate providers`](/docs/reference/cli/#actuate-providers)). On the hosted platform you enter credentials in the dashboard; they are encrypted at rest.

The free Sandbox plan has no messaging, payment or LLM providers; see [Limits](/docs/reference/limits/#plans).

## Rules

- **Declared, not ambient.** Only declared capabilities appear on `ctx`, in the types and at runtime. An undeclared name in `capabilities` is rejected by `defineActuator`.
- **Configured before deploy.** On the platform, an actuator whose declared capability has no provider configured is refused at deploy. In the open-source runtime, the first call to an unconfigured capability throws: `ctx.payment is declared but no payment provider is configured`.
- **Only inside steps.** Every provider method call must happen inside `ctx.step.do`. A call outside a step throws an `ActuatorError`, because it would repeat on every [replay](/docs/concepts/steps-and-replay/). Pass the step's `idempotencyKey` to providers that deduplicate.

## messaging

```ts
await ctx.step.do("notify", () =>
  ctx.messaging.send(input.chatId, `Release ${input.tag} is out`),
);
```

`send(to, text, options?)` returns `{ id, channel }`. `to` is a phone number, chat ID or email address, depending on the provider. Options:

| Option | Meaning |
| --- | --- |
| `channel` | Pick a channel when several are configured, for example `"telegram"`, `"whatsapp"` or `"email"` |
| `subject` | Email subject, when the channel is email |
| `template` | `{ name, language, variables? }`: a WhatsApp template, required for messages outside the 24-hour service window |
| `idempotencyKey` | Passed to providers that deduplicate. Defaults to the current step's key |

## payment

```ts
const bill = await ctx.step.do("create-bill", () =>
  ctx.payment.createBill({
    amount: 50,                 // major units: RM 50.00
    currency: "MYR",            // default "MYR"
    referenceId: bookingId,     // comes back as the event payment.<referenceId>
    description: "Deposit",
    customer: { name: input.customerName, phone: input.phone },
  }),
);
// bill: { id, url, status, amount, currency, referenceId }
```

| Method | What it does |
| --- | --- |
| `createBill(request)` | Create a payment link. Returns a `Bill` with `id`, `url`, `status`, `amount`, `currency` and `referenceId` |
| `getBill(id)` | Look up a bill's current status: `pending`, `paid`, `failed`, `expired` or `refunded` |
| `refund?(request)` | Refund a paid bill in full, or in part with `amount`. Optional: not every provider supports it, so call it as `ctx.payment.refund?.(...)` |

`amount` is always in major units. Other `createBill` fields are `returnUrl` (where the payer goes after paying) and `idempotencyKey`.

**Payment webhooks become events.** When the provider reports a payment, it is delivered to the actuator as the event `payment.<referenceId>`, so a run can wait for it:

```ts
import type { PaymentEvent } from "@actuate/sdk";

const paid = await ctx.step.waitForEvent<PaymentEvent>("payment", { event: `payment.${bookingId}`, timeout: "2 hours" });
if (paid?.status === "paid") {
  // confirm
}
```

The payload is a `PaymentEvent`:

| Field | Meaning |
| --- | --- |
| `provider` | Which provider sent it |
| `status` | `paid`, `failed`, `expired`, `refunded` or `pending` |
| `referenceId` | The `referenceId` you passed to `createBill` |
| `billId`, `amount`, `currency` | Present when the provider reports them |

Check `status`: a provider can report a failed or expired bill under the same key.

When you run locally with `actuate dev`, the payment provider is a fake: the bill's `url` points at your actuator's `/events/payment.<referenceId>`, so opening it in a browser "pays" the bill with the payload `{ provider: "dev", status: "paid", referenceId, via: "GET" }`. Messages are printed in the terminal instead of being sent.

## llm

```ts
const summary = await ctx.step.do("summarise", async () => {
  const res = await ctx.llm.complete({
    system: "Summarise the customer's message in one sentence.",
    prompt: input.message,
    maxTokens: 200,
  });
  return res.text;
});
```

`complete` takes `model`, `system`, `prompt` or `messages` (`{ role: "user" | "assistant", content }[]`), `maxTokens` and `temperature`, and returns `{ text, model, usage? }`. Because the call is in a step, its answer is stored: replays reuse the same text instead of asking again.

## http

`http` is outbound `fetch`, restricted to the domains you list:

```ts
export default defineActuator({
  name: "release_notifier",
  description: "Posts new GitHub releases to Telegram.",
  input: z.object({ repo: z.string() }),
  capabilities: ["http", "messaging"],
  http: { allow: ["api.github.com"] },
  async run(ctx, input) {
    const release = await ctx.step.do("latest-release", async () => {
      const res = await ctx.http.fetch(`https://api.github.com/repos/${input.repo}/releases/latest`);
      return (await res.json()) as { tag_name: string; html_url: string };
    });
    // ...
  },
});
```

- Declaring `"http"` without `http.allow` is an error.
- Entries are exact hostnames (`api.github.com`) or wildcards (`*.example.com`). A wildcard matches subdomains, not the apex: `*.example.com` allows `api.example.com` but not `example.com`.
- Only `https://` URLs are allowed.
- Redirects are not followed. A `3xx` comes back as a response for you to inspect.
- An actuator cannot call its own URL, which stops webhook loops.

There is no raw `fetch` in a hosted actuator; `ctx.http` is the way out.
