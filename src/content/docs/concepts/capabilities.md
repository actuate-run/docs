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
| `messaging` | `ctx.messaging` | Telegram Bot API (default: free, live in two minutes), WhatsApp Cloud API (your own Meta app and WABA), Slack, Discord, email via Resend | You |
| `payment` | `ctx.payment` | Stripe, Chip, ToyyibPay, Billplz | You |
| `llm` | `ctx.llm` | Anthropic, OpenAI, Google, or any OpenAI-compatible API (OpenRouter, Groq, Together, DeepSeek, Mistral, Workers AI, a local Ollama), with your API key | You |
| `http` | `ctx.http` | Outbound `fetch` to domains you allow-list | You, per domain |

## Bring your own credentials

A provider is a small adapter that you configure with your own credentials: your Telegram bot token, your Stripe account, your LLM API key. Actuate stores the secret and injects a typed client into `ctx`. It never holds a platform-wide WhatsApp, payment or LLM account, so the account, the customer relationship and the policy risk stay with you (or your client).

Telegram is the default messaging channel because you can have a working bot with no business verification. WhatsApp is supported from launch and suits a business that already has, or is setting up, its own WhatsApp Business account.

The adapters are open source in [`@actuate/providers`](https://github.com/actuate-run/actuate/tree/main/packages/providers), so the same clients run in `actuate dev` and on a self-hosted runtime with your keys from environment variables (see [`actuate providers`](/docs/reference/cli/#actuate-providers)). On the hosted platform you enter credentials in the dashboard; they are encrypted at rest.

The free Sandbox plan has no messaging, payment or LLM providers; see [Limits](/docs/reference/limits/#plans).

## Rules

- **Declared, not ambient.** Only declared capabilities appear on `ctx`, in the types and at runtime. An undeclared name in `capabilities` is rejected by `defineActuator`.
- **Configured before deploy.** On the platform, an actuator whose declared capability has no provider configured is refused at deploy. In the open-source runtime, the first call to an unconfigured capability throws: `ctx.payment is declared but no payment provider is configured`.
- **Optional when you can do without.** List a capability in `optionalCapabilities` instead and it is on `ctx` but `undefined` when no provider is configured, and never blocks a deploy: `await ctx.step.do("alert", () => ctx.messaging?.send("ops", text))`. `http` cannot be optional.
- **Only inside steps.** Every provider method call must happen inside `ctx.step.do`. A call outside a step throws an `ActuatorError`, because it would repeat on every [replay](/docs/concepts/steps-and-replay/). Pass the step's `idempotencyKey` to providers that deduplicate.

## messaging

```ts
await ctx.step.do("notify", () =>
  ctx.messaging.send(input.chatId, `Release ${input.tag} is out`),
);
```

`send(to, text, options?)` returns `{ id, channel }`. What `to` means depends on the provider:

| Provider | `to` |
| --- | --- |
| Telegram | A chat ID, e.g. `123456789` or `-100123456789` for a group |
| WhatsApp | A phone number in international format, e.g. `60123456789` |
| Slack | A channel ID, e.g. `C0123456789` (the bot must be in the channel). With an incoming webhook instead of a bot token, `to` is ignored |
| Discord | A channel ID. With a channel webhook instead of a bot token, `to` is ignored. Messages are at most 2,000 characters, and never ping `@everyone` or roles |
| Email (Resend) | An email address |

Slack and Discord suit messages to you or your team: approval requests, alerts, reports. Options:

| Option | Meaning |
| --- | --- |
| `channel` | Which channel sends, when several are configured: `"telegram"`, `"whatsapp"`, `"slack"`, `"discord"` or `"email"`. Without it, the default channel sends. See [Several channels](#several-channels) |
| `subject` | Email subject, when the channel is email |
| `template` | `{ name, language, variables? }`: a WhatsApp template, required for messages outside the 24-hour service window |
| `format` | `"text"` (default) or `"html"`: a small HTML subset (`<b>`, `<i>`, `<a href>`, `<code>`, `<pre>`) where the channel supports it (Telegram, email); other channels get the text with tags removed |
| `idempotencyKey` | Passed to providers that deduplicate. Defaults to the current step's key |

### Several channels

You can connect more than one messaging provider, for example WhatsApp for customers and Slack for your team. The first one is the default; `channel` picks another:

```ts
await ctx.step.do("tell-customer", () => ctx.messaging.send(input.phone, "Your refund is on its way"));
await ctx.step.do("tell-team", () => ctx.messaging.send("C0123456789", `Refunded ${input.orderId}`, { channel: "slack" }));
```

On the platform, connect each in **Settings → Providers** and use **Make default** to choose the default; up to five channels. Locally, list them in `.dev.vars`, default first: `ACTUATE_MESSAGING=whatsapp,slack`. Sending on a channel that isn't configured fails the step with `No "slack" messaging channel is configured`. Payment and LLM providers stay one each.

### Receiving messages

With WhatsApp or Telegram, a run can wait for the customer's reply. Each inbound message becomes the event `message.<channel>.<from>`, with an [`InboundMessage`](/docs/reference/sdk/#inboundmessage) payload:

```ts
import type { InboundMessage } from "@actuate/sdk";

await ctx.step.do("ask", () => ctx.messaging.send(input.phone, "Reply YES to confirm tomorrow at 10:00"));
const reply = await ctx.step.waitForEvent<InboundMessage>("reply", {
  event: `message.whatsapp.${input.phone}`,
  timeout: "1 day",
});
if (reply?.text.trim().toUpperCase() === "YES") {
  // confirmed
}
```

`from` is in the form `send` accepts, so `ctx.messaging.send(reply.from, ...)` answers the same person. A message nobody is waiting for is buffered like any [event](/docs/concepts/sleeping-and-waiting/#posting-events), so a reply that arrives before the run starts waiting is not lost.

To set it up, point the provider at the actuator's provider webhook URL, which the dashboard shows under **Connect → Receive messages** (`https://run.actuate.run/a/<id>/providers/<kind>/webhook`):

| Provider | Setup | Needed so messages can't be forged |
| --- | --- | --- |
| WhatsApp | In your Meta app, WhatsApp → Configuration → Webhook: paste the URL, enter your **Webhook verify token**, subscribe to `messages` | **App secret**: every delivery's `X-Hub-Signature-256` is checked. Only messages to your configured phone number ID count |
| Telegram | Call `setWebhook` with the URL and `secret_token` set to your **Webhook secret token** | **Webhook secret token**: checked on every update |

Without the app secret or secret token, inbound messages are ignored rather than trusted. A WhatsApp number or Telegram bot has one webhook, so it delivers to one actuator; use a bot or number per actuator if several need replies. Locally, `actuate dev` serves the same route at `http://localhost:8787/providers/<kind>/webhook`; expose it with a tunnel.

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

ToyyibPay's callbacks are not signed, so Actuate never trusts what the callback says. It re-queries the transaction with your ToyyibPay credentials and builds the event only from that answer: the event key uses the re-queried transaction's reference, and the amount is the re-queried amount. A callback that doesn't match a transaction on your account is rejected.

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

**Any OpenAI-compatible API.** Choose **OpenAI-compatible API** and give its base URL (the part before `/chat/completions`, e.g. `https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1`), an API key and a default model. That covers OpenRouter, Groq, Together, DeepSeek, Mistral, Fireworks, Cloudflare Workers AI, and a local Ollama or vLLM server under `actuate dev` (`http://localhost:11434/v1`). The base URL must be `https://` (plain `http://` only for `localhost`) and use a hostname, not an IP address.

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
- An actuator cannot call its own URL, which stops webhook loops. Hostnames are compared case-insensitively and without a trailing dot, so `API.Example.com.` is the same host as `api.example.com`.
- IP addresses (`https://1.2.3.4/`, `https://[::1]/`) are refused when you call them. Use a hostname.

On the platform, `http.allow` is also checked when you deploy. The deploy is refused if the list:

- has more than 20 entries;
- contains an IP address or anything that isn't a hostname;
- names the platform itself (`actuate.run` or any subdomain);
- uses a wildcard that is too broad: a bare or public-suffix wildcard such as `*.com`, `*.co.uk` or `*.com.my`, or a shared-hosting zone where other people's sites live, such as `*.github.io`, `*.pages.dev`, `*.workers.dev`, `*.vercel.app` or `*.amazonaws.com`.

A wildcard must sit under a domain you control: `*.example.com`, or list the exact hosts (`myorg.github.io`).

On the platform, a pass may make at most 50 `ctx.http` requests, and every request counts against the plan's monthly HTTP budget (see [Limits](/docs/reference/limits/#plans)). Spread larger batches across steps that sleep, or page through them over several runs.

There is no raw `fetch` in a hosted actuator; `ctx.http` is the way out.
