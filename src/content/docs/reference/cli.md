---
title: CLI
description: The actuate command - init, dev, check, deploy, run, logs and login.
---

The CLI ships as `@actuate/cli` and installs the `actuate` command. Projects created with `npm create actuate` list it as a dev dependency, so run it with `npx actuate` or through the `package.json` scripts (`npm run dev`, `npm run check`, `npm run deploy`). It needs Node.js 20 or later.

:::caution
Outside a project that has `@actuate/cli` installed, don't run a bare `npx actuate`: the unscoped `actuate` package on npm is an unrelated library. Install the CLI with `npm install -g @actuate/cli`, or use `npx @actuate/cli <command>`.
:::

```text
actuate init [dir] [--template <name>]   Create a new actuator project
actuate dev [file] [--port 8787]         Run locally on workerd
actuate check [file]                     Lint for replay-safety
actuate deploy [file] [--no-config]      Deploy to Actuate
actuate run '<json>' [--local]           Start a run with this input
actuate logs [runId] [--local]           List recent runs, or show one run
actuate login [--token <t>] [--api <url>]
```

`[file]` defaults to `actuator.ts`. `actuate --help` prints the list.

## actuate init

```bash
actuate init [dir] [--template <name>]
```

Creates a project in `dir` (default: the current directory), which must be empty apart from `.git`. Without `--template` (`-t`) it writes the built-in `hello` starter; with one, it downloads `actuator.ts`, and `README.md`, `.env.example` and `actuate.config.json` when present, from the folder of that name in [actuate-run/templates](https://github.com/actuate-run/templates).

The project contains `actuator.ts`, `actuate.config.json` (`{}`), `package.json`, `tsconfig.json` and a `.gitignore` that excludes `node_modules/`, `.actuate/`, `.dev.vars` and `.env`.

`npm create actuate [dir] -- [--template <name>] [--ref <git-ref>]` does the same without installing the CLI first. Its default directory is `my-actuator`, and `--ref` picks a branch or tag of the templates repository (default `main`).

## actuate dev

```bash
actuate dev [file] [--port 8787]
```

Runs the actuator locally on `workerd` (through wrangler) with the same step engine, a real SQLite-backed Durable Object and real alarms.

- Runs [`actuate check`](#actuate-check) first and prints any problems, without stopping.
- Bundles the file and rebuilds on every save.
- Serves the [runtime HTTP API](/docs/reference/runtime-http/) at `http://localhost:<port>`.
- Configuration: `actuate.config.json`, passed as `ACTUATE_CONFIG`.
- Environment: variables from `.env` and then `.dev.vars` in the project directory. `actuate dev` sets `ACTUATE_DEV=1`, so the admin routes and `/webhook` work without secrets locally. Set `ACTUATE_TOKEN` or `ACTUATE_WEBHOOK_SECRET` there to require them anyway.
- Providers: pick real ones in `.dev.vars` (see [`actuate providers`](#actuate-providers)). Anything you don't pick stays local: messages (and approval links) print in the terminal, and the payment provider is a fake whose bill URL is `http://localhost:<port>/events/payment.<referenceId>`; open it to "pay". Declared `http` uses your `http.allow` list for real. `ctx.llm` needs `ACTUATE_LLM` set; otherwise calls fail with "no llm provider is configured".
- Payment webhooks: real payment providers call back to `POST /providers/<kind>/webhook`. Expose your local port with a tunnel (e.g. `cloudflared tunnel --url localhost:8787`) and set `ACTUATE_PUBLIC_URL` to the tunnel URL so callback links point there.
- Cron schedules are registered. Fire one with `curl 'localhost:8787/__scheduled?cron=<expression>'`.
- State persists in `.actuate/state` between restarts. Delete the folder to start fresh.

Configuration and environment files are read at startup; restart `actuate dev` after changing them.

## actuate providers

```bash
actuate providers
```

Lists every provider and the variables it reads. Choose one per capability in `.dev.vars`, then add its credentials:

```bash
# .dev.vars (never commit this file)
ACTUATE_MESSAGING=telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
# Only to receive messages: any random string, also passed to setWebhook
TELEGRAM_WEBHOOK_SECRET_TOKEN=...

ACTUATE_PAYMENT=billplz
BILLPLZ_API_KEY=...
BILLPLZ_COLLECTION_ID=...
BILLPLZ_X_SIGNATURE_KEY=...

ACTUATE_LLM=anthropic
ANTHROPIC_API_KEY=...
```

| Capability | Choose with | Providers |
| --- | --- | --- |
| `messaging` | `ACTUATE_MESSAGING` | `telegram`, `whatsapp`, `resend` |
| `payment` | `ACTUATE_PAYMENT` | `stripe`, `toyyibpay`, `billplz`, `chip` |
| `llm` | `ACTUATE_LLM` | `anthropic`, `openai`, `google` |

Credential variable names are `<KIND>_<FIELD>`, e.g. `TELEGRAM_BOT_TOKEN`, `BILLPLZ_X_SIGNATURE_KEY`. On the hosted platform you set providers in the dashboard instead (Settings → Providers).

## actuate check

```bash
actuate check [file]
```

A replay-safety linter. `run` is [replayed from the top](/docs/concepts/steps-and-replay/) after every pause, so side effects and non-determinism must sit inside `ctx.step.do`. `check` parses the file and inspects the `run` function of the object passed to `defineActuator`, flagging these outside a step:

| Rule | Severity | Flags |
| --- | --- | --- |
| `no-fetch-outside-step` | error | `fetch()` and `globalThis.fetch()` |
| `no-provider-outside-step` | error | Calls on `ctx.messaging`, `ctx.payment`, `ctx.llm` or `ctx.http` |
| `no-nondeterminism-outside-step` | error | `Date.now()`, `new Date()` with no arguments, `Math.random()`, `crypto.randomUUID()`, `performance.now()` |
| `db-write-outside-step` | warning | `ctx.db.query`, `ctx.db.first` or `` ctx.db.sql`...` `` whose SQL literal starts with `INSERT`, `UPDATE`, `DELETE` or `REPLACE` |

Everything inside the function passed as the last argument of `ctx.step.do` counts as inside a step.

```text
actuator.ts:14:5  error  ctx.messaging.send() must be called inside ctx.step.do.  (no-provider-outside-step)
actuator.ts:20:5  warn   This write runs again on every replay. Put it inside ctx.step.do.  (db-write-outside-step)

1 error(s), 1 warning(s)
```

`check` exits with status 1 when there are errors, so you can run it in a pre-commit hook. It is a syntactic check of one file: it does not follow calls into helper functions, and it only recognises SQL written as a string literal. The runtime still enforces the provider rule at run time.

## actuate deploy

```bash
actuate deploy [file] [--no-config] [--dry-run]
```

Deploys the actuator to Actuate.

1. Runs `actuate check` and stops if there are errors.
2. Bundles the file into a single ES module, with the SDK and Zod included, and hashes it. Whitespace and syntax are minified but names are kept, so stack traces stay readable, and Zod's non-English locales are left out.
3. Reads the actuator's metadata: name, description, capabilities, `http.allow`, cron schedules, and the input, config and output schemas as JSON Schema.
4. Uploads the bundle with `actuate.config.json` as the configuration, unless you pass `--no-config`.
5. Prints the version number and the actuator's webhook, MCP, OpenAPI and dashboard URLs, plus any warnings from the platform.

`--dry-run` stops after step 3 and prints the metadata without uploading. Requires [`actuate login`](#actuate-login) or `ACTUATE_API_TOKEN`.

## actuate run

```bash
actuate run '<json>' [--local] [--port 8787] [--name <actuator>]
```

Starts a run with the given JSON input (default `{}`) and prints the run record. With `--local` it targets `actuate dev` on `localhost:<port>`; otherwise the deployed actuator, whose name is read from `name:` in `actuator.ts` unless you pass `--name`.

## actuate logs

```bash
actuate logs [runId] [--local] [--port 8787] [--name <actuator>]
```

Without a run ID, lists the 20 most recent runs: ID, status, start time and trigger. With one, prints the run's status, each step in the journal with its status and error, the log lines, and the run's error if it failed. A log line's `data` is printed as JSON on the line below it:

```text
run_01a1998e44009c41f2e07b3d5a18  WAITING
  step  WAITING_APPROVAL manager-ok
  2026-11-02T00:00:00.000Z  info  Approval requested for "manager-ok"
        {"step":"manager-ok","expiresAt":1793664000000}
```

Approval links are never in the logs; see [Human approvals](/docs/concepts/approvals/#getting-the-links).

`--local` and `--name` work as for `actuate run`.

## actuate login

```bash
actuate login [--token <token>] [--api <url>]
```

Saves an API token for `deploy`, `run` and `logs`. Without `--token` it prompts for one; create it in the dashboard settings. You sign in to the dashboard with Google or another social login; the CLI and agents use API tokens instead.

There are two kinds of token:

| Token | For | Can |
| --- | --- | --- |
| **Run** (the default for new tokens) | Agents and MCP clients | Start and read runs on `run.actuate.run`. Nothing else: no approving, deploying, configuration or management |
| **Full** | The CLI and management | Everything your account can do, including `deploy` and fetching approval links |

`actuate login` needs a **full** token. Give agents run tokens. `--api` overrides the API URL (default `https://api.actuate.run`).

Credentials are written to `$XDG_CONFIG_HOME/actuate/credentials.json`, or `~/.config/actuate/credentials.json`, with mode `0600`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ACTUATE_API_TOKEN` | A full API token. Takes precedence over the saved credentials; useful in CI |
| `ACTUATE_API_URL` | API URL. Overrides the saved or default URL (`https://api.actuate.run`) |
| `XDG_CONFIG_HOME` | Where the credentials file is stored |
