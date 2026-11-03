---
title: Quickstart
description: Create an actuator, run it locally, watch it sleep and wake, and deploy it.
---

You need Node.js 22 or later. Five minutes, no account until the last step.

## 1. Create a project

```bash
npm create actuate my-bot
cd my-bot
npm install
```

This writes a `hello` starter:

```text
my-bot/
├─ actuator.ts           your actuator
├─ actuate.config.json   operator configuration, {} to start
├─ package.json          @actuate/sdk, @actuate/cli, typescript
├─ tsconfig.json
└─ .gitignore
```

`actuator.ts` greets someone, sleeps, then follows up:

```ts title="actuator.ts"
import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  greeting: z.string().default("Hello"),
  followUpAfter: z.enum(["10 seconds", "1 hour", "1 day"]).default("10 seconds"),
});

export const InputSchema = z.object({
  name: z.string().min(1).describe("Who to greet"),
});

export default defineActuator({
  name: "hello",
  description: "Greets someone, waits, then follows up. A starting point for your own actuator.",
  config: ConfigSchema,
  input: InputSchema,
  // For MCP clients: this tool adds a row and sends nothing outside, so it isn't destructive.
  hints: { destructive: false, openWorld: false },
  async run(ctx, input, config) {
    await ctx.db.migrate([
      "CREATE TABLE greetings (run_id TEXT PRIMARY KEY, name TEXT NOT NULL, greeted_at TEXT NOT NULL)",
    ]);

    const greetedAt = await ctx.step.do("greet", async () => {
      const at = new Date().toISOString();
      await ctx.db.sql`INSERT INTO greetings (run_id, name, greeted_at) VALUES (${ctx.runId}, ${input.name}, ${at})`;
      ctx.log.info(`${config.greeting}, ${input.name}!`);
      return at;
    });

    // The run hibernates here. Nothing runs, and nothing is billed, until it wakes.
    await ctx.step.sleep(config.followUpAfter);

    await ctx.step.do("follow-up", () => ctx.log.info(`Still there, ${input.name}?`));
    return { greetedAt };
  },
});
```

To start from a template instead, pass its name: `npm create actuate my-bot -- --template deposit-reminder`. See [Templates](/docs/guides/templates/).

## 2. Run it locally

```bash
npx actuate dev
```

`actuate dev` lints the file, bundles it, and runs it on a local `workerd` with a real SQLite-backed Durable Object at `http://localhost:8787`. It rebuilds when you save. Messages and payment links are printed to the terminal instead of being sent.

## 3. Start a run

In a second terminal:

```bash
curl -X POST localhost:8787/run \
  -H 'content-type: application/json' \
  -d '{"name":"Aina"}'
```

The response is the run record after its first pass:

```json
{
  "runId": "run_01a1998e44009c41f2e07b3d5a18",
  "status": "WAITING",
  "trigger": { "kind": "api" },
  "input": { "name": "Aina" },
  "output": null,
  "wakeAt": 1793577610000,
  ...
}
```

`WAITING` means the run reached `ctx.step.sleep` and hibernated. The `dev` terminal shows `Hello, Aina!`.

Input is validated before any code runs. Try `-d '{"name":""}'` and you get `400 {"error": "Invalid input", "issues": [...]}`.

## 4. Watch it wake

Ten seconds later the Durable Object alarm fires, `run` replays from the top, the `greet` step returns its stored result without running again, and execution continues past the sleep. The terminal shows `Still there, Aina?`.

```bash
npx actuate logs --local            # recent runs
npx actuate logs <runId> --local    # one run's steps and logs
```

```text
run_01a1998e44009c41f2e07b3d5a18  COMPLETED
  step  COMPLETED        greet
  step  COMPLETED        sleep#1
  step  COMPLETED        follow-up
  ...
```

The row the run wrote is in its own database:

```bash
curl localhost:8787/tables/greetings
curl 'localhost:8787/tables/greetings?format=csv'
```

## 5. Deploy

```bash
npx actuate login     # paste a Full token from the dashboard: Settings → API tokens
npx actuate deploy
```

New tokens are **Agent** tokens by default, which can only start and read runs; choose **Full** for the CLI. With an Agent token, `deploy` answers `403`.

`deploy` refuses to upload while [`actuate check`](/docs/reference/cli/#actuate-check) reports errors. It bundles `actuator.ts`, sends `actuate.config.json` as the configuration, and prints the actuator's webhook, MCP, OpenAPI and dashboard URLs.

The free Sandbox plan deploys this `hello` actuator as it is. Actuators that declare `messaging`, `payment` or `llm` need the Maker plan; on Sandbox, `deploy` refuses them with `402`.

Start a run on the deployed actuator:

```bash
npx actuate run '{"name":"Aina"}'
npx actuate logs
```

## Next

- [Your first actuator](/docs/getting-started/first-actuator/): payments, events and reminders.
- [Steps and replay](/docs/concepts/steps-and-replay/): the one rule you need to know.
- [Write efficient actuators](/docs/guides/best-practices/): patterns that save limits, and how to test before you deploy.
