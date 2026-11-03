---
title: Human approvals and input
description: Pause a run until a person approves, rejects or answers a question through a signed, single-use link.
---

Two steps pause a run until a person acts on a signed link: `waitForApproval` for a yes or no, and [`waitForInput`](#asking-for-input) for a short written answer.

`ctx.step.waitForApproval` pauses a run until a person clicks **Approve** or **Reject** on a signed link, or until the timeout passes. Use it for money above a threshold, a message to a customer, or anything you want a human to sign off.

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
| `message` | `Approval needed: <actuator> / <step>` | Shown to the approver |
| `notify` | none | Who gets the links: a chat ID, phone number or email address understood by your messaging provider |
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
3. It sends both links to `notify` through the actuator's messaging provider, and logs `Approval requested for "<step>"` with the step and expiry, but not the links.

Replays do not send the links again.

When the approver opens a link:

- **`GET` shows a confirmation page** with your `message`, an optional note box and a single button. Opening the link decides nothing, so chat-app link previews and email security scanners that fetch URLs can never approve a refund by accident.
- **Clicking the button sends a `POST`** that applies the decision with the note, records it in the journal and resumes the run.
- **Links are single use.** Once a step has been decided, both links stop working: opening one shows "Link expired", and posting one is refused. Expired or tampered links behave the same. Either way nothing changes.

Approval decisions cannot be posted as ordinary events: event keys for approvals are reserved and refused by the events endpoint.

## The approval queue

Every step waiting for a person is in the approval queue, oldest first. Each entry has a `kind`, `"approval"` or `"input"`, and a `message`: the approval message or the input prompt. On the platform the dashboard shows it; on the [runtime API](/docs/reference/runtime-http/#approvals) it is `GET /approvals`.

An authenticated operator can also decide without the link, and attach a note:

```bash
curl -X POST localhost:8787/runs/<runId>/approvals/manager-ok/approve \
  -H 'content-type: application/json' -d '{"note":"Checked with the customer"}'
```

Use `/reject` to reject. A step that has already been decided returns `{ "ok": false, "reason": ... }`.

## Who decided

Every decision and answer records `via` (`"link"`, `"dashboard"` or `"api"`) and, when known, `by`:

- **Dashboard:** the signed-in account's email.
- **API:** the account email and the token's name, e.g. `aina@kedai.example (token "ops-cli")`.
- **Link:** the name the person typed in the optional "Your name" field. Anyone holding the link can type anything there, so treat it as self-reported, not verified identity. If you need verified approvers, decide in the dashboard.

```ts
const decision = await ctx.step.waitForApproval("manager", { message: "Refund RM 480?", notify: "@shop_manager" });
await ctx.step.do("audit", () =>
  ctx.db.sql`INSERT INTO approvals (run_id, approved, by, via) VALUES (${ctx.runId}, ${decision?.approved ?? false}, ${decision?.by ?? null}, ${decision?.via ?? null})`,
);
```

## Getting the links

The links are **never written to run logs**. Anything that can read a run, such as an agent holding a run token, could otherwise approve its own gate. As the owner you get them from:

- the messaging notification sent to `notify`;
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
| `notify` | none | Who gets the link, as for approvals |
| `initial` | empty | Text the form starts with, for example a draft to edit |
| `maxLength` | `4000` | Longest answer, in characters. At most 20,000 |
| `timeout` | `"7 days"` | Give up after this long and resolve to `null`. The link expires at the same time |

It resolves to `{ text, at }`, or `null` on timeout. `text` is trimmed, never empty and never longer than `maxLength`; the form refuses anything else and the run keeps waiting.

It works like an approval:

- The runtime signs one **answer link** and sends it to `notify`. It is never written to the run's logs.
- `GET` on the link shows the prompt and a text box filled with `initial`. Only the `POST` from the form's **Send answer** button records the answer.
- The link is single use: once answered, it stops working.
- The step appears in the approval queue with `kind: "input"`.
- Owners can answer without the link from the dashboard, or with a full token: `POST /v1/actuators/<name>/runs/<runId>/inputs/<step>` with `{"text": "..."}`. A step that isn't waiting, an empty answer or one that's too long returns `{ "ok": false, "reason": ... }`.

## Delivering the links

On the platform, when `notify` is set, links are sent through your actuator's messaging provider: Telegram, WhatsApp, or email through Resend, depending on which one you configured. Actuate does not send them itself. Without `notify`, or on the Sandbox plan (which has no messaging providers), take them from the dashboard's approval queue or the links route above. When you run locally with `actuate dev`, they are printed in the terminal. In a self-hosted runtime, they go through the messaging provider you configured when `notify` is set, and to the console otherwise.

If delivery fails, the error is written to the run's log and the run keeps waiting; fetch the links from the dashboard or the links route instead.

On the platform, the owner also gets an [alert](/docs/guides/alerts/) one hour before an approval or question times out, for waits of two hours or more.
