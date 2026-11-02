---
title: Deterministic agent tools
description: Let the model decide that something should happen, and let an actuator decide how it happens.
---

Language models are good at understanding intent and bad at deterministic, multi-step execution. An agent that runs a refund itself (looks up the order, works out the amount, calls the payment API, records it) can hallucinate a parameter, call the API twice on a retry, or be talked into skipping a check.

The fix is to split the job:

> **The LLM decides *that*. The actuator decides *how*.**

The model decides that a customer deserves a refund. An actuator, exposed to the model as an [MCP tool](/docs/concepts/mcp-and-openapi/), carries it out with the amount cap, the approval gate and the audit row enforced in code the model cannot change.

## What the actuator gives you

| Risk with an agent acting directly | What the actuator enforces |
| --- | --- |
| Hallucinated or malformed arguments | The InputSchema is the tool's argument schema, and bad arguments are rejected before any code runs |
| Acting twice when the agent or network retries | A retried tool call returns the first run's receipt; each `ctx.step.do` runs once per run |
| Exceeding a limit | Caps live in `config` and in code, not in a prompt |
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
- It cannot skip the approval: above the threshold the run waits for a manager, and a timeout counts as a rejection.
- It cannot refund twice: a retried tool call gets the first run's receipt, and the `refund` step runs once per run.
- Every outcome leaves a row in `refunds` that you can browse and export.

## Designing tools for agents

- **One actuator, one job.** "Refund an order" is a good tool. "Manage orders" is not.
- **Write `description` for the model.** Say what it does, what it returns, and when not to call it. Use `.describe()` on every input field.
- **Push rules into the schema.** Enums over free strings, `min`/`max` on numbers, `regex` on phone numbers and IDs. Rules the schema cannot express go in `run` before the first side effect.
- **Look up, don't trust.** Take IDs from the model and load amounts, addresses and account details from your database or provider inside a step.
- **Return a small, typed result.** Set `output`, so the model gets a predictable shape and the run fails loudly if your code returns something else.
- **Gate what is irreversible.** Money, messages to customers, deletions: put a `waitForApproval` in front, at least above a threshold.
- **Say when a tool can wait.** If a call may pause for a person or a payment, say so in the description so the model doesn't assume an immediate result.
