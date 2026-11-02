---
title: Limits
description: CPU and memory per invocation, outbound HTTP rules, plan limits, the hosted platform's guards, and the limits built into the SDK and runtime.
---

Actuate is built so that one actuator cannot hurt you, another tenant or the platform. **Every limit is a hard stop, not an overage charge.** Work pauses or is refused, and nothing is ever billed beyond your plan.

## Per invocation

Each pass of a run executes in its own V8 isolate with:

| Limit | Value |
| --- | --- |
| CPU time | 50 ms |
| Heap | 64 MB |

CPU time is time spent executing your code, not time spent waiting on the network, a provider or the database. A run can last days: each pass between waits is a separate invocation, and sleeps and waits use no CPU at all. Keep heavy computation small, and split large batches across several steps.

The isolate's environment contains only your declared capability clients. There are no platform bindings, no other tenants' data, and no raw `fetch`.

## Outbound HTTP

- Outbound HTTP goes only to the domains you declare in `http.allow`, through `ctx.http`. See [Capabilities and providers](/docs/concepts/capabilities/#http).
- HTTPS only. Redirects are not followed.
- An actuator cannot call its own URL. `ctx.http` refuses the platform's own origin, and every call counts against the same quotas.
- IP addresses are refused at call time.
- At deploy, `http.allow` may list at most 20 hostnames, with no IPs, no platform domains and no broad wildcards. See [Capabilities and providers](/docs/concepts/capabilities/#http).

## Plans

| | Sandbox | Maker | Agency (later) |
| --- | --- | --- | --- |
| Actuators | 2 | 15 | 50, grouped by client |
| Runs per month | 1,000 | 100,000 | 500,000 |
| SQLite per actuator | 25 MB | 500 MB | 5 GB |
| SQLite in total, all actuators | 50 MB | 500 MB | 5 GB, pooled |
| Providers | `http` to declared domains only | All | All |
| Longest sleep or wait | 7 days | Unlimited | Unlimited |
| Run rate | 60 per minute | 600 per minute | 1,200 per minute |
| Passes per month | 10,000 | 800,000 | 3,000,000 |
| Rows written per month | 250,000 | 4,000,000 | 15,000,000 |
| Rows read per month | 50,000,000 | 1,000,000,000 | 5,000,000,000 |
| Passes per run | 200 | 1,000 | 1,000 |
| Cron schedules per actuator | 3 | 5 | 5 |
| Shortest cron interval, all schedules together | 1 hour | 1 minute | 1 minute |
| Open legacy SSE sessions | 2 | 5 | 20 |
| Deploys per 24 hours | 30 | 200 | 500 |
| Settled runs kept for | 7 days | 30 days | 90 days |

- **Runs** count every run, including cron runs. **Passes** count the first pass of a run and every wake-up after it. **Rows written** and **rows read** count every billed SQLite row your actuators write or read, journal included.
- The SQLite total is checked when a run starts; the per-actuator size before each run and after every statement.
- The free Sandbox has no messaging, payment or LLM providers: it is for building and exposing MCP tools, not for sending messages or taking payments.
- The run rate is a sliding window per account.
- Agency also adds client portals, the approval queue, white-label domains, and Excel and SQLite exports. It arrives with Stage 2.

Billing is through Stripe. See [actuate.run](https://actuate.run) for prices.

## Guards on the hosted platform

| Situation | What happens |
| --- | --- |
| Monthly runs used up | New runs are refused until the monthly reset |
| Monthly passes, rows written or rows read used up (sleep loops, event storms, heavy queries) | Passes wait until the monthly reset. No run is lost |
| One run loops forever | It fails after the plan's passes per run |
| One pass does too much host work | A pass may run at most 1,000 database statements, write 1,000 steps, write 20,000 rows, read 5,000,000 rows, and take 30 seconds of wall time |
| One SQL statement does unbounded work | Refused before it runs: recursive queries, `randomblob`/`zeroblob`/`printf`/`format`, `PRAGMA`/`ATTACH`/`DETACH`/`VACUUM`. Bound parameters at most 1 MiB per statement. See [Database](/docs/concepts/database/#what-the-platform-refuses) |
| Large step results | One step's stored result is at most 1 MiB |
| Retry storms | Retries are capped at 10 per step, with exponential backoff |
| Long waits on the Sandbox | Sleeps longer than 7 days fail; waits time out at 7 days |
| Cron too frequent | Refused at deploy if the actuator has more schedules than the plan allows, or if its schedules together fire more often than the plan's minimum interval |
| Too many SSE sessions | Opening one more than the plan's limit is refused with `429`; use the streamable HTTP endpoint |
| Agents approving their own gates | Run tokens (the default) can only start and read runs, and approval links never appear in run logs |
| Broad outbound access | `http.allow` is validated at deploy |
| Event spam or large payloads | At most 1,000 buffered events per actuator (oldest dropped), 64 KiB per event payload, 256 KiB per request body |
| Unauthenticated endpoints called too often | Provider webhooks are limited to 120 and approval link `POST`s to 30 per minute |
| Journals grow without bound | Settled runs, with their steps and logs, are deleted after the plan's retention period. Your tables are never touched |
| Database growth | Each actuator's SQLite size is checked against the plan before each run and after every statement; the account's total is checked when a run starts |
| Suspended accounts | Runs, crons, alarms, events, MCP and SSE stop; state is kept |
| Deploy churn | Limited to the plan's deploys per 24 hours |

## SDK and runtime limits

These are built into the open-source SDK and runtime, so they hold everywhere, including `actuate dev` and [self-hosting](/docs/guides/self-hosting/#guards).

| What | Limit |
| --- | --- |
| Actuator `name` | `^[a-z][a-z0-9_]{0,63}$`: at most 64 characters |
| Step name | 1 to 200 characters, unique within a run |
| Step retries | At most 10; larger `retries` values are clamped |
| Step output, event payload, run output | Must be JSON-serialisable |
| Event payload | 64 KiB of JSON |
| Buffered events | 1,000 per actuator (oldest dropped), each kept for up to 7 days |
| Log lines | 100 per pass |
| Log message | Truncated at 2,000 characters |
| Log `data` | About 4 KB of JSON; larger data is truncated |
| Passes per run | 10,000 in the open-source runtime (the platform uses the plan's limit), then the run fails |
| `waitForApproval` timeout | Default 7 days; approval links expire with it |
| `waitForEvent` timeout | Default none: waits forever, unless the plan limits waits |
| `GET /runs` page size | 1 to 500, default 50 |
| `GET /tables/:name` page size | 1 to 10,000 rows, default 100 |
| Logs returned with a run | 500 lines |
