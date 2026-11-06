---
title: Deterministic agent tools
description: Let the model decide that something should happen, and let an actuator decide how it happens.
---

Language models are good at understanding intent and bad at deterministic, multi-step execution. An agent that runs a refund itself (looks up the order, works out the amount, calls the payment API, records it) can hallucinate a parameter, call the API twice on a retry, or be talked into skipping a check.

The fix is to split the job. The model decides *that* something should happen, and an actuator decides *how* it happens.

The model decides that a customer deserves a refund. An actuator, exposed to the model as an [MCP tool](/docs/concepts/mcp-and-openapi/), carries it out with the amount cap, the approval gate and the audit row enforced in code the model cannot change.

## What the actuator gives you

| Risk with an agent acting directly | What the actuator enforces |
| --- | --- |
| Hallucinated or malformed arguments | The InputSchema is the tool's argument schema, and the gateway rejects bad arguments before any code runs |
| Acting twice when the agent or network retries | A retried tool call with the same [idempotency key](/docs/concepts/mcp-and-openapi/#idempotent-receipts), or with the same values in the actuator's [key fields](/docs/concepts/mcp-and-openapi/#key-fields), returns the first run's receipt; each `ctx.step.do` runs once per run |
| Exceeding a limit | Caps live in `config` and in code, not in a prompt. On the platform you can also cap how often each agent may run a tool, with [agent limits](/docs/concepts/agents/#limits) |
| Acting without sign-off | `ctx.step.waitForApproval` pauses until a person clicks |
| No record of what happened | Every run has a step journal, and you write audit rows to SQLite |
| Leaked keys | Credentials stay in providers; the model never sees them |

## Example: a refund tool

```ts title="actuator.ts"
import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  maxRefundRM: z.number().default(500),
  approvalAboveRM: z.number().default(100),
  managerChatId: z.string().default("123456789"),
});

export const InputSchema = z.object({
  orderId: z.string().describe("The order to refund, e.g. ORD-1042"),
  amount: z.number().positive().describe("Refund amount in RM"),
  reason: z.enum(["damaged", "late", "wrong_item", "other"]).describe("Why the customer is owed a refund"),
});

export default defineActuator({
  name: "refund_order",
  description:
    "Refund part or all of a paid order. Refunds above the approval threshold wait for a manager. " +
    "Returns the outcome. Safe to retry.",
  config: ConfigSchema,
  input: InputSchema,
  // A retried call for the same order returns the first call's run, even without a key.
  idempotencyKey: ["orderId"],
  output: z.object({
    status: z.enum(["REFUNDED", "REJECTED", "NOT_FOUND", "OVER_LIMIT", "UNSUPPORTED"]),
    refundId: z.string().optional(),
  }),
  capabilities: ["payment", "messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate([
      "CREATE TABLE orders (id TEXT PRIMARY KEY, bill_id TEXT NOT NULL, amount REAL NOT NULL)",
      "CREATE TABLE refunds (run_id TEXT PRIMARY KEY, order_id TEXT, amount REAL, reason TEXT, status TEXT, refund_id TEXT)",
    ]);

    // Hard cap, in code.
    if (input.amount > config.maxRefundRM) return { status: "OVER_LIMIT" as const };

    // The order and the paid amount come from your data, not from the model.
    const order = await ctx.step.do("load-order", () =>
      ctx.db.first<{ bill_id: string; amount: number }>("SELECT bill_id, amount FROM orders WHERE id = ?", [input.orderId]),
    );
    if (!order || input.amount > order.amount) return { status: "NOT_FOUND" as const };

    // A person signs off on large refunds.
    if (input.amount > config.approvalAboveRM) {
      const decision = await ctx.step.waitForApproval("manager-ok", {
        message: `Refund RM${input.amount} on ${input.orderId} (${input.reason})?`,
        notify: config.managerChatId,
        timeout: "1 day",
      });
      if (!decision?.approved) {
        await ctx.step.do("audit-rejected", () =>
          ctx.db.sql`INSERT INTO refunds VALUES (${ctx.runId}, ${input.orderId}, ${input.amount}, ${input.reason}, 'REJECTED', ${null})`,
        );
        return { status: "REJECTED" as const };
      }
    }

    // Exactly once, with the provider's idempotency key as a backstop.
    const refund = await ctx.step.do("refund", ({ idempotencyKey }) =>
      ctx.payment.refund?.({ billId: order.bill_id, amount: input.amount, reason: input.reason, idempotencyKey }) ?? null,
    );
    if (!refund) return { status: "UNSUPPORTED" as const };

    await ctx.step.do("audit-refunded", () =>
      ctx.db.sql`INSERT INTO refunds VALUES (${ctx.runId}, ${input.orderId}, ${input.amount}, ${input.reason}, ${refund.status}, ${refund.id})`,
    );
    return { status: "REFUNDED" as const, refundId: refund.id };
  },
});
```

What the model can and cannot do with this tool:

- It can choose the order, the amount and one of four reasons. The schema rejects anything else before the actuator wakes.
- It cannot refund more than the order's paid amount or `maxRefundRM`, because those checks are in code.
- It cannot skip the approval. Above the threshold the run waits for a manager, and a timeout counts as a rejection.
- It cannot refund twice for one retried call. A retry for the same order gets the first run's receipt, with or without a `_meta` idempotency key, and the `refund` step runs once per run. Some calls still start a second run for the same order, so see [one action per order](#one-action-per-order).
- Every outcome leaves a row in `refunds` that you can browse and export.

## One action per order

An idempotency key only helps when the client sends one. Many chat clients don't, and a stateless (2026-07-28) MCP client then starts a new run for every retry. Each run has its own run ID, so the provider idempotency keys Actuate derives differ too. Two runs for the same order can both refund unless something stops the second one.

Key fields fix the common case. With `idempotencyKey: ["orderId"]`, as in the example above, a call without a key for an order that already has a run returns that run, while it is running or waiting and for 24 hours after it completed. A run that failed or was cancelled doesn't count, so the order can be tried again. See [key fields](/docs/concepts/mcp-and-openapi/#key-fields) for the rules.

Some runs for the same order still overlap, and the key can't stop them:

- calls that send their own keys, because a key the caller sends replaces the key fields (two different keys for one order start two runs);
- runs you start yourself from the dashboard or with `actuate run`, and webhooks, which never use the key fields;
- a call for an order whose run completed more than 24 hours ago.

So keep a guard in your code too. Claim the thing you act on before the first wait, in a step that does only database work:

```ts
const claim = await ctx.step.do("claim-order", async ({ now }) => {
  const done = await ctx.db.first("SELECT 1 FROM refunds WHERE order_id = ? AND status = 'REFUNDED'", [orderId]);
  if (done) return "refunded";
  const busy = await ctx.db.first(
    "SELECT 1 FROM refunds WHERE order_id = ? AND status = 'PENDING' AND run_id != ? AND at > ?",
    [orderId, ctx.runId, now - staleAfter],
  );
  if (busy) return "busy";
  ctx.db.commitWithStep([ctx.db.statement`INSERT INTO refunds (order_id, run_id, amount, status, at) VALUES (${orderId}, ${ctx.runId}, ${amount}, 'PENDING', ${now})`]);
  return "claimed";
});
```

Because the step makes no network calls, no other run can claim the same order between the check and the insert. A second call then returns at once instead of waiting for its own approval. Turn the claim into the outcome when the run ends (refunded, declined, or failed so the order can be tried again), and treat a claim older than your longest wait as stale, so a run cancelled while it waited doesn't block the order forever. The [`refund-order` template](/docs/guides/templates/) does all of this.

A checking step placed before an approval wait is not enough on its own, because both runs pass it before either one pays.

To refund an order again on purpose, send a new key, as `_meta["run.actuate/idempotencyKey"]` over MCP or the `Idempotency-Key` header over HTTP. The call then starts a new run, and the claim decides whether it may act.

On the hosted platform, a key in `_meta` deduplicates for as long as the platform keeps the run it started, which is 7 days on Sandbox, 30 on Maker and 90 on Agency. A run still waiting is never deleted.

## Let the caller preview

Actuate can't dry-run a tool for you, because it can't know what your code will do without running it. If a preview helps the model or the person approving, add it to your input:

```ts
input: z.object({
  orderId: z.string(),
  amount: z.number().positive().max(500),
  preview: z.boolean().default(false).describe("Return what would happen without refunding"),
}),
```

In `run`, compute the capped amount and whether approval is needed, and return that plan before the first side effect when `preview` is true. Say in the description that a preview call changes nothing.

## Designing tools for agents

- **One actuator, one job.** "Refund an order" is a good tool. "Manage orders" is not.
- **Write `description` for the model.** Say what it does, what it returns, and when not to call it. Use `.describe()` on every input field.
- **Push rules into the schema.** Use enums over free strings, `min`/`max` on numbers, and `regex` on phone numbers and IDs. Rules the schema cannot express go in `run` before the first side effect.
- **Look up, don't trust.** Take IDs from the model and load amounts, addresses and account details from your database or provider inside a step.
- **Return a small, typed result.** Set `output`, so the model gets a predictable shape and the run fails if your code returns something else.
- **Gate what is irreversible.** For money, messages to customers and deletions, put a `waitForApproval` in front, at least above a threshold.
- **Say when a tool can wait.** If a call may pause for a person or a payment, say so in the description so the model doesn't assume an immediate result.
