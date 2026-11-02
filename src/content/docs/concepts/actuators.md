---
title: Actuators
description: The actuator contract - ConfigSchema, InputSchema and a default export from defineActuator.
---

An actuator is one TypeScript file. By convention it has three exports:

```ts title="actuator.ts"
import { defineActuator, z } from "@actuate/sdk";

// 1. What the operator sets once: names, prices, delays.
export const ConfigSchema = z.object({
  greeting: z.string().default("Hello"),
});

// 2. The payload of one run.
export const InputSchema = z.object({
  name: z.string().describe("Who to greet"),
});

// 3. The actuator itself.
export default defineActuator({
  name: "greeter",
  description: "Greets a person by name.",
  config: ConfigSchema,
  input: InputSchema,
  async run(ctx, input, config) {
    await ctx.step.do("greet", () => ctx.log.info(`${config.greeting}, ${input.name}!`));
    return { greeted: input.name };
  },
});
```

The default export is the one the tools require: `actuate dev`, `actuate deploy` and the runtime load the file and reject it unless its default export is the result of `defineActuator(...)`. The runtime reads the schemas from the `config` and `input` fields of the definition. Exporting them by name as well keeps them importable from tests and other files, and keeps every actuator laid out the same way.

## ConfigSchema

Operator settings: business names, prices, delays, feature switches. They are validated once, when the actuator loads, and passed to `run` as the third argument with defaults applied.

- Give every field a `.default()` so the actuator runs with an empty configuration.
- On the platform, the dashboard renders the schema as a form.
- Locally, the values come from `actuate.config.json`. `actuate deploy` sends the same file unless you pass `--no-config`.
- If the configuration does not match the schema, every run fails with a `ConfigError` until it is fixed.

`config` is optional. Without it, `run` receives `{}`.

## InputSchema

The payload of one run, arriving by [API, webhook, cron or MCP tool call](/docs/concepts/triggers/). It is validated before any of your code runs: a bad payload is rejected with `400 Invalid input` and no run is created. `run` receives the parsed value, with Zod defaults and transforms applied.

The input schema also becomes the argument schema of the actuator's [MCP tool](/docs/concepts/mcp-and-openapi/), so describe fields with `.describe()`.

## defineActuator

```ts
defineActuator({
  name,          // required: becomes the MCP tool name
  description,   // required: becomes the MCP tool description
  input,         // required: Zod schema for one run
  config,        // optional: Zod schema for operator settings
  output,        // optional: Zod schema for the return value
  capabilities,  // optional: ["messaging", "payment", "llm", "http"]
  http,          // required with "http": { allow: ["api.github.com"] }
  cron,          // optional: ["0 1 * * *"]
  run,           // required: async (ctx, input, config) => output
});
```

`defineActuator` checks the definition as soon as the file loads and throws an `ActuatorError` when:

- `name` does not match `^[a-z][a-z0-9_]{0,63}$`: lowercase letters, digits and underscores, starting with a letter, at most 64 characters;
- `description` is empty;
- `capabilities` contains anything other than `messaging`, `payment`, `llm` or `http`;
- `capabilities` includes `"http"` but `http.allow` is missing or empty.

Write `description` for a model: it is the text an agent reads when deciding whether to call the tool.

## run

`run(ctx, input, config)` is your code. It receives:

| Argument | What it is |
| --- | --- |
| `ctx.runId` | Unique per run, the same on every replay |
| `ctx.actuator` | The actuator's `name` |
| `ctx.trigger` | How the run started: `{ kind: "api" \| "webhook" \| "cron" \| "mcp" \| "manual", cron?: string }` |
| `ctx.step` | Durable steps, sleeps, waits and approvals. See [Steps and replay](/docs/concepts/steps-and-replay/) |
| `ctx.db` | The actuator's SQLite database. See [Database](/docs/concepts/database/) |
| `ctx.log` | `info`, `warn`, `error` into the run's log |
| `ctx.messaging`, `ctx.payment`, `ctx.llm`, `ctx.http` | Only the [capabilities](/docs/concepts/capabilities/) you declared |
| `input` | The validated input |
| `config` | The validated configuration |

`run` is **replayed from the top** every time the run wakes, so anything with a side effect belongs inside `ctx.step.do`. This is the one rule to learn; [Steps and replay](/docs/concepts/steps-and-replay/) explains it.

## Output

Whatever `run` returns is the run's output. It is stored as JSON, so `Date` values become strings and `undefined` fields disappear. If you set `output`, the return value is validated against it and the run fails when it does not match; the schema is also published in the MCP tool and OpenAPI document.

```ts
output: z.object({ status: z.enum(["CONFIRMED", "REMINDER_SENT"]), bookingId: z.string() }),
```

## Runs

A run moves through these statuses:

| Status | Meaning |
| --- | --- |
| `RUNNING` | A pass is executing |
| `WAITING` | Suspended in a sleep, event wait, approval or retry backoff |
| `COMPLETED` | `run` returned; `output` is set |
| `FAILED` | `run` threw, or the output did not match the schema; `error` is set |
| `CANCELLED` | Cancelled while running or waiting |
