---
title: Quickstart
description: Create an actuator, run it locally, watch it sleep and wake, and deploy it.
---

You need Node.js 22 or later. This takes five minutes, and you don't need an account until the last step.

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
├─ actuator.test.ts      its tests, run by npx actuate test
├─ AGENTS.md             instructions for your coding agent
├─ actuate.config.json   operator configuration, {} to start
├─ package.json          @actuate/sdk, @actuate/cli, typescript, and the dev, test, check and deploy scripts
├─ tsconfig.json
└─ .gitignore
```

`actuator.test.ts`, `AGENTS.md` and the `test` and `check` scripts come with `@actuate/cli` 0.3 and later.

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

`actuate dev` lints the file, bundles it, and runs it on a local `workerd` with a real SQLite-backed Durable Object at `http://localhost:8787`. It rebuilds when you save. It prints messages and payment links to the terminal instead of sending them. It also applies the hosted platform's [guards](/docs/reference/cli/#guards-in-actuate-dev) for your plan (the free Sandbox until you log in), so code that would fail once deployed fails here first.

## 3. Start a run

In a second terminal:

```bash
npx actuate run '{"name":"Aina"}' --local
```

It prints where the run got to after its first pass:

```text
run_01a1a2e8442f42a93c45c688b5b1  WAITING  api  2026-11-03T19:34:53.231Z
  1 pass · 12 rows written · 12 rows read
  step  COMPLETED        greet
  step  SLEEPING         sleep#1  until 2026-11-03T19:35:03.244Z
  2026-11-03T19:34:53.238Z  info  Hello, Aina!

Next
  sleeps until 2026-11-03T19:35:03.244Z (step "sleep#1")

Logs: actuate logs run_01a1a2e8442f42a93c45c688b5b1 --local
```

`WAITING` means the run reached `ctx.step.sleep` and hibernated. The `dev` terminal shows `Hello, Aina!`. The second line is what the run has cost so far: one pass, and the rows it wrote and read in its SQLite database, journal included. Add `--json` for the run record, as the [runtime HTTP API](/docs/reference/runtime-http/#the-run-record) returns it.

Actuate validates the input before any code runs. Try `npx actuate run '{"name":""}' --local`:

```text
✗ 400: Invalid input
  name: Too small: expected string to have >=1 characters
```

## 4. Watch it wake

Ten seconds later the Durable Object alarm fires, `run` replays from the top, the `greet` step returns its stored result without running again, and execution continues past the sleep. The terminal shows `Still there, Aina?`.

```bash
npx actuate logs --local            # recent runs
npx actuate logs <runId> --local    # one run's steps and logs
```

```text
run_01a1a2e8442f42a93c45c688b5b1  COMPLETED  api  2026-11-03T19:34:53.231Z
  2 passes · 16 rows written · 20 rows read
  step  COMPLETED        greet
  step  COMPLETED        sleep#1
  step  COMPLETED        follow-up
  2026-11-03T19:34:53.238Z  info  Hello, Aina!
  2026-11-03T19:35:03.248Z  info  Still there, Aina?
  output {"greetedAt":"2026-11-03T19:34:53.237Z"}
```

Waking up cost a second pass and four more rows written. Rows and passes are what the [plan limits](/docs/reference/limits/#plans) count.

The row the run wrote is in its own database:

```bash
curl localhost:8787/tables/greetings
curl 'localhost:8787/tables/greetings?format=csv'
```

## 5. Test it

```bash
npx actuate test
```

```text
Platform guards: Sandbox plan (the default: not logged in), unless a test passes testActuator(actuator, { plan }). Pass --plan maker or agency, or run `actuate login`, to use your plan.
✔ greets, sleeps, then follows up (22.038606ms)
✔ refuses an empty name before any code runs (2.950972ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

`actuator.test.ts` runs the same run in-process, with a clock it moves itself, so the ten-second sleep takes no time:

```ts title="actuator.test.ts"
test("greets, sleeps, then follows up", async () => {
  const t = testActuator(actuator);
  const run = await t.start({ name: "Aina" });
  assert.equal(run.status, "WAITING"); // asleep until the follow-up

  await t.advance("10 seconds"); // the test clock: no real waiting
  assert.equal(t.run(run.runId).status, "COMPLETED");
  assert.deepEqual(t.rows("greetings").map((r) => r.name), ["Aina"]);
  // A budget: fails if a change makes this run cost more passes or rows.
  assert.deepEqual(t.usage(run.runId).passes, 2);
  assert.ok(t.usage(run.runId).rowsWritten <= 20);
});
```

See [unit tests with testActuator](/docs/guides/best-practices/#unit-tests-with-testactuator) for the rest of what a test can do.

## 6. Deploy

```bash
npx actuate login     # paste a Full token from the dashboard: Settings → API tokens
npx actuate deploy
```

New tokens are **Agent** tokens by default, which can only start and read runs; choose **Full** for the CLI. `actuate login` checks the token and refuses an Agent token.

Before it uploads anything, `deploy` runs [`actuate check`](/docs/reference/cli/#actuate-check) and the platform's [deploy checks](/docs/reference/cli/#the-deploy-checks) for your plan, and stops on errors, because a refused deploy would still count against your monthly deploy budget. Then it bundles `actuator.ts`, sends `actuate.config.json` as the configuration, and prints the actuator's webhook, MCP, OpenAPI and dashboard URLs. To see what a deploy would send, and run the checks without deploying, use `npx actuate deploy --dry-run`. If something doesn't work, `npx actuate doctor` checks Node, the project, providers and your login.

The free Sandbox plan deploys this `hello` actuator as it is. Actuators that declare `messaging`, `payment` or `llm` need the Maker plan; on Sandbox, the deploy checks stop them with `The Sandbox plan cannot use messaging. Upgrade to Maker to use providers.`

Start a run on the deployed actuator:

```bash
npx actuate run '{"name":"Aina"}'
npx actuate logs
```

## Next

- [Your first actuator](/docs/getting-started/first-actuator/) adds payments, events and reminders.
- [Steps and replay](/docs/concepts/steps-and-replay/) explains the one rule you need to know.
- [Write efficient actuators](/docs/guides/best-practices/) covers patterns that save limits, and how to test before you deploy.
