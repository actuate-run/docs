---
title: Human approvals and input
description: Pause a run until a person approves, rejects or answers a question through a signed, single-use link.
---

Two steps pause a run until a person acts on a signed link: `waitForApproval` for a yes or no, and [`waitForInput`](#asking-for-input) for a short written answer.

`ctx.step.waitForApproval` pauses a run until a person clicks **Approve** or **Reject** on a signed link or, in Telegram, Slack and Discord, on a [button in the chat](/docs/guides/approval-buttons/), or until the timeout passes. Use it for money above a threshold, a message to a customer, or anything you want a human to sign off.

```ts
const decision = await ctx.step.waitForApproval("manager-ok", {
  message: `Refund RM${input.amount} to ${input.customerName}?`,
  notify: config.managerChatId,
  timeout: "1 day",
});

if (decision === null) return { status: "TIMED_OUT" };
if (!decision.approved) return { status: "REJECTED" };

await ctx.step.do("refund", ({ idempotencyKey }) =>
  ctx.payment.refund?.({ billId: input.billId, amount: input.amount, idempotencyKey }),
);
return { status: "REFUNDED" };
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `message` | `Approval needed: <actuator> / <step>` | The text the approver sees |
| `notify` | none | Who gets the links, as a chat ID, phone number or email address that your messaging provider understands, `"owner"` to [send them to yourself](#send-the-links-to-yourself), or `{ to, channel }` to [pick the channel](#pick-the-channel) |
| `timeout` | `"7 days"` | Give up after this long and resolve to `null`. The links expire at the same time |

## Result

`waitForApproval` resolves to one of:

- `{ approved: true, at, note? }` when approved;
- `{ approved: false, at, note? }` when rejected;
- `null` when the timeout passed with no decision.

`at` is the ISO timestamp of the decision. `note` is whatever the approver typed in the optional note box on the approval page, or sent with an API decision (see below), trimmed and at most 2,000 characters. It is absent when they left it empty. Like every wait, a timeout resolves to `null` rather than throwing.

## How the links work

The first time a run reaches `waitForApproval`:

1. The runtime writes a `WAITING_APPROVAL` row to the journal and suspends the run.
2. It signs two tokens, approve and reject, with HMAC-SHA256. Each token names the run, the step and the decision, and expires with the timeout.
3. It sends both links to `notify` through the actuator's messaging provider, or to you with `notify: "owner"`, and logs `Approval requested for "<step>"` with the step and expiry, but not the links.

Replays do not send the links again.

When the approver opens a link:

- **`GET` shows a confirmation page** with your `message`, an optional note box and a single button. Opening the link decides nothing, so chat-app link previews and email security scanners that fetch URLs can never approve a refund by accident.
- **Clicking the button sends a `POST`** that applies the decision with the note, records it in the journal and resumes the run.
- **Links are single use.** Once a step has a decision, both links stop working. Opening one shows "Link expired", and the runtime refuses a post to one. Expired or tampered links behave the same. Either way nothing changes.

You cannot post approval decisions as ordinary events. Event keys for approvals are reserved, and the events endpoint refuses them.

## The approval queue

Every step waiting for a person is in the approval queue, oldest first. Each entry has a `kind`, `"approval"` or `"input"`, and a `message`, which is the approval message or the input prompt. On the platform the dashboard shows it; on the [runtime API](/docs/reference/runtime-http/#approvals) it is `GET /approvals`.

An authenticated operator can also decide without the link, and attach a note:

```bash
curl -X POST localhost:8787/runs/<runId>/approvals/manager-ok/approve \
  -H 'content-type: application/json' -d '{"note":"Checked with the customer"}'
```

Use `/reject` to reject. A step that has already been decided returns `{ "ok": false, "reason": ... }`.

## Who decided

Every decision and answer records `via` (`"link"`, `"dashboard"`, `"api"` or, for approvals, `"chat"`) and, when known, `by`:

- For a dashboard decision, `by` is the signed-in account's email.
- For an API decision, it is the account email and the token's name, for example `aina@kedai.example (token "ops-cli")`.
- For a link decision, it is the name the person typed in the optional "Your name" field. Anyone holding the link can type anything there, so treat it as self-reported, not verified identity. If you need verified approvers, decide in the dashboard or with chat buttons.
- For a [chat button](/docs/guides/approval-buttons/), it is the channel and the clicker's user ID, with their display name when the chat app gives one, for example `telegram:123456789 (Wei Tan)`. The chat app's signature proves the ID. The name is whatever the person set. A custom webhook's receiver [asserts](/docs/guides/approval-buttons/#decide-from-your-own-server) both, as `custom-webhook:<id> (<name>)`.

```ts
const decision = await ctx.step.waitForApproval("manager", { message: "Refund RM 480?", notify: "@shop_manager" });
await ctx.step.do("audit", () =>
  ctx.db.sql`INSERT INTO approvals (run_id, approved, by, via) VALUES (${ctx.runId}, ${decision?.approved ?? false}, ${decision?.by ?? null}, ${decision?.via ?? null})`,
);
```

## Getting the links

Actuate **never writes the links to run logs**. Anything that can read a run, such as an agent holding a run token, could otherwise approve its own gate. As the owner you get them from:

- the messaging notification sent to `notify`, or the email sent to you with `notify: "owner"`;
- the dashboard's approval queue;
- the API, with a full token: `GET /v1/actuators/<name>/runs/<runId>/approvals/<step>/links`. In the open-source runtime it is [`GET /runs/<runId>/approvals/<step>/links`](/docs/reference/runtime-http/#approvals), behind `ACTUATE_TOKEN`.

Each returns `{ approveUrl, rejectUrl, expiresAt }` for an approval, or `{ answerUrl, expiresAt }` for an input step, while the step is waiting.

## Asking for input

`ctx.step.waitForInput` asks a person a question and waits for a written answer. Use it for what an agent can't decide alone: what to tell an upset customer, which of two dates works, a correction to a draft.

```ts
const reply = await ctx.step.waitForInput("reply-text", {
  prompt: `${input.customerName} asked for a refund on ${input.orderId}. What should we tell them?`,
  notify: config.managerChatId,
  initial: draft, // pre-filled, to edit
  maxLength: 1000,
  timeout: "2 days",
});
if (reply === null) return { status: "NO_ANSWER" };

await ctx.step.do("send-reply", () => ctx.messaging.send(input.phone, reply.text));
```

| Option | Default | Meaning |
| --- | --- | --- |
| `prompt` | required | The question shown on the form |
| `notify` | none | Who gets the link, as for approvals, including `"owner"` |
| `initial` | empty | Text the form starts with, for example a draft to edit |
| `maxLength` | `4000` | Longest answer, in characters. At most 20,000 |
| `timeout` | `"7 days"` | Give up after this long and resolve to `null`. The link expires at the same time |

It resolves to `{ text, at }`, or `null` on timeout. `text` is trimmed, never empty and never longer than `maxLength`; the form refuses anything else and the run keeps waiting.

It works like an approval:

- The runtime signs one **answer link** and sends it to `notify`. It never writes the link to the run's logs.
- `GET` on the link shows the prompt and a text box filled with `initial`. Only the `POST` from the form's **Send answer** button records the answer.
- The link is single use, and stops working once someone answers.
- The step appears in the approval queue with `kind: "input"`.
- Owners can answer without the link from the dashboard, or with a full token: `POST /v1/actuators/<name>/runs/<runId>/inputs/<step>` with `{"text": "..."}`. A step that isn't waiting, an empty answer or one that's too long returns `{ "ok": false, "reason": ... }`.

## Delivering the links

On the platform, when `notify` is a recipient, Actuate sends the links through your actuator's messaging provider (Telegram, WhatsApp, Slack, Discord, email through Resend or a [custom webhook](/docs/guides/custom-webhook/)), depending on which one you configured. With `notify: "owner"`, Actuate [sends them to you](#send-the-links-to-yourself) instead, by email and to your alert channel when it is Telegram, Slack, Discord or email, with no messaging provider needed. This is how you get them on the Sandbox plan, which has no messaging providers. Without `notify`, take them from the dashboard's approval queue or the links route above. When you run locally with `actuate dev`, they appear in the terminal. In a self-hosted runtime, they go through the messaging provider you configured when `notify` is a recipient, to your owner notifier with `"owner"`, and to the console otherwise.

Through Telegram, Slack and Discord, an approval also gets **Approve** and **Reject** buttons, and a question gets an **Answer** button. With the right credentials the approval's buttons decide in the chat, check who clicked and edit the message to say who decided. Otherwise they open the confirm page. The links stay in the text either way. See [Approve from chat](/docs/guides/approval-buttons/), which also covers approver lists.

Through a custom webhook, the request also arrives as data. The standard body carries an `approval` object with the step and its links. An **Approval JSON template** can turn an approval into a Microsoft Teams or Google Chat card with **Approve** and **Reject** buttons, which open the confirm page. With a signing secret, your receiver can also [decide the approval itself](/docs/guides/approval-buttons/#decide-from-your-own-server). See [approval requests](/docs/guides/custom-webhook/#approval-requests).

If delivery fails, the runtime writes the error to the run's log and the run keeps waiting; fetch the links from the dashboard or the links route instead.

### Pick the channel

With several messaging channels, `notify: { to, channel }` sends the links through the one you name. A string `notify` goes through the default channel.

```ts
const decision = await ctx.step.waitForApproval("manager-ok", {
  message: `Refund RM${input.amount} on ${input.orderId}?`,
  notify: { to: "C0123456789", channel: "slack" },
  timeout: "1 day",
});
```

`channel` is `"telegram"`, `"whatsapp"`, `"slack"`, `"discord"`, `"email"` or `"custom-webhook"`, as for [`ctx.messaging.send`](/docs/concepts/capabilities/#several-channels). It works for `waitForInput` too, and needs `@actuate/sdk` and `@actuate/runtime` 0.5 or later.

A channel that isn't configured always fails the delivery, even when you have only one messaging channel, so a Slack channel ID never goes out through Telegram. The run's log gets the error `Could not deliver approval link for "manager-ok"`, and the step waits as for any failed delivery. `{ to: "owner" }` isn't allowed, so write `notify: "owner"`. For a `notify` that isn't a string or `{ to, channel }`, `waitForApproval` and `waitForInput` throw `ActuatorError`.

On the platform, the owner also gets an [alert](/docs/guides/alerts/) one hour before an approval or question times out, for waits of two hours or more.

### Send the links to yourself

`notify: "owner"` sends the signed links to you, the actuator's owner, the way [`ctx.notifyOwner`](/docs/concepts/actuators/#message-the-owner) reaches you. It works for `waitForApproval` and `waitForInput`, and needs `@actuate/sdk` and `@actuate/runtime` 0.5 or later.

```ts
const decision = await ctx.step.waitForApproval("manager-ok", {
  message: `Refund RM${input.amount} on ${input.orderId}?`,
  notify: "owner",
  timeout: "1 day",
});
```

`"owner"` is reserved. Actuate never passes it to a messaging provider as a recipient, so a recipient that is literally named `owner` (a custom webhook's `to`, say) can't receive approvals any more. It is never a default, so a wait without `notify` still sends nothing. The SDK exports it as `NOTIFY_OWNER`.

Where the links go:

- **On the platform**, Actuate emails them to your account's address. It also sends them to your [alert channel](/docs/guides/alerts/#where-alerts-go) when that channel is Telegram, Slack, Discord or email (Resend). Both come from your account's settings, never from the actuator's code.
- **Under `actuate dev`**, they appear in the terminal as `📣  [owner notification: Approval needed: <actuator>]` (or `Input needed: <actuator>`), followed by the message and the links.
- **Self-hosted**, they go to the `notifyOwner` notifier you pass to `createRuntime`, with the idempotency key `approval:<runId>:<step>` and the subject `Approval needed: <actuator>` or `Input needed: <actuator>`. The runtime shortens the message when it has to, so the links always fit in the 4,000 characters. Without a notifier, it prints the links to the worker's console and writes a `warn` line on the run. See [Self-hosting](/docs/guides/self-hosting/#messages-to-the-owner).
- **In tests**, [`testActuator`](/docs/guides/best-practices/#unit-tests-with-testactuator) records the request in `t.approvals`, with `notify: "owner"`, like any other.

A custom webhook alert channel never gets the links, because it may lead to another agent, and signed links must never reach an agent. Anyone who holds a link can decide, so an agent that received one could approve its own gate. WhatsApp isn't on the list either. Ordinary alerts and `ctx.notifyOwner` messages still go to every kind of channel.

The links go to whoever reads your account's email and that alert channel. Make sure no agent reads either. If you forward the account's email somewhere, or the Telegram group, Slack channel or Discord channel is one that an agent reads, the agent gets the links too.

On the platform, the email puts the links first:

```text
Subject: Approval needed: refund_order

Approve: https://run.actuate.run/a/act_.../approve?token=...
Reject: https://run.actuate.run/a/act_.../approve?token=...

Refund RM480 on ORD-1042?

Run: run_01a19b8e7c2d4f60a1b2c3d4e5f6, step "manager-ok", waits until 2026-11-07 09:00 UTC
Or decide in the dashboard: https://app.actuate.run/actuators/refund_order/approvals
```

A footer follows, saying why you got it and not to forward the links. A question's subject is `Input needed: <actuator>`, and it has one **Answer** link. Actuate cuts the channel's copy at 1,900 characters, so it shortens your message to fit and never the links. Actuate replaces [secret config values](/docs/reference/sdk/#secret) in your message and the step name with `[secret]`.

Limits on the platform:

- These emails share half of your plan's [daily alert emails](/docs/guides/alerts/#daily-email-cap) with `ctx.notifyOwner` messages, so failure alerts always keep the other half.
- Once that half is used up, until 00:00 UTC, the links aren't emailed. Your alert channel still gets them, if it is one of the kinds above. When nothing went out, the run's log gets a `warn` line, such as `Approval links for "manager-ok" not sent: today's emails for owner notices are used up: … Find it in the dashboard under Approvals.` The step keeps waiting, and you decide it in the dashboard.
- Actuate sends each wait's links once. A replayed pass sends nothing new. When a [retry of a failed run](/docs/guides/retry-and-rollback/#retry-a-failed-run) reaches a wait again, that wait sends its new links.
- Each send counts toward the 10 messages to the owner a pass may send, shared with `ctx.notifyOwner`.
