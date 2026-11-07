---
title: Approve from chat
description: Put Approve and Reject buttons on approval messages in Telegram, Slack and Discord, and let a custom webhook's receiver decide from your own server.
---

When a [`waitForApproval`](/docs/concepts/approvals/) sends its links through Telegram, Slack or Discord, the message can also carry **Approve** and **Reject** buttons. One click decides the step in the chat. Actuate checks the click with the chat app's signature, edits the message to say who decided, and resumes the run with a verified record of who clicked. A [custom webhook](/docs/guides/custom-webhook/) receiver can decide the same way from [your own server](#decide-from-your-own-server).

Buttons are new in `@actuate/sdk`, `@actuate/runtime` and `@actuate/providers` 0.5, and need `@actuate/cli` 0.5 for clicks under `actuate dev`. The signed links stay in every message, so a chat client that can't show buttons still gets them.

```ts
const decision = await ctx.step.waitForApproval("manager-ok", {
  message: `Refund RM${input.amount} on ${input.orderId}?`,
  notify: { to: config.managerChatId, channel: "telegram" },
  timeout: "1 day",
});
```

Your code doesn't change. Whether the message gets buttons, and which kind, depends only on the provider's settings.

## What the approver sees

The message shows your `message`, then the **Approve** and **Reject** links as text, then two buttons. A button is one of two kinds:

- **Interactive buttons** decide in the chat. The person clicks, and the message changes to "Approved by Wei Tan at 14:02 UTC".
- **Link buttons** open the same confirm page as the links in the text, where the person decides as with any [signed link](/docs/concepts/approvals/#how-the-links-work). They need no setup beyond the provider itself.

Each provider sends interactive buttons when it can verify the clicks, and link buttons otherwise:

| Provider | Interactive buttons need | Without them |
| --- | --- | --- |
| Telegram | A **Webhook secret token**, and the bot's webhook set to receive `callback_query` updates | Link buttons. Under `actuate dev` on `localhost`, the links come as text only, because Telegram refuses buttons that point at `localhost` |
| Slack | A **Signing secret**, and the app's **Interactivity** Request URL. The bot token and the incoming webhook URL both work | Link buttons |
| Discord | The **Bot token** and the **Public key**, and the application's **Interactions Endpoint URL** | Link buttons, when every link is at most 512 characters, and the links as text only otherwise. A channel webhook can only send link buttons |

On Slack and Discord, **Approve** is green and **Reject** is red. Actuate sends Slack messages as Block Kit, with the plain text as the notification. When a chat app refuses the buttons, Actuate sends the message again without them. It does this when Telegram answers `400` about a link button or its URL, when Slack answers `invalid_blocks`, `invalid_blocks_format` or `msg_blocks_too_long`, and when Discord answers `400` to a message with buttons. Any other error fails the delivery as usual.

Buttons only appear on approvals sent to a `notify` recipient through your messaging channels. With [`notify: "owner"`](/docs/concepts/approvals/#send-the-links-to-yourself), the links reach you by email and on your alert channel, without buttons. WhatsApp and email (Resend) carry the links as text.

### Questions

A question from [`waitForInput`](/docs/concepts/approvals/#asking-for-input) gets one **Answer** link button on Telegram, Slack and Discord, which opens the answer form. There is no interactive version, because the person types the answer on the form. On Discord, the 512-character rule applies to it too.

## Set up Telegram

### On the platform

1. In the dashboard, open **Settings**, then **Providers**, and open **Telegram Bot** in the **messaging** group. Paste the **Bot token** from [@BotFather](https://t.me/BotFather). Click **Generate** next to **Webhook secret token**, then save.
2. Under the Telegram provider, pick an actuator in **Connect the bot to** and click **Connect**. Actuate calls Telegram's `setWebhook` for you, with your secret token and with both the `message` and `callback_query` updates.
3. Optionally, fill in **Approvers** with Telegram user IDs. See [Approver lists](#approver-lists).

A Telegram bot has one webhook, so the bot's messages reach only the actuator you connected. Button clicks for your other actuators arrive there too. Actuate forwards each click to the actuator that sent the message, so one bot serves the buttons of all your actuators. To move the bot to another actuator, pick it and click **Connect** again.

**Connect** refuses when the provider has no webhook secret token. Update the provider with one first.

### Self-hosted and locally

Set the variables, in `.dev.vars` for `actuate dev` or as Worker secrets:

```bash title=".dev.vars"
ACTUATE_MESSAGING=telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
# 1 to 256 characters of A-Z, a-z, 0-9, _ and -
TELEGRAM_WEBHOOK_SECRET_TOKEN=...
# Optional. Who may press Approve and Reject
TELEGRAM_APPROVERS=123456789
```

Then point the bot at the actuator, with both update types:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="$ACTUATE_PUBLIC_URL/providers/telegram/webhook" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET_TOKEN" \
  -d allowed_updates='["message","callback_query"]'
```

Telegram keeps the update types from your last `setWebhook` call when you leave `allowed_updates` out. A bot set up earlier for `message` alone never sends the clicks, so call `setWebhook` again with both.

Under `actuate dev`, expose port 8787 with a tunnel and set `ACTUATE_PUBLIC_URL` to the tunnel's address. Self-hosted, wire `providerInteractions` into `createRuntime`, as in [Self-hosting](/docs/guides/self-hosting/#5-providers).

### Find your Telegram user ID

Approver lists take numeric user IDs, not @usernames or group chat IDs.

- In a private chat with your bot, your user ID is the same number as the chat ID, which you may already pass as `notify`.
- In a group, send the bot a command meant for it, such as `/start@<bot username>`, before you set its webhook. Then open `https://api.telegram.org/bot<bot token>/getUpdates` and read `message.from.id`. Telegram answers `getUpdates` only while the bot has no webhook. An ordinary message won't show, because in a group Telegram's [privacy mode](https://core.telegram.org/bots/features#privacy-mode) gives a bot only commands for it and replies to its messages.
- Once someone has clicked, the run's result names them, as in `telegram:123456789 (Wei Tan)`. The number is their user ID.

## Set up Slack

Use a Slack app that only Actuate uses. A Slack app has one Interactivity Request URL, so an app that already sends its clicks to another service can't send them to Actuate as well.

### On the platform

1. In your app at [api.slack.com/apps](https://api.slack.com/apps), open **Basic Information** and copy the **Signing Secret**.
2. In the dashboard, open **Settings**, then **Providers**, and add or update **Slack** with your bot token or incoming webhook URL and the **Signing secret**. Save.
3. Under the Slack provider, copy the **Interactivity Request URL**. It looks like `https://run.actuate.run/t/<route id>/providers/slack/interactions`.
4. In your Slack app, open **Interactivity & Shortcuts**, turn **Interactivity** on, paste the URL as the **Request URL** and save.
5. Optionally, fill in **Approvers** with member IDs.

The Interactivity Request URL belongs to your account, not to one actuator. One Slack app serves all your actuators, and Actuate sends each click to the actuator that sent the message. The URL keeps working when you delete an actuator, and stays the same when you update the provider. If you remove the provider and add it again, it gets a new URL and the old one answers `404`, so paste the new one into the app. The URL isn't a secret. Knowing it grants nothing, because Actuate checks every request's signature with your signing secret.

### Self-hosted and locally

Set `SLACK_SIGNING_SECRET`, and optionally `SLACK_APPROVERS`, next to `SLACK_BOT_TOKEN` or `SLACK_WEBHOOK_URL`. Set the app's Request URL to `https://<your origin>/providers/slack/webhook`, or to your tunnel's address under `actuate dev`. Each self-hosted actuator has its own URL, so give each one its own Slack app.

### Find member IDs

In Slack, open the person's profile, click the **⋯** button, then **Copy member ID**. Member IDs start with `U` or `W`.

## Set up Discord

Interactive buttons need a bot token. Through a channel webhook, Discord shows only link buttons.

Once an application has an **Interactions Endpoint URL**, Discord sends all its interactions there and stops sending them over the Gateway. Slash commands and buttons that another bot handles on the same application stop reaching that bot, so use an application that only Actuate uses. Actuate answers any other interaction for the application with "This app only handles Actuate approval buttons."

### On the platform

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open your application's **General Information** and copy the **Public Key**.
2. In the dashboard, open **Settings**, then **Providers**, and add or update **Discord** with the **Bot token** and the **Public key**. Save it before the next step, because Discord checks the URL as soon as you save it in the Developer Portal.
3. Under the Discord provider, copy the **Interactions Endpoint URL**. It looks like `https://run.actuate.run/t/<route id>/providers/discord/interactions`.
4. Back in **General Information**, paste it into **Interactions Endpoint URL** and save. Discord sends a signed test request, and Actuate answers it when your account has at least one active actuator.
5. Optionally, fill in **Approvers** with user and role IDs.

As with Slack, the URL belongs to your account and serves all your actuators. Removing the provider and adding it again makes a new URL, which you paste into the application again.

### Self-hosted and locally

Set `DISCORD_PUBLIC_KEY` (64 hex characters, not a secret) next to `DISCORD_BOT_TOKEN`, and optionally `DISCORD_APPROVERS`. Set the Interactions Endpoint URL to `https://<your origin>/providers/discord/webhook`, or to your tunnel's address under `actuate dev`.

### Find user and role IDs

In Discord, open **User Settings**, then **Advanced**, and turn on **Developer Mode**. Then right-click a user and click **Copy User ID**, or right-click a role and click **Copy Role ID**. Find roles in **Server Settings**, then **Roles**, or right-click a role mention in a message. Write a role as `role:<role ID>`, for example `role:1201122334455667788`. Discord sends the clicker's roles only for messages in a server, so role entries don't match in direct messages.

## Approver lists

Each chat provider has an optional **Approvers** field. List up to 100 IDs, separated by spaces or commas:

| Provider | Variable | Entries |
| --- | --- | --- |
| Telegram | `TELEGRAM_APPROVERS` | Numeric user IDs, such as `123456789` |
| Slack | `SLACK_APPROVERS` | Member IDs, such as `U01ABC2DEF` |
| Discord | `DISCORD_APPROVERS` | User IDs, and roles as `role:<role ID>` |
| Custom webhook | `CUSTOM_WEBHOOK_APPROVERS` | The `by.id` values your server sends, up to 64 characters each, with no spaces or commas |

Actuate checks the list when you save the provider, or when the runtime reads the variables, and refuses it with the entries it doesn't accept.

Without a list, anyone who can see the message can click. With one, a click from anyone else decides nothing, and that person sees "You're not on the approver list for this."

**An approver list restricts the buttons, not the links.** The signed links stay in every message, and anyone who holds one can still open it and decide on the confirm page. A list stops a stranger in a group chat from clicking **Approve**, but anyone who can read the message can still copy a link. If only the listed people should decide, send the approval to a chat that only they can read.

A list applies to every approval the provider sends. You can't narrow it for one step.

## After a click

| What happened | What people see |
| --- | --- |
| The first click on an approval that is still waiting | Actuate edits the message for everyone. It removes the links and the buttons, and adds "Approved by Wei Tan at 14:02 UTC" or "Rejected by Wei Tan at 14:02 UTC" |
| A click after a button decided the step | Only the clicker sees "Already approved by Wei Tan" |
| A click after the step was decided in the dashboard, through the API or with a link | Only the clicker sees "Already approved in the dashboard", "Already approved through the API" or "Already approved with a link". It never names who decided that way |
| A click after the step timed out, or after the run was cancelled | Only the clicker sees "This request has expired or was already decided." |
| A click from someone not on the approver list | Only the clicker sees "You're not on the approver list for this." |
| A click on a button another account's actuator sent | Only the clicker sees "This button belongs to another actuator." |

The time is in UTC, and the name is the clicker's display name in the chat app. On Telegram, a note only the clicker sees is a short pop-up. On Slack and Discord, it is an ephemeral message.

When two people click at the same moment, the first click decides, and the second person sees "Already approved by …". A step decided through a link, the dashboard or the API keeps its buttons in the chat, and a click on them gives an "Already" note that says how it was decided.

Actuate records the decision at once and resumes the run in the background, so the chat app gets its answer within its deadline, which is 3 seconds for Slack and Discord. If Discord still shows "This interaction failed", the decision stands.

On the platform, a click for a paused actuator decides nothing, and the links still work. On the paused actuator's own Telegram webhook or Reply URL, the click always gets "This request has expired or was already decided." A Slack or Discord click arrives through your account's Interactions URL. It gets the same answer when your account has another active actuator to answer it. With no active actuator, the platform answers `404`, and Slack or Discord shows the clicker an error.

### A click reaches the right actuator

On the platform, Slack and Discord send every click to your account's Interactions URL, and Telegram sends it to the connected actuator. The actuator that receives a click checks it with your credentials. It then forwards the click once to the actuator that sent the message, if that actuator is in your account and active. That actuator checks the click again before it decides. A click on a button from another account's actuator decides nothing.

Self-hosted, each actuator has its own URL and takes only its own clicks.

## Who decided

A button decision resolves to `{ approved, at, by, via: "chat" }`, with no `note`:

```ts
const decision = await ctx.step.waitForApproval("manager-ok", {
  message: `Refund RM${input.amount} on ${input.orderId}?`,
  notify: config.managerChatId,
});
// A custom webhook decision is "chat" too, but its receiver asserts `by`.
const verified = decision?.via === "chat" && !decision.by?.startsWith("custom-webhook:");
if (verified) {
  await ctx.step.do("audit", () =>
    ctx.db.sql`INSERT INTO approvals (run_id, approved, by) VALUES (${ctx.runId}, ${decision.approved}, ${decision.by ?? null})`,
  );
}
```

`by` is the channel and the clicker's user ID, then their display name in brackets when the chat app gives one:

| Channel | `by` | The name is |
| --- | --- | --- |
| Telegram | `telegram:123456789 (Wei Tan)` | Their first and last name, or their @username |
| Slack | `slack:U01ABC2DEF (alice)` | Their Slack user name |
| Discord | `discord:80351110224678912 (Alice)` | Their display name, or their username |
| Custom webhook | `custom-webhook:alice (Alice Tan)` | The `by.name` your server sent |

The chat app's signature proves the user ID. The name is whatever the person chose in the chat app, so match on the ID. Through a custom webhook, your server asserts both, as [below](#decide-from-your-own-server), so `via: "chat"` alone doesn't mean a verified person. Where that matters, also check that `by` doesn't start with `custom-webhook:`, as the sample does. Actuate cuts the ID at 64 characters and the name at 60.

Decisions through a link, the dashboard or the API keep their `via` values, `"link"`, `"dashboard"` and `"api"`. See [Who decided](/docs/concepts/approvals/#who-decided). Answers to questions never have `via: "chat"`, because they come from the form.

## Decide from your own server

A [custom webhook](/docs/guides/custom-webhook/) receiver can decide an approval itself, for example from **Approve** and **Reject** buttons in its own UI, without opening a link. It needs a **Signing secret** on the channel.

With a signing secret, the `approval` object in an approval request's `standard` body carries `decide`:

```json
{
  "id": "msg_4b1f0c9e8d7a6b5c4d3e2f1a0b9c8d7e",
  "to": "me",
  "text": "Refund RM480 on ORD-1042?\n\nApprove: https://...\nReject: https://...",
  "approval": {
    "kind": "approval",
    "actuator": "refund_order",
    "step": "manager-ok",
    "message": "Refund RM480 on ORD-1042?",
    "approveUrl": "https://...",
    "rejectUrl": "https://...",
    "expiresAt": "2026-11-07T09:00:00.000Z",
    "decide": {
      "approve": "ap1:act_9fQ2xLm0Rk3TzW7a:q3Jx8Kd0Lm2Pz7Yw:a",
      "reject": "ap1:act_9fQ2xLm0Rk3TzW7a:q3Jx8Kd0Lm2Pz7Yw:r",
      "url": "https://run.actuate.run/a/act_9fQ2xLm0Rk3TzW7a/providers/custom-webhook/webhook"
    }
  }
}
```

`approve` and `reject` are opaque values of at most 47 characters. `url` is the actuator's Reply URL. This example is from the platform, where the values name the actuator's ID. Self-hosted, they say `local` instead, as in `ap1:local:q3Jx8Kd0Lm2Pz7Yw:a`. In a [template](/docs/guides/custom-webhook/#your-own-json-template), the values are `{{approvePayload}}` and `{{rejectPayload}}`, which are empty without a signing secret. Questions never carry `decide`.

To decide, POST one of the two values to `url`, with the same auth as a [reply](/docs/guides/custom-webhook/#replies), and name the person who decided:

```bash
curl -X POST "$REPLY_URL" \
  -H "Authorization: Bearer $CUSTOM_WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"decision":"ap1:act_9fQ2xLm0Rk3TzW7a:q3Jx8Kd0Lm2Pz7Yw:a","by":{"id":"alice","name":"Alice Tan"}}'
```

| Field | Required | Meaning |
| --- | --- | --- |
| `decision` | Yes | `approval.decide.approve` or `approval.decide.reject` from the message, unchanged |
| `by.id` | Yes | Who decided, as your server knows them. 1 to 64 characters, with no spaces or commas. A number becomes a string |
| `by.name` | No | Their name, at most 60 characters |

The answer is always JSON. Show `message` to the person, or use `status` and `decision` to update your own UI. The answer never holds a link or a decision value.

| Status | Body |
| --- | --- |
| `200` | `{"status": "decided", "decision": "approved", "by": "custom-webhook:alice (Alice Tan)", "at": "2026-11-06T14:02:11.000Z", "message": "Approved by Alice Tan at 14:02 UTC"}`. `decision` is `"approved"` or `"rejected"` |
| `200` | `status` is `"already"`, with `decision`, `by`, `at` and `message`, such as "Already approved by Alice Tan", when another decision from your server or a chat button decided the step before. After a link, the dashboard or the API, `by` is left out, and `message` is "Already approved with a link", "Already approved in the dashboard" or "Already approved through the API" |
| `200` | `{"status": "expired"}` or `{"status": "unknown"}`, with the message "This request has expired or was already decided." |
| `200` | `{"status": "not-approver"}`, with the message "You're not on the approver list for this.", when `by.id` isn't in **Approvers** |
| `200` | `{"status": "foreign"}`, with the message "This button belongs to another actuator." |
| `400` | `status` is `"invalid"`, with a `message` that says what is wrong, for a `decision` that isn't one of the two values, or a missing or malformed `by` |
| `401` | The auth is wrong or missing |

The run resumes with `{ approved, at, by: "custom-webhook:alice (Alice Tan)", via: "chat" }`.

**Your server asserts `by`.** Actuate checks the signing secret, so it knows the request came from your server, but it can't check who the person was. Let your server decide only for people it has signed in itself, and keep the secret on the server. **Approvers** (`CUSTOM_WEBHOOK_APPROVERS`) lists the `by.id` values allowed to decide this way. Without it, any `by.id` your server sends can decide.

A body without `decision` is an ordinary reply. On the platform, Actuate forwards a decision for another actuator in your account to that actuator, as for chat buttons. Approvals with `notify: "owner"` never go to a custom webhook, so nobody can decide your own approvals this way.

## Security

- **Actuate verifies every click.** Telegram must send your secret token in `X-Telegram-Bot-Api-Secret-Token`. Slack must sign the request with your signing secret (`X-Slack-Signature`), and Discord with your application's key (`X-Signature-Ed25519`), both within 5 minutes. A custom webhook decision needs your signing secret, as a bearer token or a Standard Webhooks signature. Anything else gets `401` and decides nothing.
- **The links still decide.** Buttons add a way to decide without removing the links. An agent that reads the chat, or anyone who can see the message, can open a link and decide, whatever the approver list says. Send approvals only to chats that no agent reads.
- **Agents never see the buttons' values.** Each approval gets a random value that works once and expires with the links. Actuate hands it only to the messaging provider. It never appears in run logs, step outputs, receipts or anything a run token reads. Your code can't send approval buttons either, because the runtime removes `approval` from messages sent with `ctx.messaging`.
- **A button decides only through the channel that sent it.** Nobody can replay a value copied from a Slack message through the custom webhook's Reply URL, where your server asserts `by`, so the value can't get around Slack's approver list. If the message couldn't be sent, its buttons decide nothing.
- **Display names aren't verified.** Only the user ID in `by` is. Write approver lists with IDs, and match on IDs in your code.
- **The Interactions URL isn't a secret.** It only says which account a request is for. The signature checks keep fake clicks out.
