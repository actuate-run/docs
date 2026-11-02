---
title: MCP and OpenAPI
description: Every deployed actuator is an MCP tool and has an OpenAPI document, generated from its name, description and InputSchema.
---

When you deploy an actuator, the platform publishes it two ways:

- a **hosted MCP server**, over SSE and streamable HTTP, where the actuator is a tool an AI agent can call;
- an **OpenAPI document**, for any HTTP client or agent framework that speaks OpenAPI.

`actuate deploy` prints both URLs.

## From actuator to tool

Both are generated from the actuator definition:

| Actuator field | Becomes |
| --- | --- |
| `name` | The tool name |
| `description` | The tool description |
| `input` (InputSchema) | The tool's argument schema, as JSON Schema |
| `output` | The published result schema, when you set one |

This is why `name` is restricted to lowercase letters, digits and underscores (at most 64 characters), and why `description` is required.

Write the description and field descriptions for a model, because a model reads them to decide when and how to call the tool:

```ts
export const InputSchema = z.object({
  orderId: z.string().describe("The order to refund, e.g. ORD-1042"),
  amount: z.number().positive().max(500).describe("Refund amount in RM, at most 500"),
  reason: z.enum(["damaged", "late", "wrong_item", "other"]).describe("Why the customer is owed a refund"),
});

export default defineActuator({
  name: "refund_order",
  description:
    "Refund part or all of a paid order. Refunds above RM 100 wait for a manager's approval. " +
    "Returns the refund status. Call once per refund; retries are safe.",
  input: InputSchema,
  // ...
});
```

The JSON Schema is generated from the schema's input type, so fields with a `.default()` are optional for the caller.

## Validation before code runs

Arguments are validated against the InputSchema at the gateway, before the actuator wakes. A call with a missing field, a wrong type or an amount over the `max` is rejected: no run is created and none of your code executes. The model gets a precise error it can correct, instead of a half-executed process.

Put every rule you can into the schema: enums instead of free strings, `min` and `max` on amounts, `regex` on phone numbers. The schema is the contract the model cannot step outside.

## Idempotent receipts

Agents retry. Networks drop responses. An MCP tool call to an actuator returns an **execution receipt**, and a retried tool call returns the first run's receipt instead of running again. Combined with [steps](/docs/concepts/steps-and-replay/), a refund tool called twice refunds once.

The same guarantee is available over plain HTTP with the [`Idempotency-Key` header](/docs/concepts/triggers/#idempotency-key).

## Self-hosted

The MCP server and OpenAPI document are part of the hosted platform. The open-source runtime exposes the same generated JSON Schema at `GET /` (see [Runtime HTTP API](/docs/reference/runtime-http/#describe)) and validates input on `/run` and `/webhook` in the same way.

See [Deterministic agent tools](/docs/guides/agent-tools/) for how to design actuators for agents.
