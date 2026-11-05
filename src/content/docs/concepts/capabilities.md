---
title: Capabilities and providers
description: An actuator declares the messaging, payment, LLM and HTTP capabilities it uses. Your own credentials back them, and they work only inside steps.
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
| `messaging` | `ctx.messaging` | Telegram Bot API (the default, free and live in two minutes), WhatsApp Cloud API (your own Meta app and WABA), Slack, Discord, email via Resend | You |
| `payment` | `ctx.payment` | Stripe, Chip, ToyyibPay, Billplz | You |
| `llm` | `ctx.llm` | Anthropic, OpenAI, Google, or any OpenAI-compatible API (OpenRouter, Groq, Together, DeepSeek, Mistral, Workers AI, a local Ollama), with your API key | You |
| `http` | `ctx.http` | Outbound `fetch` to domains you allow-list | You, per domain |

## Bring your own credentials

A provider is a small adapter that you configure with your own credentials: your Telegram bot token, your Stripe account, your LLM API key. Actuate stores the secret and injects a typed client into `ctx`. It never holds a platform-wide WhatsApp, payment or LLM account, so the account, the customer relationship and the policy risk stay with you (or your client).

Telegram is the default messaging channel because you can have a working bot with no business verification. Actuate supports WhatsApp from launch, and it suits a business that already has, or is setting up, its own WhatsApp Business account.

The adapters are open source in [`@actuate/providers`](https://github.com/actuate-run/actuate/tree/main/packages/providers), so the same clients run in `actuate dev` and on a self-hosted runtime with your keys from environment variables (see [`actuate providers`](/docs/reference/cli/#actuate-providers)). On the hosted platform you enter credentials in the dashboard, and Actuate encrypts them at rest.

The free Sandbox plan has no messaging, payment or LLM providers; see [Limits](/docs/reference/limits/#plans).

## Rules

- **Declared, not ambient.** Only declared capabilities appear on `ctx`, in the types and at runtime. `defineActuator` rejects an undeclared name in `capabilities`.
- **Configured before deploy.** On the platform, the deploy refuses an actuator whose declared capability has no provider configured. In the open-source runtime, the first call to an unconfigured capability throws: `ctx.payment is declared but no payment provider is configured`.
- **Optional when you can do without.** List a capability in `optionalCapabilities` instead, and it is on `ctx` but `undefined` when no provider is configured. It never blocks a deploy. For example, `await ctx.step.do("alert", () => ctx.messaging?.send("ops", text))`. `http` cannot be optional.
- **Only inside steps.** Every provider method call must happen inside `ctx.step.do`. A call outside a step throws an `ActuatorError`, because it would repeat on every [replay](/docs/concepts/steps-and-replay/). Inside a step, `send`, `createBill` and `refund` get an [idempotency key](/docs/concepts/steps-and-replay/#keys-on-provider-calls) automatically, so providers that deduplicate act once when the step is retried.

## messaging

```ts
await ctx.step.do("notify", () =>
  ctx.messaging.send(input.chatId, `Release ${input.tag} is out`),
);
```

`send(to, text, options?)` returns `{ id, channel }`. What `to` means depends on the provider:

| Provider | `to` |
| --- | --- |
| Telegram | A chat ID, for example `123456789`, or `-100123456789` for a group |
| WhatsApp | A phone number in international format, for example `60123456789` |
| Slack | A channel ID, for example `C0123456789` (the bot must be in the channel). With an incoming webhook instead of a bot token, Actuate ignores `to` |
| Discord | A channel ID. With a channel webhook instead of a bot token, Actuate ignores `to`. Messages are at most 2,000 characters, and never ping `@everyone` or roles |
| Email (Resend) | An email address |

Slack and Discord suit messages to you or your team, such as approval requests, alerts and reports. The options are:

| Option | Meaning |
| --- | --- |
| `channel` | Which channel sends, when several are configured: `"telegram"`, `"whatsapp"`, `"slack"`, `"discord"` or `"email"`. Without it, the default channel sends. See [Several channels](#several-channels) |
| `subject` | Email subject, when the channel is email |
| `template` | A WhatsApp template, `{ name, language, variables? }`, required for messages outside the 24-hour service window |
| `format` | `"text"` (default) or `"html"`. HTML means a small subset (`<b>`, `<i>`, `<a href>`, `<code>`, `<pre>`), used where the channel supports it (Telegram, email). Other channels get the text with tags removed |
| `idempotencyKey` | Actuate passes it to providers that deduplicate (Resend, and Discord with a bot token). It defaults to a key for this call, `<runId>:<step>:send:<n>`, where `n` counts the step's sends from 0. See [Deduplication by provider](#deduplication-by-provider) |

### Several channels

You can connect more than one messaging provider, for example WhatsApp for customers and Slack for your team. The first one is the default; `channel` picks another:

```ts
await ctx.step.do("tell-customer", () => ctx.messaging.send(input.phone, "Your refund is on its way"));
await ctx.step.do("tell-team", () => ctx.messaging.send("C0123456789", `Refunded ${input.orderId}`, { channel: "slack" }));
```

On the platform, connect each one under **Settings**, then **Providers**, and use **Make default** to choose the default. You can connect up to five channels. Locally, list them in `.dev.vars`, default first: `ACTUATE_MESSAGING=whatsapp,slack`. Sending on a channel that isn't configured fails the step with `No "slack" messaging channel is configured`. You can still have only one payment provider and one LLM provider.

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

`from` is in the form `send` accepts, so `ctx.messaging.send(reply.from, ...)` answers the same person. The runtime buffers a message nobody is waiting for, like any [event](/docs/concepts/sleeping-and-waiting/#posting-events), so a reply that arrives before the run starts waiting is not lost.

To set it up, point the provider at the actuator's provider webhook URL, which the dashboard shows under **Connect**, then **Receive messages** (`https://run.actuate.run/a/<id>/providers/<kind>/webhook`):

| Provider | Setup | Needed so messages can't be forged |
| --- | --- | --- |
| WhatsApp | In your Meta app, open WhatsApp, then Configuration, then Webhook. Paste the URL, enter your **Webhook verify token**, and subscribe to `messages` | The **App secret**. Actuate checks every delivery's `X-Hub-Signature-256`, and only messages to your configured phone number ID count |
| Telegram | Call `setWebhook` with the URL and `secret_token` set to your **Webhook secret token** | The **Webhook secret token**, which Actuate checks on every update |

Without the app secret or secret token, Actuate ignores inbound messages rather than trusting them. A WhatsApp number or Telegram bot has one webhook, so it delivers to one actuator; use a bot or number per actuator if several need replies. Locally, `actuate dev` serves the same route at `http://localhost:8787/providers/<kind>/webhook`; expose it with a tunnel.

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
| `refund?(request)` | Refund a paid bill in full, or in part with `amount`. It is optional, because not every provider supports it, so call it as `ctx.payment.refund?.(...)` |

`amount` is always in major units. Other `createBill` fields are `returnUrl` (where the payer goes after paying) and `idempotencyKey`.

`createBill` and `refund` requests get an idempotency key when you leave it out: `<runId>:<step>:createBill:<n>` or `<runId>:<step>:refund:<n>`, where `n` counts that method's calls in the step from 0. Stripe uses it, so a retried step gets the first checkout session or refund back instead of a second one. Chip, ToyyibPay and Billplz have no idempotency key, so a retried `createBill` there can make a second, unpaid bill, and a retried partial refund at Chip can refund twice. See [Deduplication by provider](#deduplication-by-provider).

**Payment webhooks become events.** When the provider reports a payment, it reaches the actuator as the event `payment.<referenceId>`, so a run can wait for it:

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

Check `status`, because a provider can report a failed or expired bill under the same key. For anything that matters, also check that `billId`, `amount` and `currency` match the bill you created, and use a reference nobody else can guess (for example include `ctx.runId`). The event key is only your reference, so this is what ties the payment to this bill. (The local fake provider under `actuate dev` sends no `billId` or `amount`.)

Stripe events take their reference only from the `actuate_reference_id` metadata that `createBill` sets on the Checkout Session, never from `client_reference_id`. Buyers can set that themselves on Payment Links and pricing tables, so it would let any payment on your account claim someone else's reference. Actuate ignores sessions that `createBill` didn't create.

ToyyibPay's callbacks are not signed, so Actuate never trusts what the callback says. It re-queries the transaction with your ToyyibPay credentials and builds the event only from that answer. The event key uses the re-queried transaction's reference, and the amount is the re-queried amount. Actuate rejects a callback that doesn't match a transaction on your account.

When you run locally with `actuate dev`, the payment provider is a fake. The bill's `url` points at your actuator's `/events/payment.<referenceId>`, so opening it in a browser "pays" the bill with the payload `{ provider: "dev", status: "paid", referenceId, via: "GET" }`. Messages appear in the terminal instead of being sent.

## Deduplication by provider

Inside a step, `send`, `createBill` and `refund` get a key per call when you pass none (see [keys on provider calls](/docs/concepts/steps-and-replay/#keys-on-provider-calls)). This is what each provider does with it:

| Provider | What a repeated key does |
| --- | --- |
| Stripe | Returns the first checkout session or refund. Keys last 24 hours |
| Resend | Returns the first email instead of sending again. Keys last 24 hours |
| Discord with a bot token | Returns the first message, but only within a few minutes |
| Discord webhooks, Telegram, WhatsApp, Slack | Nothing, so the message can be sent twice |
| Chip, ToyyibPay, Billplz | Nothing, so a second bill can be created, and a Chip partial refund can repeat |
| `actuate dev` fake payment | Returns the first bill or refund, like Stripe |

At Stripe and Resend, a repeated key with different parameters is an error, so build a step's requests from values that are the same on every attempt. Pass your own `idempotencyKey` only when calls in different steps or runs should count as one, such as `refund-${orderId}`.

Default keys require `@actuate/runtime` 0.3. On the hosted platform they apply once the platform runs that version.

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

**Any OpenAI-compatible API.** Choose **OpenAI-compatible API** and give its base URL (the part before `/chat/completions`, for example `https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1`), an API key and a default model. That covers OpenRouter, Groq, Together, DeepSeek, Mistral, Fireworks, Cloudflare Workers AI, and a local Ollama or vLLM server under `actuate dev` (`http://localhost:11434/v1`). The base URL must be `https://` (plain `http://` only for `localhost`) and use a hostname, not an IP address.

`complete` takes `model`, `system`, `prompt` or `messages` (`{ role: "user" | "assistant", content }[]`), `maxTokens` and `temperature`, and returns `{ text, model, usage? }`. Because the call is in a step, the journal stores its answer, and replays reuse the same text instead of asking again.

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
- `ctx.http` does not follow redirects. A `3xx` comes back as a response for you to inspect.
- An actuator cannot call its own URL, which stops webhook loops. Hostnames are compared case-insensitively and without a trailing dot, so `API.Example.com.` is the same host as `api.example.com`.
- `ctx.http` refuses IP addresses (`https://1.2.3.4/`, `https://[::1]/`) when you call them. Use a hostname.

On the platform, the deploy checks also cover `http.allow`. The platform refuses the deploy if the list:

- has more than 20 entries;
- contains an IP address or anything that isn't a hostname;
- names the platform itself (`actuate.run` or any subdomain);
- uses a wildcard that is too broad: a bare or public-suffix wildcard such as `*.com`, `*.co.uk` or `*.com.my`, or a shared-hosting zone where other people's sites live, such as `*.github.io`, `*.pages.dev`, `*.workers.dev`, `*.vercel.app` or `*.amazonaws.com`.

A wildcard must be under a domain you control, such as `*.example.com`. Otherwise, list the exact hosts (`myorg.github.io`).

On the platform, a pass may make at most 50 `ctx.http` requests, and every request counts against the plan's monthly HTTP budget (see [Limits](/docs/reference/limits/#plans)). Spread larger batches across steps that sleep, or page through them over several runs.

A hosted actuator has no raw `fetch`, so your code makes outbound requests through `ctx.http`.

## Keys and tokens

Providers keep their own credentials, but a service you call with `ctx.http` (an API key, a bot token, a Discord or Slack webhook URL) has no provider. Put its secret in `config`, and wrap the field in `secret()`:

```ts
import { defineActuator, secret, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  discordWebhookUrl: secret(z.string().url().describe("Discord webhook URL; treat it as a password")),
});

export default defineActuator({
  name: "price_watch",
  description: "Checks a price every hour and posts to Discord when it drops.",
  config: ConfigSchema,
  input: z.object({}),
  capabilities: ["http"],
  http: { allow: ["discord.com"] },
  cron: ["0 * * * *"],
  async run(ctx, _input, config) {
    await ctx.step.do("post", async () => {
      const res = await ctx.http.fetch(config.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Price dropped" }),
      });
      return { status: res.status };
    });
  },
});
```

`secret()` marks the field `writeOnly` in the config's JSON Schema. Use it on every field that holds a credential, at any depth: inside nested objects, arrays and records, and with `.optional()`, `.nullable()` or `.default()`. Your code gets the real value. What changes is where the value appears.

### Where to set the value

- On the platform, set it on the actuator's **Config** tab, and leave it out of `actuate.config.json`. The tab tags a secret field **Secret**. A text or number field becomes a password box saying **Set. Leave blank to keep.** or **Not set**, and any other secret field (an object, a list, a flag) becomes a JSON editor that starts empty, with the same placeholder. Neither the tab nor the API shows its value again. Type a new one to replace it, leave it blank to keep it, or click **Clear** to remove an optional one when you save (**Keep** undoes that).
- For `actuate dev`, put it in `.dev.vars`, which the starter's `.gitignore` already excludes, as `ACTUATE_CONFIG`, which holds a JSON object on one line. `actuate dev` merges it over `actuate.config.json` (objects key by key; anything else from `.dev.vars` wins), and its startup banner says the configuration came from both.

  ```bash title=".dev.vars"
  ACTUATE_CONFIG={"discordWebhookUrl":"https://discord.com/api/webhooks/123/abc"}
  ```

- On a self-hosted runtime, the configuration is the `ACTUATE_CONFIG` variable. Set it with `wrangler secret put ACTUATE_CONFIG` rather than under `vars`, whose values are in the wrangler file in plain text (see [Self-hosting](/docs/guides/self-hosting/)).

On the platform, a stored secret survives whatever configuration you send next, unless you change it on purpose. A configuration saved on the Config tab, with [`PUT /v1/actuators/:name/config`](/docs/reference/platform-api/#configuration), by `actuate deploy` or by a rollback that sends one:

- keeps a stored secret where the field is left out or sent as `null` (what the API shows in its place);
- replaces it where the field has a new value, and removes it where the field is `""`. Removing a required one fails validation;
- removes it with its object when the whole object around it is left out;
- keeps the secrets inside a list only while the list keeps its length. A list that grew or shrank keeps none of them, because they could end up on the wrong entry. The save says which list's secrets to enter again, as a warning on the Config tab and in the API's `warnings`, which `actuate deploy` prints when it uploads a new version.

A field counts as secret if any version of the actuator marked it with `secret()`, so rolling back to a version where it was a plain field doesn't expose it.

You commit `actuate.config.json` with your code. If it sets a value for a secret field and git would commit it (the project is a git repository and the file isn't ignored), `actuate check` (with or without `--platform`), `actuate deploy` (`--dry-run` included) and, once at startup, `actuate dev` warn, naming the fields:

```text
actuate.config.json:1:1  warn   actuate.config.json sets the secret field discordWebhookUrl, and git does not ignore the file, so it would be committed. Set it in the dashboard (Config tab) and leave it out of the file: the platform keeps a stored secret when the file omits it. For `actuate dev`, put it in .dev.vars as ACTUATE_CONFIG.  (config-secret)
```

It is a warning, never an error. Outside a git repository, they don't warn. See [the deploy checks](/docs/reference/cli/#the-deploy-checks).

### Redaction

The runtime replaces each occurrence of a secret field's value with `[secret]` in what it shows: run logs, step and run errors, step outputs and the run's output, the run records the [runtime's routes](/docs/reference/runtime-http/#secret-values) return, the approval queue and approval pages, approval messages sent to an approver, and `ctx.notifyOwner` messages. Under `actuate dev` and self-hosted, this works from the config schema and `ACTUATE_CONFIG`, with nothing to set up.

On the platform it applies wherever the platform shows run data: run pages and the approval queue in the dashboard, the [API](/docs/reference/platform-api/), the gateway's run routes, MCP results (receipts, `actuate_get_run`, `actuate_list_runs`, `actuate_cancel_run`), approval messages, [alerts](/docs/guides/alerts/) and `ctx.notifyOwner` messages. The platform redacts the values of every field any version of the actuator marked secret, so a field stays redacted after a later version drops `secret()`, including in runs pinned to the earlier version. The platform also redacts a secret field's default value, and doesn't show it in the dashboard or the API. A value you replace or clear stays redacted in earlier runs for as long as your plan keeps runs, so rotating a key doesn't expose the old one in runs that used it.

What is stored for replay keeps the real value, so a step that returned the key still returns it when the run replays. Redaction has limits:

- Redaction skips values shorter than 6 characters, and booleans. It treats a number as its digits, so it catches a 6-digit PIN and not a 4-digit one.
- Redaction catches a secret as it is, JSON-escaped (once or twice) and URL- or form-encoded. It doesn't catch it in base64, hashed, cut into pieces or otherwise changed.
- Log lines and errors are redacted when they are written. Step outputs and the run's output are stored as they are and redacted when read. Self-hosted and under `actuate dev`, that uses the secrets configured now: after you change a key, output stored before the change shows the old key.
- A schema that changes a secret's value, such as `secret(z.string().trim())` or a `.transform()`, gives your code a value that differs from the one you set, and only the value you set is redacted. Keep secret fields as plain as possible.
- Redaction doesn't apply to your own tables. `/tables`, the table browser and exports show what you wrote.
- Messages and requests you send through providers and `ctx.http` go out with the real value.
- `testActuator` from `@actuate/cli/testing` doesn't redact, so tests can assert on real values.

So treat redaction as a fallback. Don't log a secret, return it from a step, write it to a table or put it in the output.

### What else protects it

- On the platform, Actuate encrypts configuration at rest. Agent (run-scoped) tokens and MCP connections cannot read it. Anyone signed in to your dashboard, and a full API token, can read the other fields in plain text, but never a secret field's value. There is no way to show it again, so keep your own copy where you keep keys.
- Write-only protects a secret from agents, approvers and anyone reading runs. It doesn't protect it from your own account. Whoever has your dashboard login or a full token can deploy code that sends the value to any host in `http.allow`. Guard those like the key itself.
- `http.allow` limits where any request can go, so a leaked value can only be sent to the hosts you listed.
