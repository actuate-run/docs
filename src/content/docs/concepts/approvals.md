---
title: Human approvals
description: Pause a run until a person approves or rejects it through a signed, single-use link.
---

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

`at` is the ISO timestamp of the decision. `note` is set only when the decision was made through the API with a note (see below). Like every wait, a timeout resolves to `null` rather than throwing.

## How the links work

The first time a run reaches `waitForApproval`:

1. The runtime writes a `WAITING_APPROVAL` row to the journal and suspends the run.
2. It signs two tokens, approve and reject, with HMAC-SHA256. Each token names the run, the step and the decision, and expires with the timeout.
3. It sends both links to `notify` through the actuator's messaging provider, and logs `Approval requested for "<step>"` with the step and expiry, but not the links.

Replays do not send the links again.

When the approver opens a link:

- **`GET` shows a confirmation page** with a single button. Opening the link decides nothing, so chat-app link previews and email security scanners that fetch URLs can never approve a refund by accident.
- **Clicking the button sends a `POST`** that applies the decision, records it in the journal and resumes the run.
- **Links are single use.** Once a step has been decided, both links stop working and show "This approval has already been decided or has expired." Expired or tampered links show "This link is invalid or has expired." Either way nothing changes.

Approval decisions cannot be posted as ordinary events: event keys for approvals are reserved and refused by the events endpoint.

## The approval queue

Every step waiting for a decision is in the approval queue, oldest first, with the `message` you passed to `waitForApproval`. On the platform the dashboard shows it; on the [runtime API](/docs/reference/runtime-http/#approvals) it is `GET /approvals`.

An authenticated operator can also decide without the link, and attach a note:

```bash
curl -X POST localhost:8787/runs/<runId>/approvals/manager-ok/approve \
  -H 'content-type: application/json' -d '{"note":"Checked with the customer"}'
```

Use `/reject` to reject. A step that has already been decided returns `{ "ok": false, "reason": ... }`.

## Getting the links

The links are **never written to run logs**. Anything that can read a run, such as an agent holding a run token, could otherwise approve its own gate. As the owner you get them from:

- the messaging notification sent to `notify`;
- the dashboard's approval queue;
- the API, with a full token: `GET /v1/actuators/<name>/runs/<runId>/approvals/<step>/links`. In the open-source runtime it is [`GET /runs/<runId>/approvals/<step>/links`](/docs/reference/runtime-http/#approvals), behind `ACTUATE_TOKEN`.

Each returns `{ approveUrl, rejectUrl, expiresAt }` while the step is waiting.

## Delivering the links

On the platform, links are delivered by email or by your messaging provider. When you run locally with `actuate dev`, they are printed in the terminal. In a self-hosted runtime, they go through the messaging provider you configured when `notify` is set, and to the console otherwise.

If delivery fails, the error is written to the run's log and the run keeps waiting; fetch the links from the dashboard or the links route instead.
