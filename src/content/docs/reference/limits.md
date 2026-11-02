---
title: Limits
description: CPU and memory per invocation, outbound HTTP rules, plan quotas, and the limits built into the SDK and runtime.
---

Actuate is built so that one actuator cannot hurt you, another tenant or the platform. Limits are enforced, not billed: **quotas are hard stops, not overage charges.**

## Per invocation

Each pass of a run executes in an isolated V8 isolate with:

| Limit | Value |
| --- | --- |
| CPU time | 50 ms |
| Heap | 64 MB |

CPU time is time spent executing your code, not time spent waiting on the network, a provider or the database. A run can last days: each pass between waits is a separate invocation, and sleeps and waits use no CPU at all. Keep heavy computation small, and split large batches across several steps.

The isolate's environment contains only your declared capability clients. There are no platform bindings, no other tenants' data, and no raw `fetch`.

## Outbound HTTP

- Outbound HTTP goes only to the domains you declare in `http.allow`, through `ctx.http`. See [Capabilities and providers](/docs/concepts/capabilities/#http).
- HTTPS only. Redirects are not followed.
- **Loop detection:** an actuator cannot trigger its own webhook URL.

## Quotas

- A per-tenant run rate, enforced over a sliding window.
- Run and row-write counters per tenant, with a hard stop at your plan's quota.
- A runaway loop pauses the actuator and notifies you. It never produces a surprise invoice.

| Plan | Actuators | Runs | SQLite | Also |
| --- | --- | --- | --- | --- |
| Sandbox (free) | 2 | 1,000 | 25 MB each | MCP endpoint. No messaging or payment providers. Sleeps after 7 idle days |
| Maker | 15 | 100,000 | 500 MB | All providers. Custom webhook domain, unlimited sleep duration |
| Agency (later) | 50, grouped by client | 500,000 | 5 GB | Client portals, approval queue, white-label domain, Excel and SQLite exports |

The free tier is for building and exposing MCP tools, not for sending messages or taking payments. See [actuate.run](https://actuate.run) for current prices.

## SDK and runtime limits

These are built into the open-source SDK and runtime, so they hold everywhere, including `actuate dev` and self-hosting.

| What | Limit |
| --- | --- |
| Actuator `name` | `^[a-z][a-z0-9_]{0,63}$`: at most 64 characters |
| Step name | 1 to 200 characters, unique within a run |
| Step output, event payload, run output | Must be JSON-serialisable |
| Log message | Truncated at 4,000 characters |
| Passes per run | 10,000 (open-source runtime default), then the run fails |
| Buffered events | Dropped after 7 days if no wait claims them |
| `waitForApproval` timeout | Default 7 days; approval links expire with it |
| `waitForEvent` timeout | Default none: waits forever |
| `GET /runs` page size | 1 to 500, default 50 |
| `GET /tables/:name` page size | 1 to 10,000 rows, default 100 |
| Logs returned with a run | 500 lines |
