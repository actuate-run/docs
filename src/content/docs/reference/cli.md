---
title: CLI
description: The actuate command and its subcommands, which are init, doctor, dev, test, check, deploy, run, logs, event, approve, reject, answer, cancel, login and providers.
---

The CLI ships as `@actuate/cli` and installs the `actuate` command. Projects created with `npm create actuate` list it as a dev dependency, so run it with `npx actuate` or through the `package.json` scripts (`npm run dev`, `npm test`, `npm run check`, `npm run deploy`). It needs Node.js 22 or later (its `wrangler` dependency does).

:::caution
Outside a project that has `@actuate/cli` installed, don't run a bare `npx actuate`, because the unscoped `actuate` package on npm is an unrelated library. Install the CLI with `npm install -g @actuate/cli`, or use `npx @actuate/cli <command>`.
:::

:::note[Requires @actuate/cli 0.3]
`actuate test`, `doctor`, `event`, `approve`, `reject`, `answer` and `cancel`, `@actuate/cli/testing`, the platform's guards in `actuate dev`, the deploy checks (`check --platform`, and in `deploy`), and the options `--plan`, `--offline`, `--no-guards`, `--force`, `--json`, `--status`, `--limit` and `--idempotency-key` require `@actuate/cli` 0.3 or later. `npx actuate --version` prints the version you have.
:::

```text
actuate init [dir] [--template <name>] [--ref <git-ref>]       Create a project, with an example test
actuate doctor [file] [--offline] [--plan <plan>] [--json]     Check Node, the project, providers and login

actuate dev [file] [--port 8787] [--plan <plan>] [--offline] [--no-guards]
                                                               Run locally on workerd, with the platform's guards
actuate test [files...] [--watch] [--grep <pattern>] [--plan <plan>] [--offline] [--no-checks] [--pass-with-no-tests]
                                                               Run the project's tests
actuate check [file] [--platform] [--plan <plan>] [--offline] [--json]
                                                               Lint for replay safety, and run the deploy checks

actuate run ['<json>'] [--idempotency-key <key>] [--json]      Start a run and show where it got to
actuate logs [runId] [--status <status>] [--limit <n>] [--json]
                                                               List recent runs, or show one run
actuate event <key> ['<json>'] [--json]                        Post an event
actuate approve <runId> [--step <name>] [--note <text>] [--json]
actuate reject <runId> [--step <name>] [--note <text>] [--json]
actuate answer <runId> <text> [--step <name>] [--json]         Answer a waitForInput
actuate cancel <runId> [--json]                                Cancel a running or waiting run

actuate deploy [file] [--dry-run] [--no-config] [--plan <plan>] [--force] [--json]
                                                               Check, bundle and deploy to Actuate
actuate login [--token <token>] [--api <url>]                  Save an API token
actuate providers [--json]                                     List providers and their variables
```

`[file]` defaults to `actuator.ts`. `run`, `logs`, `event`, `approve`, `reject`, `answer` and `cancel` talk to the deployed actuator, or to `actuate dev` with `--local` (and `--port <port>` if it isn't on 8787). For the deployed actuator, `--name <actuator>` overrides the name read from `name:` in `actuator.ts`.

`actuate --help` lists the commands. Every command has `--help` (`-h`) with its options and examples, and `actuate help <command>` prints the same. `actuate --version` (`-v`) prints the CLI's version. `--json` prints JSON instead of text, for scripts and agents.

With `--json`, stdout carries exactly one JSON value, failures included. A command that fails prints `{ "ok": false, "error": "...", ... }`, with what stopped it where there is something to add (a stopped `deploy` adds its diagnostics or its deploy checks), and exits non-zero. The `✗` message still goes to stderr. Wrong usage that stops before the command runs, such as an unknown option, prints only to stderr. `check` and `deploy` results carry `ok` on success too.

Exit codes are the same for every command:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The command ran and failed: `check` found errors, a test failed, a deploy was stopped or refused, a run ended `FAILED`, or the API or `actuate dev` answered with an error |
| `2` | Wrong usage: an unknown command or option, an argument that isn't valid JSON, an unknown `--plan`, a missing argument. An unknown command suggests the closest one: ``Did you mean `actuate deploy`?`` |

## actuate init

```bash
actuate init [dir] [--template <name>] [--ref <git-ref>]
```

Creates a project in `dir` (default: the current directory), which must be empty apart from `.git`. Without `--template` (`-t`) it writes the built-in `hello` starter. With one, it downloads `actuator.ts`, and `README.md`, `.env.example`, `actuate.config.json` and `actuator.test.ts` when present, from the folder of that name in [actuate-run/templates](https://github.com/actuate-run/templates). `--ref` picks a branch or tag of that repository (default `main`).

The project contains:

| File | |
| --- | --- |
| `actuator.ts` | The actuator |
| `actuator.test.ts` | Tests written with [`@actuate/cli/testing`](/docs/guides/best-practices/#unit-tests-with-testactuator), run by [`actuate test`](#actuate-test). The `hello` starter has two; a template has one only if the template ships it |
| `AGENTS.md` | Instructions for coding agents: replay safety, keeping API keys in `secret()` fields set in the dashboard, and the commands to run before calling a change done |
| `actuate.config.json` | The operator configuration, `{}` to start |
| `package.json` | `@actuate/sdk`, `@actuate/cli` and TypeScript, and the scripts below |
| `tsconfig.json` | |
| `.gitignore` | Excludes `node_modules/`, `.actuate/`, `.dev.vars` and `.env` |

The scripts are `dev` (`actuate dev`), `test` (`actuate test`), `check` (`actuate check --platform`), `deploy` (`actuate deploy`) and `typecheck` (`tsc --noEmit`).

`npm create actuate [dir] -- [--template <name>] [--ref <git-ref>]` does the same without installing the CLI first. Its default directory is `my-actuator`.

## actuate doctor

```bash
actuate doctor [file] [--offline] [--plan <plan>] [--json]
```

Checks, in one go, what commonly stops `dev`, `test` or `deploy`, and says how to fix each problem. Requires `@actuate/cli` 0.3 or later.

- Node.js 22 or later (a warning before 22.13, where `node:sqlite` needs a flag).
- The CLI and its `wrangler`.
- The project, meaning the actuator file, `package.json`, and `@actuate/sdk` on the same minor version as `@actuate/cli` (they are released together).
- The actuator's replay-safety errors and warnings, and whether the file loads.
- Login, meaning whether a token is saved and, unless `--offline`, whether the API accepts it, with your plan and the deploys used this month.
- The [deploy checks](#the-deploy-checks) that run locally, for [your plan](#which-plan-applies).
- Providers in `.env` and `.dev.vars` for each capability the actuator declares, and missing credentials for the ones you picked.
- That `.dev.vars` and `.env`, if present, are in `.gitignore`.
- Whether the project has tests.

```text
✓ Node.js 22.23.4
✓ @actuate/cli 0.3.0
✓ wrangler 4.156.1 (used by actuate dev)
✓ actuator.ts
✓ @actuate/sdk 0.3.0
✓ No replay-safety problems
✓ actuator.ts loads: actuator "reminders"
· Not logged in: fine for dev and test; deploy needs it.
    → actuate login
✗ 3 deploy check(s) fail: http-allow, input-regex, config. Checked for the Sandbox plan (the default: not logged in).
    → Run `actuate check --platform` to see them.
· messaging: none in .dev.vars; actuate dev uses a local stand-in (messages print to the console).
! No tests.
    → Add actuator.test.ts (`actuate test` prints an example).

1 problem(s) to fix, 1 warning(s).
```

`✓` is fine, `!` a warning, `✗` a problem and `·` information. `doctor` exits with status 1 when there is a problem (`✗`), so it works in CI. It changes nothing. Its only network call is `GET /v1/me` with the saved token. `--json` prints an array of `{ check, status, message, fix }`, where `status` is `ok`, `warn`, `fail` or `info`.

## actuate dev

```bash
actuate dev [file] [--port 8787] [--plan <plan>] [--offline] [--no-guards]
```

Runs the actuator locally on `workerd` (through wrangler) with the same step engine, a real SQLite-backed Durable Object and real alarms.

- Runs [`actuate check`](#actuate-check) first and prints any problems, without stopping.
- Runs the [deploy checks](#the-deploy-checks) for [your plan](#which-plan-applies), except the ones that need a login, and prints each problem as a `deploy check` line, without stopping:

  ```text
  deploy check  error  Cron "*/5 * * * *" fires more often than every 60 min. The Sandbox plan allows 3 schedules, at least 60 min apart.  (cron)
  ```

  When no plan was chosen, the plan's own rules are [warnings](#which-plan-applies). The [`config-secret`](#the-deploy-checks) warning is printed the same way, for the committed `actuate.config.json` only.
- When the actuator declares a capability the plan lacks and you chose the plan, warns at startup instead:

  ```text
  ⚠  The Sandbox plan (from --plan) has no messaging: the platform will refuse to deploy this actuator.
     With the guards on, calls on ctx.messaging fail here too, with the platform's message.
     Develop for another plan with --plan maker.
  ```
- Bundles the file and rebuilds on every save.
- Serves the [runtime HTTP API](/docs/reference/runtime-http/) at `http://localhost:<port>`.
- Applies the hosted platform's guards for your plan. See [guards](#guards-in-actuate-dev) below.
- Adds what each run read and wrote to its run record. See [rows](#rows-in-actuate-dev) below.
- Reads the configuration from `actuate.config.json`, and passes it as `ACTUATE_CONFIG`. To keep local secrets out of that committed file, set `ACTUATE_CONFIG` in `.dev.vars` to a JSON object on one line, such as `ACTUATE_CONFIG={"apiKey":"sk_test_..."}`. It is merged over `actuate.config.json` (objects key by key; anything else from `.dev.vars` wins), and the banner says so. Invalid JSON there stops `actuate dev` with its line and column (never the text around the error), and an empty `ACTUATE_CONFIG=` is ignored. A merged configuration the schema rejects is reported with both sources named. See [keys and tokens](/docs/concepts/capabilities/#keys-and-tokens).
- Reads environment variables from `.env` and then `.dev.vars` in the project directory. It hands them to wrangler as secrets (in a generated `.actuate/.dev.vars`), so its startup banner shows them as `(hidden)` instead of printing them. `actuate dev` sets `ACTUATE_DEV=1`, so the admin routes and `/webhook` work without secrets locally, but on `localhost` only, and never for a request a web page makes (those get `403`, so a site you have open can't start runs with your real providers). Set `ACTUATE_TOKEN` or `ACTUATE_WEBHOOK_SECRET` there to require them anyway, or to use those routes through a tunnel.
- Uses real providers when you pick them in `.dev.vars` (see [`actuate providers`](#actuate-providers)). Anything you don't pick stays local. Messages (and approval links) print in the terminal, and the payment provider is a fake whose bill URL is `http://localhost:<port>/events/payment.<referenceId>`. Open it to "pay". Its refunds always succeed and print in the terminal. Declared `http` uses your `http.allow` list for real. `ctx.llm` needs `ACTUATE_LLM` set, and otherwise calls fail with "no llm provider is configured".
- Real payment providers send payment webhooks to `POST /providers/<kind>/webhook`. Expose your local port with a tunnel (for example `cloudflared tunnel --url localhost:8787`) and set `ACTUATE_PUBLIC_URL` to the tunnel URL so callback links point there. Provider webhooks and approval links work through the tunnel. The admin API stays local unless you set `ACTUATE_TOKEN`.
- Prints `ctx.notifyOwner` messages in the terminal, as `📣  [owner notification: <subject>]` followed by the text, and reports them sent.
- Secret config values (fields wrapped in [`secret()`](/docs/reference/sdk/#secret)) become `[secret]` in run records, logs and errors, as on a self-hosted runtime.
- Registers cron schedules. Fire one with `curl 'localhost:8787/__scheduled?cron=<expression>'`.
- Keeps state in `.actuate/state` between restarts. Delete the folder to start fresh.

When it is ready it prints what to do next:

```text
  hello running at http://localhost:8787

  Start a run:     npx actuate run '{...}' --local
  Runs and rows:   npx actuate logs [runId] --local
  Post an event:   npx actuate event <key> '{}' --local
  Tables:          curl localhost:8787/tables
  Platform guards: on, for the Sandbox plan (the default: not logged in). --no-guards turns them off. Pass --plan maker or agency, or run `actuate login`, to use your plan.
  Providers not set in .dev.vars print to this console (see `actuate providers`).
```

When `.dev.vars` sets `ACTUATE_CONFIG`, a line before the last says where the configuration came from:

```text
  Config:          actuate.config.json, with ACTUATE_CONFIG in .dev.vars merged over it
```

`actuate dev` reads configuration and environment files at startup, so restart it after changing them.

### Guards in actuate dev

`actuate dev` applies the hosted platform's [guards](/docs/reference/limits/#guards-on-the-hosted-platform), with the platform's own error messages, so code that would fail once deployed fails the same way locally. Requires `@actuate/cli` 0.3 or later.

| Guard | Limit |
| --- | --- |
| `ctx.db` statements per pass (each statement in `ctx.db.batch` or `commitWithStep` counts) | 1,000 |
| Steps recorded per pass (a step with `retries` counts twice) | 1,000 |
| Rows written per pass, journal included | 20,000 |
| Rows read per pass, journal included | 5,000,000 |
| `ctx.http` requests per pass | 50 |
| Wall time per pass | 30 seconds |
| A step's stored result | 1 MiB of JSON |
| SQL | The statements the platform [refuses](/docs/concepts/database/#what-the-platform-refuses): recursive queries, `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, `REINDEX`, `printf`, `format`, `randomblob`, `zeroblob`, reserved table names, and more than 1 MiB of bound parameters |
| The longest sleep or wait | The plan's limit, which is 7 days on the Sandbox and none on Maker and Agency |
| Passes per run | The plan's limit, which is 200 on the Sandbox and 1,000 on Maker and Agency |
| Retries per step | 10 |

After a pass ends, its database and provider clients stop working, as on the platform. A guard throws the platform's error where the limit is crossed, so the run fails the way it would once deployed, and the terminal says which guard stopped it:

```text
🛑  [platform guard] A single pass may run at most 1000 database statements.
    The hosted platform stops a pass here too (Sandbox plan). Restart with --no-guards to turn the local guards off.
```

The plan's capabilities are guarded only for a plan you chose (with `--plan`, `ACTUATE_PLAN` or your login). Then calls on a capability the plan lacks fail with the platform's message, `The Sandbox plan cannot use messaging. Upgrade to Maker to use providers.`, and an optional capability it lacks is `undefined`, as on the platform. When the plan is only the default, they work, so a fresh project from a template that sends messages runs as it is; the deploy check at startup tells you the platform would refuse it.

`actuate dev` doesn't mirror the 50 ms CPU limit (local machines differ too much), the monthly budgets or the database size limits.

`--plan sandbox|maker|agency` picks the plan and `--offline` skips the API. See [which plan applies](#which-plan-applies). `--no-guards` turns the guards off, capabilities included, but rows are still counted.

### Rows in actuate dev

Under `actuate dev`, every run record that `/run`, `/webhook`, `/runs` and `/runs/:runId` return has a `usage` field, `{ "statements", "rowsRead", "rowsWritten" }`, with the rows the run read and wrote, journal included. They come from Cloudflare's own SQLite counters in `workerd`, the counters the platform bills with. The platform's count for the same run can be a few rows higher, because it also records the version each run started on. Reads made to answer `GET` requests, such as `actuate logs` or the table browser, aren't counted against a run. [`actuate run --local`](#actuate-run) and [`actuate logs --local`](#actuate-logs) show them. Requires `@actuate/cli` 0.3 or later.

## actuate providers

```bash
actuate providers [--json]
```

Lists every provider and the variables it reads. Choose one per capability in `.dev.vars`, then add its credentials:

```bash
# .dev.vars (never commit this file)
ACTUATE_MESSAGING=telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
# Only to receive messages and button clicks: 1 to 256 characters of A-Z, a-z, 0-9, _ and -, also passed to setWebhook
TELEGRAM_WEBHOOK_SECRET_TOKEN=...
# Optional: the Telegram user IDs that may press Approve and Reject
TELEGRAM_APPROVERS=123456789

ACTUATE_PAYMENT=billplz
BILLPLZ_API_KEY=...
BILLPLZ_COLLECTION_ID=...
BILLPLZ_X_SIGNATURE_KEY=...

ACTUATE_LLM=anthropic
ANTHROPIC_API_KEY=...
```

| Capability | Choose with | Providers |
| --- | --- | --- |
| `messaging` | `ACTUATE_MESSAGING` | `telegram`, `whatsapp`, `slack`, `discord`, `resend`, `custom-webhook` |
| `payment` | `ACTUATE_PAYMENT` | `stripe`, `toyyibpay`, `billplz`, `chip` |
| `llm` | `ACTUATE_LLM` | `anthropic`, `openai`, `google`, `openai-compatible` |

Credential variable names are `<KIND>_<FIELD>`, with any hyphen in the kind written as an underscore, for example `TELEGRAM_BOT_TOKEN`, `BILLPLZ_X_SIGNATURE_KEY`, `CUSTOM_WEBHOOK_URL`. The custom webhook reads `CUSTOM_WEBHOOK_URL`, and optionally `CUSTOM_WEBHOOK_SECRET`, `CUSTOM_WEBHOOK_HEADERS`, `CUSTOM_WEBHOOK_FORMAT`, `CUSTOM_WEBHOOK_TEMPLATE`, `CUSTOM_WEBHOOK_APPROVAL_TEMPLATE` and `CUSTOM_WEBHOOK_APPROVERS`; see [Send messages to any URL](/docs/guides/custom-webhook/#locally-and-self-hosted). For [approval buttons](/docs/guides/approval-buttons/), Telegram also reads `TELEGRAM_APPROVERS`, Slack reads `SLACK_SIGNING_SECRET` and `SLACK_APPROVERS`, and Discord reads `DISCORD_PUBLIC_KEY` and `DISCORD_APPROVERS`, all optional. `--json` prints each provider's kind, capability, label and variables. On the hosted platform you set providers in the dashboard instead (under Providers in Settings).

## actuate test

```bash
actuate test [files or folders...] [--watch] [--grep <pattern>] [--plan <plan>] [--offline] [--no-checks] [--pass-with-no-tests]
```

Runs the project's tests, with no setup. Requires `@actuate/cli` 0.3 or later.

- **Which files.** It runs every `*.test.ts` and `*.spec.ts` file (and `.js`, `.mts`, `.tsx` and the like) under the files and folders you name, or under the project if you name none. It skips `node_modules`, `dist`, `build`, `coverage`, `out` and folders whose name starts with a dot.
- **Which runner.** A file that imports `vitest` runs with the project's own Vitest (`vitest run`). Every other file runs with `node --test`, with TypeScript compiled on the fly, so `import actuator from "./actuator.js"` finds `actuator.ts`. Both can be in one project; `actuate test` runs one after the other. When Vitest isn't installed, the `node:test` files still run and the Vitest files are reported as skipped, with how to fix it (`npm install -D vitest`, or write them with `node:test`), and `actuate test` exits with status 1. With only Vitest files, that is an error.
- **`--watch`** (`-w`) re-runs the tests when files change. When the tests mix Vitest and `node:test`, it runs both watchers side by side; their output interleaves, and Ctrl-C stops both.
- **`--grep <pattern>`** (`-g`) runs only the tests whose name matches (`--test-name-pattern` for `node:test`, `-t` for Vitest).
- **`--plan <plan>`** sets the plan whose guards [`testActuator`](/docs/guides/best-practices/#unit-tests-with-testactuator) applies, passed to the tests as `ACTUATE_PLAN`. A test can pick its own with `testActuator(actuator, { plan })`. See [which plan applies](#which-plan-applies). `--offline` skips the API. When tests are about to run, `actuate test` prints the plan once, as `Platform guards: Sandbox plan (...)`.
- **Deploy checks.** Alongside the tests, it runs `actuator.ts`'s [deploy checks](#the-deploy-checks) locally, without the network, and prints them after the tests, only when they find something. They never fail the tests. `--no-checks` skips them, and `--watch` doesn't run them.
- **No tests.** With no test files it prints an example test to start from and exits with status 1, so an empty suite doesn't pass in CI. `--pass-with-no-tests` exits with status 0 instead.
- **Node.js before 22.13.** `actuate test` adds the flag `node:sqlite` needs there.

```text
Platform guards: Sandbox plan (the default: not logged in), unless a test passes testActuator(actuator, { plan }). Pass --plan maker or agency, or run `actuate login`, to use your plan.
✔ greets, sleeps, then follows up (22.038606ms)
✔ refuses an empty name before any code runs (2.950972ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 311.219531

Deploy checks for actuator.ts, Sandbox plan (the default: not logged in): 0 error(s), 1 warning(s). They don't fail the tests; `actuate check --platform` has the details.
  warn   The Sandbox plan cannot use messaging. Upgrade to Maker to use providers. That is only the default plan here: log in or pass --plan to check against yours.  (plan-capability)
```

It exits with status 1 when a test fails. Write tests with `testActuator` from `@actuate/cli/testing`. See [unit tests with testActuator](/docs/guides/best-practices/#unit-tests-with-testactuator).

## actuate check

```bash
actuate check [file] [--platform] [--plan <plan>] [--offline] [--json]
```

`check` is a replay-safety linter. The runtime [replays `run` from the top](/docs/concepts/steps-and-replay/) after every pause, so side effects and non-determinism must be inside `ctx.step.do`. `check` parses the file, inspects the `run` function of the object passed to `defineActuator`, and flags these outside a step:

| Rule | Severity | Flags |
| --- | --- | --- |
| `no-fetch-outside-step` | error | `fetch()` and `globalThis.fetch()` |
| `no-provider-outside-step` | error | Calls on `ctx.messaging`, `ctx.payment`, `ctx.llm` or `ctx.http` |
| `no-nondeterminism-outside-step` | error | `Date.now()`, `new Date()` with no arguments, `Math.random()`, `crypto.randomUUID()`, `performance.now()` |
| `no-commit-outside-step` | error | `ctx.db.commitWithStep()`, which queues writes for the step that is running |
| `no-notify-outside-step` | error | `ctx.notifyOwner()`, which sends a message, so outside a step it would send again on every replay |
| `db-write-outside-step` | warning | `ctx.db.query`, `ctx.db.first` or `` ctx.db.sql`...` `` whose SQL literal starts with `INSERT`, `UPDATE`, `DELETE` or `REPLACE`, and each such statement in a `ctx.db.batch([...])`, written as `` ctx.db.statement`...` `` or `{ sql: "..." }` |

Everything inside the function passed as the last argument of `ctx.step.do` counts as inside a step. `check` doesn't flag a statement built with `` ctx.db.statement`...` `` on its own, because building one does nothing until it runs.

```text
actuator.ts:14:5  error  ctx.messaging.send() must be called inside ctx.step.do.  (no-provider-outside-step)
actuator.ts:20:5  warn   This write runs again on every replay. Put it inside ctx.step.do.  (db-write-outside-step)

1 error(s), 1 warning(s)
```

`check` also warns when `actuate.config.json` sets a value for a [`secret()`](/docs/reference/sdk/#secret) field and git would commit the file, which happens when the project is a git repository and the file isn't ignored. It reports the warning on `actuate.config.json` with the rule `config-secret`. Set those values in the dashboard instead (see [keys and tokens](/docs/concepts/capabilities/#keys-and-tokens)). It loads the actuator only when the file holds a value and git would commit it. With `--platform`, the same warning is one of the deploy checks.

```text
actuate.config.json:1:1  warn   actuate.config.json sets the secret field apiKey, and git does not ignore the file, so it would be committed. Set it in the dashboard (Config tab) and leave it out of the file: the platform keeps a stored secret when the file omits it. For `actuate dev`, put it in .dev.vars as ACTUATE_CONFIG.  (config-secret)
```

`check` exits with status 1 when there are errors, so you can run it in a pre-commit hook. It is a syntactic check of one file. It does not follow calls into helper functions, and it only recognises SQL written as a string literal. The runtime still enforces the provider rule at run time.

### The deploy checks

`--platform` also bundles the actuator and runs the hosted platform's deploy checks on it, locally. Every deploy attempt counts against your plan's [deploy budget](/docs/reference/limits/#plans), including attempts the platform refuses, so this is how you find out without spending one. Requires `@actuate/cli` 0.3 or later.

| Rule | Checks | Needs |
| --- | --- | --- |
| `bundle-size` | The bundle is at most 5 MB | |
| `name` | The name is lowercase letters, digits and underscores, at most 64 characters, and doesn't start with `actuate_`, which the hosted platform keeps for its built-in MCP tools (`actuate_get_run`, `actuate_list_runs`, `actuate_cancel_run`) and refuses at deploy. Self-hosted actuators may still use the prefix | |
| `cron` | Cron syntax, the number of schedules, and how often they fire, alone and together | The plan |
| `cron-input` | The input schema accepts `{}`, the input every cron run gets (a warning). An actuator with [`idempotencyKey`](/docs/reference/sdk/#idempotencykey) fields can't accept it, because those fields are required. Cron runs never use the key either. So the warning says to move the schedule to an actuator of its own | |
| `idempotency-key` | Every [`idempotencyKey`](/docs/reference/sdk/#idempotencykey) field is a top-level, required field of the input schema (no `.optional()`, no `.default()`), and a string, number, integer or boolean (`@actuate/cli` 0.5 or later) | |
| `http-allow` | `http.allow` has at most 20 hostnames, no IP addresses, no `actuate.run`, no wildcard over a shared zone such as `*.co.uk` or `*.workers.dev` | |
| `input-regex` | No regex in the input schema with nested quantifiers, such as `(a+)+` (Zod's built-in formats are fine) | |
| `plan-capability` | Every capability in `capabilities` is on the plan; optional capabilities that aren't get a warning | The plan |
| `config` | `actuate.config.json` is valid JSON and matches the config schema. It reports invalid JSON by line and column, never by quoting the text around the error, which could be part of a secret | |
| `config-secret` | `actuate.config.json` sets no `secret()` field while git would commit it (a warning; checked locally only, also with `--no-config`, and once when `actuate dev` starts) | |
| `secret-default-not-redacted` | No `secret()` field has a default that redaction can't hide: a boolean, or a value shorter than 6 characters. A default on a parent object counts for the secret fields it sets (a warning; `@actuate/cli` 0.4.1 or later) | |
| `provider-missing` | A provider is set up in the dashboard for every required capability | Login |
| `actuator-limit` | A new actuator fits the plan's number of actuators | Login |
| `deploy-budget` | Deploy attempts are left this month (an error when none are, a warning from 90% used) | Login |

The checks mirror the platform's rules. The platform runs its own checks again on upload, and its result is the one that counts. Without a login, or with `--offline`, `check` skips the last three, and the output says so. When you are logged in, it also skips a lookup that fails, with a `skipped` line saying why.

With `--plan sandbox`:

```text
✓ No replay-safety problems found
Bundled reminders: 283.2 KiB, sha256 bb42f71f8506
Deploy checks for the Sandbox plan (from --plan). The provider, actuator-count and deploy-budget checks need a login (`actuate login`).
  error  Cron "*/5 * * * *" fires more often than every 60 min. The Sandbox plan allows 3 schedules, at least 60 min apart.  (cron)
  warn   Every cron run starts with the input {}, which the input schema rejects, so every firing fails. Make the fields optional or give them defaults.  (cron-input)
  error  http.allow entry "10.0.0.1": IP addresses are not allowed.  (http-allow)
  error  The Sandbox plan cannot use messaging. Upgrade to Maker to use providers.  (plan-capability)

3 error(s), 1 warning(s)
```

The plan is the one [that applies](#which-plan-applies). `--plan` checks against another. When no plan was chosen, the plan's own rules (its cron limits and capabilities) are warnings, ending `That is only the default plan here: log in or pass --plan to check against yours.` `--plan` and `--offline` imply `--platform`. `check --platform` exits with status 1 when either the linter or the deploy checks find an error.

`--json` prints one object. Without `--platform`, it is `{ ok, file, diagnostics, errors, warnings }`. With it, the object also has `platform: { plan, planSource, issues, skipped }`, where `planSource` is `--plan`, `ACTUATE_PLAN`, `account`, `saved` or `default`, and each issue is `{ severity, rule, message }`.

## actuate deploy

```bash
actuate deploy [file] [--dry-run] [--no-config] [--plan <plan>] [--force] [--json]
```

Deploys the actuator to Actuate. It needs [`actuate login`](#actuate-login) or `ACTUATE_API_TOKEN`, except with `--dry-run`.

1. Runs `actuate check` and stops if there are errors.
2. Bundles the file into a single ES module, with the SDK and Zod included, and hashes it. It minifies whitespace and syntax but keeps names, so stack traces stay readable, and it leaves out Zod's non-English locales.
3. Reads the actuator's metadata: name, description, capabilities, `http.allow`, cron schedules, hints, `idempotencyKey` when you declare it, and the input, config and output schemas as JSON Schema.
4. Runs the [deploy checks](#the-deploy-checks), including the ones that need your account, and stops if any fails. A refused deploy would still count against your deploy budget. `--force` deploys anyway.
5. If the deployed version already runs exactly this code, it uploads nothing and uses no deploy. It updates the configuration when `actuate.config.json` differs from the deployed one, and otherwise does nothing. It leaves secret fields out of that comparison, because the platform shows them as `null`. It sends a file that leaves every secret field out only when something else changed, and the platform keeps the stored secrets. It always sends a file that mentions a secret field at all (a value, `null`, or `""` or `[]` to clear it). See [keys and tokens](/docs/concepts/capabilities/#keys-and-tokens) for how the platform merges it. `--force` deploys anyway.
6. Uploads the bundle with `actuate.config.json` as the configuration, unless you pass `--no-config`.
7. Prints the version number, the actuator's webhook, MCP, OpenAPI and dashboard URLs, any warnings from the platform, and, when your account reports it, the deploys you have used this month.

```text
Bundled hello: 283.8 KiB, sha256 d27b2079d485
Deploy checks for the Maker plan (from your account).
  ✓ passes the platform's deploy checks (mirrored locally; the platform has the final say)

✓ Deployed hello v1

  Webhook   https://run.actuate.run/a/act_.../webhook
  MCP       https://run.actuate.run/a/act_.../mcp
  OpenAPI   https://run.actuate.run/a/act_.../openapi.json
  Dashboard https://app.actuate.run/...

  Deploys this month: 13 of 2,000
```

When the code hasn't changed:

```text
✓ hello v1 already runs this code: updated its configuration only (no deploy used).
✓ Nothing to deploy: hello v1 already runs this code and configuration. Pass --force to deploy anyway.
```

When a check fails, `deploy` exits with status 1 before uploading:

```text
✗ The platform would refuse this deploy (4 errors), and a refused deploy still counts against your deploy budget. Fix them, or pass --force to deploy anyway.
```

`--force` doesn't skip step 1, so replay-safety errors always stop a deploy.

`--dry-run` runs steps 1 to 4 and prints the metadata as JSON, without uploading. It needs no login and doesn't count against the deploy budget. When you are logged in, it reads your account to run the account checks. It exits with status 1 when a check fails.

After the metadata, `--dry-run` prints the MCP tool entry that agents will see in `tools/list`, built the way the hosted MCP server builds it (`@actuate/cli` 0.5 or later). It has the name, the title (the name with underscores turned into spaces), the description, the input schema, the output schema when it describes an object, and all four [annotations](/docs/concepts/mcp-and-openapi/#tool-hints):

```text
MCP tool entry (tools/list), as agents will see it:
{
  "name": "refund_order",
  "title": "refund order",
  "description": "Refund an order.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "orderId": {
        "type": "string",
        "description": "The order to refund"
      },
      "amount": {
        "type": "number",
        "exclusiveMinimum": 0
      }
    },
    "required": [
      "orderId",
      "amount"
    ]
  },
  "annotations": {
    "title": "refund order",
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  }
}
```

Here `idempotentHint` is `true` because the actuator declares `idempotencyKey: ["orderId"]` and no `hints.idempotent`.

`--plan` runs the checks against another plan than [yours](#which-plan-applies). The platform still uses your account's plan.

`--json` prints one object instead of text: `ok`, `name`, `diagnostics`, `bundle` (`bytes`, `sha256`), `plan` (`id`, `source`), `issues`, and `deployed` (`version`, `sameCode`) when the actuator is already deployed. Then, for a dry run, `dryRun: true`, `metadata` and `mcpTool`, the MCP tool entry; for an upload, `deployedNow: true`, `version`, `urls` and `warnings`; and when the code was unchanged, `deployedNow: false`, `configUpdated` and `version`. A deploy the checks stop prints `{ "ok": false, "error", ... }` with the same fields. A deploy that replay-safety errors stop prints `{ "ok": false, "error", "diagnostics" }`.

## actuate run

```bash
actuate run ['<json>'] [--local] [--idempotency-key <key>] [--json]
```

Starts a run with the given JSON input (default `{}`), waits for its first pass, and prints where it got to: its status, passes, and under `actuate dev` the rows it read and wrote, then its steps, log lines, output or error, and the command that moves it on if it is waiting. Quote the JSON in single quotes.

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

A run waiting for a person or an event says what to run next:

```text
Next
  actuate approve run_01a1a2e8d98593acc562658db50c --step manager-ok --local    (or: actuate reject ...)
```

- `--json` prints the run record as `POST /run` returned it instead (`runId`, `status`, `output`, `error`, `passes`, and `usage` under `actuate dev`), whatever its status. For its steps and logs, use `actuate logs <runId> --json`. Before `@actuate/cli` 0.3, `actuate run` printed the record by default; scripts that read its output need `--json` now.
- `--idempotency-key <key>` sends an [`Idempotency-Key`](/docs/concepts/triggers/#idempotency-key), so a retry with the same key returns the first run instead of starting another.
- On the hosted platform, `actuate run` without `--idempotency-key` always starts a new run, even when the actuator declares [`idempotencyKey`](/docs/reference/sdk/#idempotencykey) fields. With `--local`, it calls `POST /run` on `actuate dev` like any other client, so a repeat of the same key fields' values returns the first run while it is running or waiting, or for 24 hours after it completed. Pass a new `--idempotency-key` to start another.
- `run` exits with status 1 if the run ended `FAILED`, and when the input fails the schema, which prints each problem, for example `name: Too small: expected string to have >=1 characters`.
- With `--local` it targets `actuate dev` on `localhost:<port>`, and otherwise the deployed actuator.

## actuate logs

```bash
actuate logs [runId] [--local] [--status <status>] [--limit <n>] [--json]
```

Without a run ID, it lists recent runs, newest first: ID, status, passes, start time and trigger. Under `actuate dev` (`--local`) it also shows the rows each run wrote and read:

```text
RUN                               STATUS     PASSES  ROWS W/R  STARTED                   TRIGGER
run_01a1a2e8fd74368013e670732682  CANCELLED  1       7/14      2026-11-03T19:35:40.660Z  api
run_01a1a2e8fc4040043bd1f26a7140  COMPLETED  2       11/16     2026-11-03T19:35:40.352Z  api
run_01a1a2e8fb8561faf9fb3d4d8daf  FAILED     1       2000/6    2026-11-03T19:35:40.165Z  api
```

- `--status` lists only runs with that status: `RUNNING`, `WAITING`, `COMPLETED`, `FAILED` or `CANCELLED`.
- `--limit` sets how many runs to list (default 20, at most 500).

With a run ID, it prints the run as [`actuate run`](#actuate-run) does: its status, passes and rows, each step in the journal with its status and error, the log lines, and its output or error. It prints a log line's `data` as JSON on the line below it:

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

It exits with status 1 if the run ended `FAILED`. `--json` prints the raw records.

`logs` shows rows only under `actuate dev`, because the hosted API doesn't report them per run yet. For the deployed actuator, the line shows passes only. Approval links are never in the logs. See [Human approvals](/docs/concepts/approvals/#getting-the-links).

## actuate event

```bash
actuate event <key> ['<json>'] [--local] [--json]
```

Posts an event with the JSON payload (default `{}`). Every step waiting for `key` completes with the payload and its run resumes. If none is waiting, the runtime buffers the event for the next wait. Requires `@actuate/cli` 0.3 or later.

```text
✓ order.shipped.A-1002: resumed run_01a1a2e8db32732cfbbb0eefb6e5

See where it got to: actuate logs run_01a1a2e8db32732cfbbb0eefb6e5 --local
```

```text
No run is waiting for order.shipped.ZZZ: buffered, so a run that waits for it later gets it at once.
```

Under `actuate dev`, the event `payment.<referenceId>` pays the fake payment provider's bills, for example `actuate event payment.A-1001 '{"status":"paid"}' --local`. `--json` prints `{ "resumed": [...], "buffered": ... }`. On the deployed actuator it needs a full token, because agent tokens can't post events.

## actuate approve

```bash
actuate approve <runId> [--step <name>] [--note <text>] [--local] [--json]
```

Approves a run waiting in `waitForApproval`, without the signed link, then prints the run as [`actuate run`](#actuate-run) does. Requires `@actuate/cli` 0.3 or later.

- `--step` names the waiting step. You only need it when the run waits at several; otherwise `approve` finds the step itself.
- `--note` reaches the run in [`ApprovalResult.note`](/docs/reference/sdk/#approvalresult).
- The run records the decision as made through the API (`via: "api"`), by the account that owns the token.

```text
✓ Approved "manager-ok"

run_01a1a2e8d98593acc562658db50c  COMPLETED  api  2026-11-03T19:35:31.461Z
  2 passes · 15 rows written · 18 rows read
  step  COMPLETED        manager-ok
  step  COMPLETED        record
  ...
  output {"approved":true,"note":"ok, refund it"}
```

`approve` exits with status 1 if the run isn't waiting for an approval (`run_... is COMPLETED and waits for no approval.`) or ends `FAILED`, and with status 2 if it waits at several steps and you didn't pass `--step`. On the deployed actuator it needs a full token, because agent tokens can't approve.

## actuate reject

```bash
actuate reject <runId> [--step <name>] [--note <text>] [--local] [--json]
```

Rejects a run waiting in `waitForApproval`. It works as [`actuate approve`](#actuate-approve) does, with the same options and exit codes, and the run's `waitForApproval` resolves to `{ approved: false }`. Requires `@actuate/cli` 0.3 or later.

## actuate answer

```bash
actuate answer <runId> <text> [--step <name>] [--local] [--json]
```

Answers a run waiting in `waitForInput` with `text`, then prints the run. `--step` works as for [`actuate approve`](#actuate-approve). Quote the answer: `actuate answer run_... "Tell them it ships Monday" --local`. Requires `@actuate/cli` 0.3 or later.

## actuate cancel

```bash
actuate cancel <runId> [--local] [--json]
```

Cancels a `RUNNING` or `WAITING` run, which then never wakes. It prints `✓ Cancelled <runId>`, or exits with status 1 if the run had already settled and there was nothing to cancel. `--json` prints `{ "cancelled": true }` or `false`. Requires `@actuate/cli` 0.3 or later.

## actuate login

```bash
actuate login [--token <token>] [--api <url>]
```

Saves an API token for `deploy`, `run`, `logs` and the other commands that reach your account. Without `--token` it prompts for one. Create it in the dashboard under API tokens in Settings, choosing **Full**. You sign in to the dashboard with Google or another social login. The CLI and agents use API tokens instead.

There are two kinds of token:

| Token | For | Can |
| --- | --- | --- |
| **Agent** (run-scoped; the default for new tokens) | Agents and MCP clients | Start and read runs on `run.actuate.run`, and cancel the runs it started if you [allow it](/docs/concepts/agents/#cancelling-runs). Nothing else, so no approving, posting events, deploying, configuration or management |
| **Full** | The CLI and management | Everything your account can do, including `deploy` and fetching approval links |

`actuate login` needs a **full** token, and checks it before saving it. It refuses a token the API rejects, and an agent token (`That is an agent (run-scoped) token: it can only start and read runs. Create a Full token for the CLI.`). If the API can't be reached, it warns and saves the token anyway. Give agents Agent tokens, or let MCP clients that support it [sign in](/docs/guides/connect-your-agent/#sign-in-from-your-mcp-client) instead. Each sign-in becomes an agent token you can revoke. `--api` overrides the API URL (default `https://api.actuate.run`).

```text
✓ Logged in as aina@example.com (maker plan). Saved to /home/aina/.config/actuate/credentials.json
```

`actuate login` writes credentials to `$XDG_CONFIG_HOME/actuate/credentials.json`, or `~/.config/actuate/credentials.json`, with mode `0600`. The file also keeps your account's email and plan, so the commands can use your plan's limits when the API can't be reached, or with `--offline`. Every command that reads your account updates it.

## Which plan applies

`dev`, `test`, `check --platform`, `deploy` and `doctor` apply a plan's rules: its guards, cron limits, capabilities and deploy budget. They use the first of:

1. `--plan sandbox|maker|agency`.
2. The `ACTUATE_PLAN` environment variable.
3. Your account's plan, when you are logged in. Every one of these commands asks the API (`GET /v1/me`), and uses the limits it reports. If the API doesn't answer within 3 seconds, or can't be reached, it uses the plan saved by your last `actuate login`, or by the last command that read your account. With `ACTUATE_API_TOKEN`, the commands save nothing.
4. The Sandbox, the strictest plan.

`--offline` (on `dev`, `test`, `check` and `doctor`) skips the API. The plan comes from `--plan`, `ACTUATE_PLAN` or the plan saved at login, and the commands skip the checks that need your account. `deploy` and `doctor` ask the API for your account's usage even when `--plan` or `ACTUATE_PLAN` decides the plan, and so does `check --platform`.

Each command prints which plan it used and why, for example `Maker plan (from your account)`, `Maker plan (saved at your last login, as the API couldn't be reached)` or `Sandbox plan (the default: not logged in)`. Any other `--plan` or `ACTUATE_PLAN` value exits with status 2.

When the plan is only the default, nobody chose it, so its own rules (capabilities and cron limits) are warnings instead of errors in `check`, `test`, `dev`, `doctor` and `deploy --dry-run`. So a fresh project from a template that sends messages passes `npm run check`, and `actuate dev` doesn't refuse its providers. With a plan you chose, by flag, environment variable or login, they are errors.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ACTUATE_API_TOKEN` | A full API token. Takes precedence over the saved credentials, which is useful in CI |
| `ACTUATE_API_URL` | API URL. Overrides the saved or default URL (`https://api.actuate.run`) |
| `ACTUATE_PLAN` | `sandbox`, `maker` or `agency`, the plan whose rules apply when you pass no `--plan`. See [which plan applies](#which-plan-applies) |
| `ACTUATE_DEBUG` | Set to any value to print the stack trace of an unexpected error, for a bug report |
| `XDG_CONFIG_HOME` | Where the credentials file is stored |
