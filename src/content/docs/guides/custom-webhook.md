---
title: Send messages to any URL
description: The custom webhook channel posts each message to a URL you choose, such as your own server, Zapier, n8n, ntfy or Google Chat, and lets that endpoint reply.
---

**Actuate POSTs each message to your URL. To reply, POST to the reply URL it gave you.**

The custom webhook is a messaging channel like Telegram or Slack, but the other end is any URL you choose. That can be your own server, Zapier, n8n, ntfy or Google Chat, among others. `ctx.messaging.send`, [alerts](/docs/guides/alerts/) and `ctx.notifyOwner` can all use it. Everything except the URL is optional. The channel is new in `@actuate/providers` 0.5, and locally and self-hosted it needs that version or later.

:::note[Not the Webhook trigger]
`POST /webhook` starts runs. This channel sends messages out, and replies come back to a separate reply URL with a separate secret. See [Triggers](/docs/concepts/triggers/#webhook).
:::

## Send your first message

On the hosted platform, messaging channels need the Maker or Agency plan. The Sandbox plan has none.

1. Get a URL that accepts a `POST` with a JSON body. For example, a Zapier **Catch Hook**, an n8n **Webhook** node, or a route on your own server.
2. In the dashboard, open **Settings**, then **Providers**. In the **messaging** group, open **Custom webhook**, paste the address into **URL**, and click **Connect Custom webhook**. Leave the other fields as they are.
3. Declare the capability in your actuator with `capabilities: ["messaging"]`. Then send from a step:

   ```ts
   await ctx.step.do("notify", () =>
     ctx.messaging.send("me", "Order 1042 is paid", { channel: "custom-webhook" }),
   );
   ```

   `channel` is needed only when another messaging channel is the default. See [Several channels](/docs/concepts/capabilities/#several-channels).

4. Your URL receives:

   ```json
   { "id": "msg_9c1d4e7a2b3f4c5d6e7f8a9b0c1d2e3f", "to": "me", "text": "Order 1042 is paid" }
   ```

   Read `to` and `text`, and answer with any `2xx` status. `to` is whatever you passed to `send`. Actuate doesn't check it, and most services ignore it.

That is all a one-way channel needs.

### Reply (optional)

To let your endpoint answer, give the channel a **Signing secret**. Click **Generate** next to the field, or make one yourself with `echo "whsec_$(openssl rand -base64 32)"`. From then on, messages you send with `ctx.messaging.send` in the `standard` format carry `replyUrl` in their body. A [template](#your-own-json-template) carries it only where you put `{{replyUrl}}`, and the [`text` format](#plain-text) never does:

```json
{
  "id": "msg_9c1d4e7a2b3f4c5d6e7f8a9b0c1d2e3f",
  "to": "me",
  "text": "Refund RM 120 for order 1042? Reply yes or no",
  "replyUrl": "https://run.actuate.run/a/<id>/providers/custom-webhook/webhook"
}
```

POST the answer there, with the signing secret as a bearer token:

```bash
curl -X POST "$REPLY_URL" \
  -H "Authorization: Bearer $CUSTOM_WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"from":"me","text":"yes"}'
```

The reply becomes the event `message.custom-webhook.me`, which a run can [wait for](#wait-for-a-reply). The dashboard also shows the address as **Reply URL** on the actuator's **Connect** tab, in the **Receive messages** card. Each actuator has its own reply URL, and each message carries the reply URL of the actuator that sent it, so one endpoint can serve several actuators.

Alerts and `ctx.notifyOwner` messages go out through your account's alert channel, and carry no `replyUrl`.

## Locally and self-hosted

`actuate dev` and the [self-hosted runtime](/docs/guides/self-hosting/) read the channel from environment variables, as for any [provider](/docs/reference/cli/#actuate-providers):

```bash title=".dev.vars"
ACTUATE_MESSAGING=custom-webhook
CUSTOM_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/123456/abcdef/
# Optional: signs messages and turns on replies
CUSTOM_WEBHOOK_SECRET=whsec_...

# Optional. Leave the format out to pick it automatically, or set it,
# for example for ntfy:
# CUSTOM_WEBHOOK_FORMAT=text
# Optional: your own JSON body, for example for Google Chat:
# CUSTOM_WEBHOOK_TEMPLATE={"text":"{{text}}"}
# Optional: a JSON body for approval requests only, on one line, such as
# one of the cards under "Approval requests"
# CUSTOM_WEBHOOK_APPROVAL_TEMPLATE={"type":"message","attachments":[...]}
# Optional: one extra header, for example for an API gateway in front of your server:
# CUSTOM_WEBHOOK_HEADERS="X-Api-Key: AbCdEf123"
```

`actuate dev` reads `.dev.vars` one line at a time, so there `CUSTOM_WEBHOOK_HEADERS` holds a single header. A self-hosted runtime takes several, one per line, when you set the variable with real line breaks:

```bash
printf 'X-Gotify-Key: AbCdEf123\nX-Team: ops\n' | npx wrangler secret put CUSTOM_WEBHOOK_HEADERS
```

Locally the reply URL is `http://localhost:8787/providers/custom-webhook/webhook`. If your endpoint runs on another machine, expose the port with a tunnel and set `ACTUATE_PUBLIC_URL` to the tunnel's address, so `replyUrl` points there (see [`actuate dev`](/docs/reference/cli/#actuate-dev)). The URL may be plain `http://` only for `localhost`, `127.0.0.1` and `[::1]`, so a receiver on `http://localhost:3000` works.

Self-hosted, set `ACTUATE_PUBLIC_URL` to the actuator's origin, as in [step 3 of Self-hosting](/docs/guides/self-hosting/#3-configure-wrangler). Until the runtime knows its origin, from that variable or from your first request made with `ACTUATE_TOKEN`, `replyUrl` is a path with no host.

## Settings

| Field | Variable | Required | Meaning |
| --- | --- | --- | --- |
| URL | `CUSTOM_WEBHOOK_URL` | Yes | Where messages go. Stored as a secret and masked in the dashboard, because many services put their key in the URL |
| Signing secret | `CUSTOM_WEBHOOK_SECRET` | No | `whsec_` and the base64 of 24 to 64 random bytes. **Generate** makes one. Signs every message and turns on replies. Without it, there is no signature and no `replyUrl`, and replies are ignored. Stored as a secret and masked |
| Extra headers | `CUSTOM_WEBHOOK_HEADERS` | No | Headers to send with every message, one `Name: value` per line. Stored as a secret and masked. See [Extra headers](#extra-headers) |
| Body format | `CUSTOM_WEBHOOK_FORMAT` | No | `standard`, `text` or `template`. Empty (**Automatic** in the dashboard) means `template` when a JSON template is set, and `standard` otherwise. See [Body formats](#body-formats) |
| JSON template | `CUSTOM_WEBHOOK_TEMPLATE` | With `template` | The JSON body to send, with placeholders. The dashboard offers starting points for common services |
| Approval JSON template | `CUSTOM_WEBHOOK_APPROVAL_TEMPLATE` | No | A JSON body used for approval requests only, whatever the body format, such as a card with **Approve** and **Reject** buttons. Questions use the body format. Empty means approvals use the body format too. See [Approval requests](#approval-requests) |

## Body formats

### Standard JSON

The `standard` format sends a JSON body (`content-type: application/json`), and an empty format picks it when no template is set. Its fields:

| Field | Meaning |
| --- | --- |
| `id` | The message ID, `msg_` and 32 hex characters. The same on every retry of the step, so you can [skip repeats](#skip-repeats) |
| `to` | What you passed to `send`, unchanged. It can be empty |
| `text` | The message, always as plain text |
| `html` | The original HTML, only when you sent with `format: "html"`. `text` then has the tags removed |
| `subject` | Only when you passed `subject` |
| `replyUrl` | Only when a signing secret is set. Where to POST [replies](#replies) |
| `approval` | Only on [approval and input requests](#approval-requests). The step that waits, and its signed links |

Zapier, n8n, Make, Pipedream, Node-RED and your own server all take this format as it is. In a Home Assistant automation with a webhook trigger, the message is `{{ trigger.json.text }}`.

### Plain text

The `text` format sends the message as a plain-text body (`content-type: text/plain; charset=utf-8`), with HTML tags removed. A `subject` goes in a `Title` header, on one line and cut at 1,024 characters. A subject with characters outside ASCII is sent RFC 2047-encoded (`=?UTF-8?B?...?=`), which ntfy decodes.

This suits [ntfy](https://ntfy.sh), which shows the body as the notification and the `Title` header as its title:

| Field | Value |
| --- | --- |
| URL | `https://ntfy.sh/<your topic>`, or your own ntfy server |
| Body format | `text` |
| Extra headers | Only for a protected topic, `Authorization: Bearer <access token>` |

On ntfy.sh anyone who knows a topic's name can read it, so pick a long random one, or use an access token. The body has no room for `replyUrl`, so an endpoint on this format that wants to reply uses the **Reply URL** from the Connect tab.

### Your own JSON template

The `template` format sends your own JSON body, for services that expect particular fields. Write the JSON with placeholders inside its strings:

| Placeholder | Replaced with |
| --- | --- |
| `{{text}}` | The message as plain text |
| `{{html}}` | The original HTML, when you sent with `format: "html"` |
| `{{subject}}` | The `subject` you passed |
| `{{to}}` | What you passed as `to` |
| `{{id}}` | The message ID |
| `{{replyUrl}}` | The reply URL, when a signing secret is set |
| `{{approveUrl}}`, `{{rejectUrl}}` | An [approval request](#approval-requests)'s signed links. Empty on other messages |
| `{{answerUrl}}` | A question's signed answer link. Empty on other messages |
| `{{expiresAt}}` | When an approval request's or question's links expire, in ISO 8601 (`2026-11-07T09:00:00.000Z`). Empty on other messages |

Actuate escapes each value for JSON, without adding quotes, so put each placeholder inside a JSON string, as in `"{{text}}"` or `"Order update: {{text}}"`. A value that is missing becomes an empty string. Actuate checks the template when you save it. An unknown placeholder, or a template that isn't valid JSON once filled in, is refused with the reason.

Templates for common services, which the dashboard also offers under **Start from** next to the field:

| Service | URL | Template |
| --- | --- | --- |
| Google Chat | The space's incoming webhook URL | `{"text":"{{text}}"}` |
| Mattermost | An incoming webhook URL | `{"text":"{{text}}"}` |
| Rocket.Chat | An incoming integration URL | `{"text":"{{text}}"}` |
| Gotify | `https://<your server>/message`, with the extra header `X-Gotify-Key: <app token>` | `{"title":"{{subject}}","message":"{{text}}"}` |
| Apprise API | `https://<your server>/notify/<key>` | `{"title":"{{subject}}","body":"{{text}}"}` |

Microsoft Teams takes messages through a Workflows flow (the **Post to a channel when a webhook request is received** template). Use the flow's URL with this template. The flow's schema requires `"contentUrl": null` on the attachment.

```json
{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"type":"AdaptiveCard","$schema":"http://adaptivecards.io/schemas/adaptive-card.json","version":"1.4","body":[{"type":"TextBlock","text":"{{text}}","wrap":true}]}}]}
```

Slack and Discord have their own providers, which also send to a channel webhook. Use those instead.

## Approval requests

`waitForApproval` and `waitForInput` with a `notify` recipient send their signed links through the channel like any message, and `text` holds your message followed by the links. The request also arrives as data, so your endpoint can show buttons instead of raw links. The links open Actuate's confirm page, where the person decides. Opening a link decides nothing, so link previews and scanners that fetch URLs are harmless.

In the `standard` format, the body carries an `approval` object:

```json
{
  "id": "msg_4b1f0c9e8d7a6b5c4d3e2f1a0b9c8d7e",
  "to": "me",
  "text": "Refund RM480 on ORD-1042?\n\nApprove: https://...\nReject: https://...",
  "subject": "Approval needed: refund_order",
  "approval": {
    "kind": "approval",
    "actuator": "refund_order",
    "step": "manager-ok",
    "message": "Refund RM480 on ORD-1042?",
    "approveUrl": "https://...",
    "rejectUrl": "https://...",
    "expiresAt": "2026-11-07T09:00:00.000Z"
  }
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `"approval"` for `waitForApproval`, `"input"` for `waitForInput` |
| `actuator`, `step` | The actuator and the step that waits |
| `message` | Your `message`, or the question for input, when there is one. Secret config values become `[secret]` |
| `approveUrl`, `rejectUrl` | The signed links, for an approval |
| `answerUrl` | The signed answer link, for a question |
| `expiresAt` | When the links stop working, in ISO 8601 |

Only Actuate's own approval and input requests set `approval`. The runtime drops it from messages your code sends with `ctx.messaging.send`, so an actuator can't fake an approval card. The other messaging providers ignore it, and the text carries the same links either way.

### Approval JSON template

A [template](#your-own-json-template) can place the links with `{{approveUrl}}`, `{{rejectUrl}}`, `{{answerUrl}}` and `{{expiresAt}}`, but a card with **Approve** and **Reject** buttons would show empty buttons on every other message. So put the card in **Approval JSON template** instead. Actuate uses it for approval requests only, whatever the body format. It checks it like the JSON template when you save it, and also refuses one that uses none of `{{approveUrl}}`, `{{rejectUrl}}` and `{{text}}` (which holds the links), so the links always reach your endpoint. Questions (`waitForInput`) go out in the body format, with the answer link in `text`, in `approval.answerUrl` (`standard`) and in `{{answerUrl}}` (`template`). Ordinary messages and alerts use the body format too.

For Microsoft Teams, use the Workflows URL from [above](#your-own-json-template) and an Adaptive Card with `Action.OpenUrl` buttons. As above, the attachment needs `"contentUrl": null`.

```json
{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"$schema":"http://adaptivecards.io/schemas/adaptive-card.json","type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"{{subject}}","weight":"Bolder","wrap":true},{"type":"TextBlock","text":"{{text}}","wrap":true},{"type":"TextBlock","text":"Links expire {{expiresAt}}","isSubtle":true,"size":"Small","wrap":true}],"actions":[{"type":"Action.OpenUrl","title":"Approve","url":"{{approveUrl}}"},{"type":"Action.OpenUrl","title":"Reject","url":"{{rejectUrl}}"}]}}]}
```

For Google Chat, use the space's incoming webhook URL and a `cardsV2` card with link buttons. Test it in your space first. Google's documentation doesn't say that incoming webhooks accept `cardsV2`. They are known to work, and other tools send them, but it isn't promised. If the space shows nothing, use `{"text":"{{text}}"}`, which carries the same links.

```json
{"text":"{{subject}}","cardsV2":[{"cardId":"approval","card":{"header":{"title":"{{subject}}","subtitle":"Links expire {{expiresAt}}"},"sections":[{"widgets":[{"textParagraph":{"text":"{{text}}"}},{"buttonList":{"buttons":[{"text":"Approve","onClick":{"openLink":{"url":"{{approveUrl}}"}}},{"text":"Reject","onClick":{"openLink":{"url":"{{rejectUrl}}"}}}]}}]}]}}]}
```

The dashboard offers both under **Start from**, next to the field.

Send approvals only to an endpoint that shows them to a person. Anyone who holds a link can decide, so an agent behind the URL, like the one in the [example below](#example-an-agent-on-your-own-machine), could approve its own request. For approvals meant for you, [`notify: "owner"`](/docs/concepts/approvals/#send-the-links-to-yourself) emails them and never sends them to a custom webhook.

## Extra headers

Some services want a key in a header rather than in the URL. Put one `Name: value` per line:

```text
X-Gotify-Key: AbCdEf123
```

Common uses:

- Gotify's `X-Gotify-Key`, an ntfy access token (`Authorization: Bearer ...`), or n8n's header auth.
- A [Cloudflare Access](#example-an-agent-on-your-own-machine) service token, as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- An API gateway's key.

The rules:

- At most 20 headers, each named once.
- Values are plain ASCII (or Latin-1), with no control characters.
- `Content-Type` replaces the format's own.
- `Host`, `Content-Length`, `Transfer-Encoding`, `Connection` and any header starting with `webhook-` are refused. The `webhook-` headers are Actuate's.
- Actuate stores them as a secret, and never shows their values in errors or logs. An error about a header names its line number, not what the line says.

## Verify the signature

Every message carries the `webhook-id` and `webhook-timestamp` headers from the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) spec. With a signing secret, it also carries `webhook-signature`:

```text
webhook-id: msg_9c1d4e7a2b3f4c5d6e7f8a9b0c1d2e3f
webhook-timestamp: 1762430400
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
```

`webhook-id` is the message ID and `webhook-timestamp` is in Unix seconds. `webhook-signature` is `v1,` and the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the secret's bytes (the base64 after `whsec_`).

Check it, so nobody else can post fake messages to your URL. In Node, use the official `standardwebhooks` package (`npm install standardwebhooks`):

```js title="server.mjs"
import { createServer } from "node:http";
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.CUSTOM_WEBHOOK_SECRET); // "whsec_..."

createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  // Join the bytes before decoding, so a character split across chunks stays whole.
  const body = Buffer.concat(parts).toString("utf8");

  let message;
  try {
    // Checks the signature and that the timestamp is within 5 minutes, then parses the JSON.
    message = wh.verify(body, req.headers);
  } catch {
    res.writeHead(401).end();
    return;
  }

  console.log(`To ${message.to}: ${message.text}`);
  res.writeHead(200).end();
}).listen(3000);
```

Verify the body exactly as it arrived. Parsing the JSON and serialising it again changes the bytes, and the signature no longer matches. The Standard Webhooks project also publishes libraries for Python (`pip install standardwebhooks`), Go (`github.com/standard-webhooks/standard-webhooks/libraries`) and other languages.

## Skip repeats

A step that fails is retried, and so is a send whose answer didn't arrive in time. So your URL can get the same message twice, for example when it acted on a message but took longer than 10 seconds to answer.

A message sent from a step has the same `id` (and `webhook-id`) on every retry of that step, so keep the IDs you have handled and skip one you've seen, answering `2xx` again:

```js
const seen = new Set(); // use a database in production

if (seen.has(message.id)) return res.writeHead(200).end();
seen.add(message.id);
```

The ID comes from the call's [idempotency key](/docs/concepts/steps-and-replay/#keys-on-provider-calls), so passing your own `idempotencyKey` gives the same ID across steps or runs. [Retrying a failed run](/docs/guides/retry-and-rollback/) from the dashboard adds `:retry<n>` to the keys Actuate derived, so its messages get new IDs. A key you passed yourself stays as it is.

Alerts and `ctx.notifyOwner` messages are sent without an idempotency key, so each gets a random ID. If the platform sends one again, the ID is different, and these IDs can't be used to skip repeats.

If your endpoint answers `2xx` with a JSON object that has a string `id`, Actuate uses that (up to 256 characters) as the message's receipt ID. Otherwise the receipt ID is the message ID.

## Replies

Replies need a signing secret. POST JSON to the `replyUrl` from the message (or the **Reply URL** from the Connect tab), and prove you know the secret in either of two ways:

- **`Authorization: Bearer <secret>`.** The simplest, as in the [curl above](#reply-optional).
- **A Standard Webhooks signature**, with `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, made the same way as Actuate's. The secret never travels, so prefer it from code:

  ```js
  import { Webhook } from "standardwebhooks";

  const wh = new Webhook(process.env.CUSTOM_WEBHOOK_SECRET);
  const id = `reply_${crypto.randomUUID()}`;
  const now = new Date();
  const body = JSON.stringify({ from: "me", text: "yes" });

  await fetch(message.replyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": wh.sign(id, now, body),
    },
    body,
  });
  ```

Anything else gets `401`, with an `error` that says why. The body of a reply:

| Field | Required | Meaning |
| --- | --- | --- |
| `from` | Yes | Who is replying, 1 to 256 characters after trimming. A number is turned into a string. It names the event, `message.custom-webhook.<from>` |
| `text` | No | The reply. Defaults to `""` |
| `id` | No | Your message ID, a string or a number. Defaults to the `webhook-id` header, or a random ID |
| `at` | No | When it was sent, in milliseconds since the epoch. Defaults to now |
| `name` | No | The sender's display name |
| `type` | No | Defaults to `"text"` |

Actuate answers `200` with the event and the runs it resumed, the same locally and on the platform:

```json
{ "event": "message.custom-webhook.me", "resumed": ["run_..."], "buffered": false }
```

A message nobody is waiting for is buffered for the next wait, like any [event](/docs/concepts/sleeping-and-waiting/#posting-events), and the answer has `"resumed": []` and `"buffered": true`.

Some replies are ignored, and the answer is `200` with `{"ignored":true}`:

- Every reply, when the channel has no signing secret.
- A body that isn't JSON.
- A body without `from`, or with a `from` that is empty or longer than 256 characters.

If the custom webhook isn't set up at all, the platform answers `404`, and `actuate dev` answers `401`.

### Wait for a reply

The reply arrives as an [`InboundMessage`](/docs/reference/sdk/#inboundmessage) with `channel: "custom-webhook"`:

```ts
import type { InboundMessage } from "@actuate/sdk";

await ctx.step.do("ask", () =>
  ctx.messaging.send("me", `Refund RM ${input.amount} for order ${input.orderId}? Reply yes or no`, { channel: "custom-webhook" }),
);
const reply = await ctx.step.waitForEvent<InboundMessage>("answer", {
  event: "message.custom-webhook.me",
  timeout: "1 day",
});
if (reply?.text.trim().toLowerCase() === "yes") {
  // refund
}
```

Reply with the `to` you were sent as `from`, so the reply lands on the event the run waits for, and so `ctx.messaging.send(reply.from, ...)` reaches the same person.

## Security

- **The URL is a secret.** Actuate stores it encrypted, masks it in the dashboard, and never puts it in errors or logs. Anyone with a Google Chat, Mattermost or Zapier hook URL can post to it.
- **HTTPS only.** `http://` works only for `localhost`, `127.0.0.1` and `[::1]`. The URL must use a hostname, not an IP address, and can't contain a username or password.
- **No redirects.** Actuate never follows one, because it could carry the signed message somewhere else. A `3xx` answer fails the send with "redirects are not followed; use the final URL", so give the URL the redirect points to.
- **No loops.** The URL can't point at the actuator itself. Actuate refuses a URL with the same host and port as the actuator's reply URL. On the platform, Actuate also refuses any URL on `actuate.run` or the platform's own hosts, when you save the provider and again when it sends. The platform checks every provider URL you choose this way, and for providers that follow redirects, it also checks every redirect.
- **Check the signature** on your server, and reject anything unsigned, so a leaked URL alone can't feed you fake messages.
- **A replayed reply counts again.** Actuate doesn't deduplicate replies, so the same signed request sent twice within the 5 minutes its timestamp is valid delivers two events. If a second answer would do harm, have your actuator ignore it, for example by stopping after the first `waitForEvent`.
- **The services you use see the messages.** Zapier, n8n and the like keep a history of what they receive. Don't put secrets in messages.

## Limits

| What | Limit |
| --- | --- |
| Time for your URL to answer | 10 seconds. After that the send fails and the step is retried, with the same message ID |
| Answer Actuate reads | The first 64 KB |
| Error message quoted from your answer | About 500 characters |
| URL | 2,048 characters |
| Extra headers | 20 |
| JSON template, approval JSON template | 16,384 characters each |
| `Title` header (`text` format) | 1,024 characters |
| `from` in a reply | 256 characters |
| Replies to the platform's reply URL | About 120 requests a minute per actuator, then `429`. At most 256 KB per body, then `413` |
| Alerts sent to the channel | The subject, a blank line and the text, cut at 1,900 characters, as on every [alert channel](/docs/guides/alerts/#where-alerts-go). The subject also comes as `subject` |
| Microsoft Teams (Workflows) | 28 KB per message, and 4 requests a second |

Any answer that isn't `2xx` fails the send with the status and your endpoint's error message, such as the `error` or `message` field of a JSON body. An HTML error page is replaced with the status text. An answer of `401`, or a `400` or `403` whose message says the credentials are bad (such as "invalid token" or "unauthorized"), counts as rejected credentials, so the platform sends a [`provider_auth` alert](/docs/guides/alerts/#what-you-are-alerted-about).

## Example: an agent on your own machine

Say an agent runs on a mini PC at home, and it owns a chat bridge that Actuate never sees. Actuators hand messages to the agent through this channel, and the agent posts replies back.

1. Run a small server on the mini PC, like the one in [Verify the signature](#verify-the-signature), on port 3000. It passes `text` on to the bridge and posts answers to `replyUrl`.
2. Expose it with a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), so the machine needs no open port. `cloudflared tunnel --url http://localhost:3000` prints a temporary `https://<random>.trycloudflare.com` address to try it. For good, create a named tunnel on your own domain, which keeps its address.
3. Optionally, protect the hostname with Cloudflare Access and a service token, and put the token in **Extra headers**:

   ```text
   CF-Access-Client-Id: <client id>.access
   CF-Access-Client-Secret: <client secret>
   ```

4. Add the custom webhook with the tunnel's address as the URL, and generate a signing secret. Put the same secret on the mini PC.

If the bridge uses a personal WhatsApp account, note that such bridges are unofficial and against WhatsApp's terms. For business messaging, use the [WhatsApp provider](/docs/concepts/capabilities/#messaging), which uses the WhatsApp Cloud API.
