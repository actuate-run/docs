---
title: Introduction
description: What an actuator is, and why Actuate exists.
---

Actuate is a hosted runtime for small, stateful TypeScript scripts. Each script is called an **actuator**. An actuator is one TypeScript file, and it gets:

- a **durable step engine**: steps run once, survive restarts and can be retried safely;
- **free sleeps and waits**: pause for three days or until a webhook arrives, with no process running and nothing billed;
- its **own SQLite database**, queried with parameterised SQL;
- a **hosted MCP endpoint and OpenAPI document**, so an AI agent can call it as a strict, schema-validated tool.

You deploy it with `actuate deploy`. There is no proprietary workflow format: the file is standard TypeScript, it diffs in Git, and it runs in a V8 isolate.

```ts title="actuator.ts"
import { defineActuator, z } from "@actuate/sdk";

export default defineActuator({
  name: "hello",
  description: "Greets someone, waits a day, then follows up.",
  input: z.object({ name: z.string() }),
  async run(ctx, input) {
    await ctx.step.do("greet", () => ctx.log.info(`Hello, ${input.name}!`));
    await ctx.step.sleep("1 day"); // hibernates: no memory, no cost
    await ctx.step.do("follow-up", () => ctx.log.info(`Still there, ${input.name}?`));
  },
});
```

## The problem

Writing a 150-line script is now close to free. Running twenty of them reliably for a year is not. A booking bot, an invoice reconciler or a webhook handler needs state, retries, a 48-hour wait and a database, and the usual places to run one each have a cost:

- **A VPS or container per script.** Idle RAM, OS patching, and a monthly bill whether the script runs or not. A three-day wait between two steps means a process or cron job that has to survive restarts.
- **A no-code workflow tool.** Logic stored as proprietary JSON that diffs badly in Git, with relational queries and custom code made painful.
- **Letting an LLM agent run the process itself.** Models are good at understanding intent and bad at deterministic multi-step execution. An agent running a payment follow-up loop risks hallucinated parameters, double charges and leaked keys.

Actuate is the missing option: a single TypeScript file is the whole deployment, the platform handles state and retries, the script sleeps for free, and an agent can call it as a tool whose arguments are validated before any code runs.

## What it is good at

Three patterns come up again and again:

- **Things that must happen exactly once.** Charging, refunding, posting, inserting. [`ctx.step.do`](/docs/concepts/steps-and-replay/) makes a retry safe without you writing an idempotency table.
- **Things that wait.** Hours or days between two steps. [`sleep` and `waitForEvent`](/docs/concepts/sleeping-and-waiting/) cost nothing while waiting, so a 14-day drip is as cheap as a one-shot webhook.
- **Things that need a person.** Money above a threshold, a message to a customer. [`waitForApproval`](/docs/concepts/approvals/) pauses the run until someone clicks a signed link.

For agent builders the combination is the point: the model decides *that* a refund is warranted, and an actuator decides *how* it happens. See [Deterministic agent tools](/docs/guides/agent-tools/).

## Hosted and open source

The SDK (`@actuate/sdk`), the step engine (`@actuate/runtime`), the CLI (`@actuate/cli`) and the starter (`create-actuate`) are open source in [github.com/actuate-run/actuate](https://github.com/actuate-run/actuate). `actuate dev` runs the same engine on your machine, and you can [self-host an actuator on workerd](/docs/guides/self-hosting/). The hosted platform adds multi-tenancy, the MCP endpoint, the dashboard, managed providers and quotas.

## Next

- [Quickstart](/docs/getting-started/quickstart/)
- [Your first actuator](/docs/getting-started/first-actuator/)
