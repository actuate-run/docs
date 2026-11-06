---
title: Limits
description: CPU and memory per invocation, outbound HTTP rules, plan limits, the hosted platform's guards, and the limits built into the SDK and runtime.
---

Actuate is built so that one actuator cannot hurt you, another tenant or the platform. **Every limit is a hard stop, not an overage charge.** Work pauses or is refused, and nothing is ever billed beyond your plan.

For what uses each budget and how to write actuators that stay well inside them, see [Write efficient actuators](/docs/guides/best-practices/).

## Per invocation

Each pass of a run executes in its own V8 isolate with:

| Limit | Value |
| --- | --- |
| CPU time | 50 ms |
| Heap | 64 MB |

CPU time is time spent executing your code, not time spent waiting on the network, a provider or the database. A run can last days, because each pass between waits is a separate invocation, and sleeps and waits use no CPU at all. Keep heavy computation small. Steps in one pass share one invocation, so more steps don't add CPU time. Process a bounded batch per run, or sleep between chunks so each starts a new pass (see [write efficient actuators](/docs/guides/best-practices/#guards-on-a-single-pass)).

The isolate's environment contains only your declared capability clients. There are no platform bindings, no other tenants' data, and no raw `fetch`.

## Outbound HTTP

- Outbound HTTP goes only to the domains you declare in `http.allow`, through `ctx.http`. See [Capabilities and providers](/docs/concepts/capabilities/#http).
- Only HTTPS is allowed, and `ctx.http` doesn't follow redirects.
- An actuator cannot call its own URL. `ctx.http` refuses the platform's own origin, and every call counts against the same quotas.
- On the platform, a pass may make at most 50 `ctx.http` requests, and requests count against the plan's monthly HTTP budget.
- `ctx.http` refuses IP addresses at call time.
- At deploy, `http.allow` may list at most 20 hostnames, with no IPs, no platform domains and no broad wildcards. See [Capabilities and providers](/docs/concepts/capabilities/#http).

## Plans

| | Sandbox | Maker | Agency (later) |
| --- | --- | --- | --- |
| Actuators | 2 | 15 | 50, grouped by client |
| Runs per month | 1,000 | 100,000 | 500,000 |
| Scheduled runs per month, apart from runs | 750 | None, they count as runs | None, they count as runs |
| SQLite per actuator | 25 MB | 500 MB | 5 GB |
| SQLite in total, all actuators | 50 MB | 500 MB | 5 GB, pooled |
| Providers | `http` to declared domains only | All | All |
| Longest sleep or wait | 7 days | Unlimited | Unlimited |
| Run rate | 60 per minute | 600 per minute | 1,200 per minute |
| Passes per month | 10,000 | 800,000 | 3,000,000 |
| Rows written per month | 250,000 | 4,000,000 | 15,000,000 |
| Rows read per month | 50,000,000 | 1,000,000,000 | 5,000,000,000 |
| Outbound HTTP requests per month | 25,000 | 2,000,000 | 10,000,000 |
| Passes per run | 200 | 1,000 | 1,000 |
| Cron schedules per actuator | 3 | 5 | 5 |
| Shortest cron interval, all schedules together | 1 hour | 1 minute | 1 minute |
| Open legacy SSE sessions | 2 | 5 | 20 |
| Deploys per UTC day (failed ones and rollbacks count) | 30 | 200 | 500 |
| Deploys per month (failed ones and rollbacks count) | 300 | 2,000 | 5,000 |
| Settled runs kept for | 7 days | 30 days | 90 days |
| Agent analytics kept for | 30 days | 60 days | 90 days |
| Where alerts go | Email | Email and one messaging channel | Email and one messaging channel |
| Alert emails per day | 20 | 100 | 300 |
| Test alerts per day | 10 | 10 | 10 |
| Days an earlier version runs next to the current one, per month | 100 | 1,000 | 3,000 |

- **Runs** count every run, including cron runs. On the Sandbox, a run a [cron schedule](/docs/concepts/triggers/#cron) starts counts against the month's 750 scheduled runs first, and against runs once those are used. Runs started any other way never use them. **Passes** count the first pass of a run and every wake-up after it. A pass that runs or waits longer than 5 seconds (on a slow API or LLM call) counts one more for every further 5 seconds, so a pass of 12 seconds counts as 3. The run page shows them next to the passes, as "+N for long passes". This counts toward the monthly budget only, not the passes per run. **Rows written** and **rows read** count every billed SQLite row your actuators write or read, journal included. **Outbound HTTP requests** count every `ctx.http` call. Provider calls (messaging, payment, LLM) do not count.
- The platform checks the SQLite total when a run starts, and the per-actuator size before each run and after every statement.
- The free Sandbox has no messaging, payment or LLM providers. It is for building and exposing MCP tools, not for sending messages or taking payments.
- The run rate is a sliding window per account.
- **Actuators** count every actuator you have deployed, paused ones included. [Deleting one](/docs/reference/platform-api/#deleting-an-actuator) frees its place at once; its usage this month still counts.
- A [retry](/docs/guides/retry-and-rollback/) from the failed step, each run in a bulk retry, and **Run again** each count as one run, against runs per month and the run rate. A rollback counts as a deploy.
- The platform emails [alerts](/docs/guides/alerts/) on every plan, and Maker and Agency can also send them to one of your messaging channels. Alert emails (test alerts included) are capped per day (UTC). The last one says so, and alerts after it still reach your messaging channel and the dashboard. The platform keeps [agent analytics](/docs/concepts/agents/#analytics) for the period above.
- A run finishes on the version it started on (see [version pinning](/docs/guides/retry-and-rollback/#runs-stay-on-their-version)). Each day an earlier version has runs waking next to the current one counts once against the monthly allowance above (a rollback to the same code doesn't count). After that, those runs fail with a message saying so, and a retry moves them to the current version. Runs on the current version are never affected.
- Agency also adds client portals, the approval queue, a white-label domain (portals, webhook URLs, provider callbacks and approval links on your own domain), and Excel and SQLite exports. It arrives with Stage 2.

Billing is through Stripe. Paid plans are billed on the 1st of each month (UTC), the day monthly limits reset; your first charge covers the rest of the month you upgrade in, pro rata. See [actuate.run](https://actuate.run) for prices.

## Guards on the hosted platform

You can hit most of these locally first. With `@actuate/cli` 0.3 or later, `actuate dev` and `actuate test` apply the per-pass guards, the 1 MiB step result limit, the SQL refusals, and the plan's longest wait, passes per run and retry cap, with the platform's messages. `actuate dev` also prints the deploy checks at startup, and `actuate check --platform` and `actuate deploy` run them before they upload anything: cron schedules, `http.allow`, input regexes, capabilities on the plan, the configuration and, when you are logged in, providers, the actuator count and the deploy budget. The local tools don't mirror the CPU limit, the monthly budgets or the database size. See [guards in actuate dev](/docs/reference/cli/#guards-in-actuate-dev) and [the deploy checks](/docs/reference/cli/#the-deploy-checks).

| Situation | What happens |
| --- | --- |
| Monthly runs used up | New runs are refused and waiting runs pause until the monthly reset. No run is lost. On the Sandbox, runs your schedules start keep starting and running until the month's 750 scheduled runs are used too |
| Monthly passes, rows written, rows read or HTTP requests used up (sleep loops, event storms, heavy queries, request floods) | Passes wait until the monthly reset. No run is lost |
| One run loops forever | It fails after the plan's passes per run |
| One pass does too much host work | A pass may run at most 1,000 database statements (each statement in a `ctx.db.batch` or `commitWithStep` counts as one), write 1,000 steps, write 20,000 rows, read 5,000,000 rows, make 50 HTTP requests, and take 30 seconds of wall time. After a pass ends, its database and provider clients stop working, even if your code is still running |
| Passes keep exceeding the CPU limit | The host cuts short a pass whose work exceeds its CPU limit, and the pass still counts against your budgets. After 3 in a row the platform pauses the actuator, with the reason shown in the dashboard. Fix it and resume. Deploying or resuming starts the count again |
| One SQL statement does unbounded work | The platform refuses these before they run: recursive queries (including self-referencing CTEs without `RECURSIVE`), `randomblob`/`zeroblob`/`printf`/`format`, `PRAGMA`/`ATTACH`/`DETACH`/`VACUUM`, and transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`; use [`ctx.db.batch`](/docs/concepts/database/#atomic-writes) instead). Bound parameters may total at most 1 MiB per statement. See [Database](/docs/concepts/database/#what-the-platform-refuses) |
| Large step results | One step's stored result is at most 1 MiB |
| Retry storms | A step may retry at most 10 times, with exponential backoff |
| Long waits on the Sandbox | Sleeps, and waits with a timeout or deadline, longer than 7 days fail with `ActuatorError`; open-ended waits time out at 7 days |
| Slow regular expressions in input schemas | The deploy refuses a hand-written pattern with nested quantifiers, such as `(a+)+` or `(\w*)*`, which can backtrack for minutes on a crafted input. Zod's built-in formats (`z.email()`, `z.uuid()`, `z.iso.datetime()` and the like) are allowed. Rewrite the pattern without a repeated group that itself repeats |
| Cron too frequent | The deploy refuses an actuator with more schedules than the plan allows, or whose schedules together fire more often than the plan's minimum interval |
| Too many SSE sessions | The platform refuses one more than the plan's limit with `429`. Use the streamable HTTP endpoint |
| Agents approving their own gates | Run tokens (the default) can only start and read runs, and cancel the runs they started if you [allow it](/docs/concepts/agents/#cancelling-runs). They cannot approve, answer questions or post events (such as a faked `payment.<ref>`). Approval links never appear in run logs |
| Broad outbound access | The deploy validates `http.allow` |
| Event spam or large payloads | At most 1,000 buffered events per actuator (oldest dropped), 64 KiB per event payload, 256 KiB per request body (the platform refuses larger run starts with `413`, `PAYLOAD_TOO_LARGE`) |
| Unauthenticated endpoints called too often | Provider webhooks are limited to 120 and approval link `POST`s to 30 per minute |
| Journals grow without bound | The platform deletes settled runs, with their steps and logs, after the plan's retention period. It never touches your tables |
| Database growth | The platform checks each actuator's SQLite size against the plan before each run and after every statement, and the account's total when a run starts |
| Suspended accounts | Runs, crons, alarms, events, MCP and SSE stop, and the platform keeps state |
| Deploy churn | Limited to the plan's deploys per day and per month. Every attempt counts, including deploys that fail their checks, so a loop of failing deploys stops at the daily limit. A rollback counts as a deploy |
| One agent running a tool too often | Optional [per-token limits](/docs/concepts/agents/#limits): runs per hour overall and per tool, 1 to 100,000 each, on agent tokens and MCP connections. The platform refuses calls over a limit with `429` (a tool error over MCP), and they start no run |
| Bulk retries | At most 100 runs per call, each counted as a run; the batch stops when the run budget runs out |
| Alert floods | At most one [alert](/docs/guides/alerts/#throttling) per actuator per kind per hour (6 hours for missed schedules and rejected credentials, 15 minutes for expiring waits, 5 minutes for runs that finished after waiting); the rest are counted into the next. Of the alert emails per day per account (above), run completed alerts may use half, and `ctx.notifyOwner` messages half. Test alerts are limited to one per 30 seconds and ten a day |
| Configuration size | A configuration you save (config tab, `PUT`, deploy or rollback with a config) may hold at most 5,000 values, and an actuator's config schemas declare at most 500 secret fields; the platform refuses a configuration with a `__proto__` key. It never refuses reading a configuration |
| Agents reading runs | `actuate_list_runs` returns 1 to 20 runs per page (default 10), each page looking through at most the newest 1,000 runs, and inputs cut to 500 characters of JSON. A token may call it 30 times a minute (a full token, 120). Its reads count against the rows-read budget |
| Messages to the owner | A pass sends at most 10 `ctx.notifyOwner` messages, and their emails may use half of the day's alert emails. Each message is sent once per idempotency key within 48 hours |
| MCP sign-ins | OAuth access tokens last 1 hour and refresh tokens 30 days; each refresh returns a new refresh token, and the previous one keeps working until the new one is used. Sign-in, token and revocation endpoints take 60 requests per minute per IP address, registration 20 |

## SDK and runtime limits

These are built into the open-source SDK and runtime, so they hold everywhere, including `actuate dev` and [self-hosting](/docs/guides/self-hosting/#guards).

| What | Limit |
| --- | --- |
| Actuator `name` | `^[a-z][a-z0-9_]{0,63}$`, so at most 64 characters. The hosted platform also refuses names starting with `actuate_` |
| `ctx.notifyOwner` text | 1 to 4,000 characters |
| `ctx.notifyOwner` subject | One line, at most 200 characters |
| Secret config values | [Redaction](/docs/concepts/capabilities/#keys-and-tokens) skips values shorter than 6 characters, and booleans |
| Step name | 1 to 200 characters, unique within a run |
| Step retries | At most 10. The runtime clamps larger `retries` values |
| Step output, event payload, run output | Must be JSON-serialisable |
| Event payload | 64 KiB of JSON |
| Buffered events | 1,000 per actuator (oldest dropped), each kept for up to 7 days |
| Log lines | 100 per pass |
| Log message | Truncated at 2,000 characters |
| Log `data` | About 4 KB of JSON. The runtime truncates larger data |
| Passes per run | 10,000 in the open-source runtime (the platform uses the plan's limit), then the run fails |
| `waitForApproval` timeout | Default 7 days; approval links expire with it |
| `waitForEvent` timeout | Default none, so it waits forever unless the plan limits waits |
| `GET /runs` page size | 1 to 500, default 50 |
| `GET /tables/:name` page size | 1 to 10,000 rows, default 100 |
| Logs returned with a run | 500 lines |
