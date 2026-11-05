---
title: Agents
description: On the hosted platform every API token is an agent. Runs record which agent started them, the dashboard shows each agent's calls, failures and refusals, and you can cap how often an agent may run your tools and let it cancel its own runs.
---

On the hosted platform, an **agent** is whatever API token called: an agent token you created in the dashboard, a full token, or an MCP client that [signed in with OAuth](/docs/guides/connect-your-agent/#sign-in-from-your-mcp-client) (each sign-in is a token, named after the app). Give each agent its own token and you can see what each one does, and limit it, separately.

Agents are hosted only. The open-source runtime has no accounts or token list: its runs never carry an agent.

## Which agent started a run

A run started with a token, over MCP or `POST https://run.actuate.run/a/<id>/run`, records the token's ID and name in its trigger:

```json
{ "kind": "mcp", "agent": { "id": "tok_5mXq2Lr0aBc9Df1G", "name": "Claude" } }
```

The token itself is never stored. `name` is the token's name when the run started; renaming the token later doesn't change old runs. The dashboard shows "Started by agent Claude" on the run page and the agent's name in the runs list.

Your code sees the same value as `ctx.trigger.agent`:

```ts
async run(ctx, input) {
  // The SDK's Trigger type does not declare `agent` yet.
  const agent = (ctx.trigger as { agent?: { id: string; name: string } }).agent;
  await ctx.step.do("audit", () =>
    ctx.db.sql`INSERT INTO audit (run_id, agent_id, agent_name) VALUES (${ctx.runId}, ${agent?.id ?? null}, ${agent?.name ?? null})`,
  );
  // ...
}
```

`agent` is absent for runs started by a webhook, a cron schedule, the dashboard, `actuate run` (the `/v1` API) or **Run again**. Treat it as a record of which credential was used, not as proof of who a person is: anyone holding the token is that agent.

## Analytics

**Settings → Agents** lists every token with what it did over a period: today, or the last 7, 30 or 90 days, as far as your plan's retention allows (the API takes any number of days up to the retention). Days are UTC.

| Column | What it counts |
| --- | --- |
| Calls | Every tool call or `/run` request that reached Actuate with this token, including the refused ones below |
| Errors | Failed runs out of runs that finished (`failed / (completed + failed)`) |
| Bad arguments | Calls refused because the arguments did not match the input schema, out of all calls |
| Refused | Calls refused by the plan's run rate or monthly budget, plus calls refused by the agent's own [limits](#limits) |
| p95 | 95% of calls were answered within this time |
| Last used | When the token was last used, to within about 5 minutes |
| Limits | The agent's limits, and "can cancel its runs" when you [allowed it](#cancelling-runs) |

**Tools** opens one agent's numbers per actuator (calls, bad arguments, refused, completed, failed, approved, rejected, p50 and p95) and, for periods longer than a day, per day.

- **Completed** and **failed** count runs the agent started, on the day they finished. A run you [retry](/docs/guides/retry-and-rollback/) is not counted again for the agent.
- **Approved** and **rejected** count approval decisions on the agent's runs, by link, in the dashboard or through the API, so you can see how often its requests get through review.
- Latency is the time until the tool call or `/run` request was answered, which is the run's first pass, not the whole run. It is measured in buckets (100 ms, 250 ms, 500 ms, 1 s, 2.5 s, 5 s, 10 s, 30 s), and the value shown is the upper bound of the bucket, so it never understates. Anything slower shows as 30 s, the longest a pass may take.
- Numbers arrive a few seconds after the calls; press **Refresh** to see them.
- Revoked tokens stay in the list while they have calls in the period.

History is kept for 30 days on the Sandbox, 60 days on Maker and 90 days on Agency. The same numbers are in the API: [`GET /v1/agents` and `GET /v1/agents/:id/usage`](/docs/reference/platform-api/#agents-and-tokens).

## Limits

Give an agent token a ceiling, such as "at most 5 refunds an hour", so a looping or misled agent can't run your tools more often than you expect. In **Settings → Agents**, click **Edit** on an agent:

- **Runs per hour, all tools:** at most this many runs started by this token in any 60 minutes.
- **Runs per hour, per tool:** the same, for one actuator. Up to 50 tools per token.

Each limit is a whole number from 1 to 100,000. Leave a field empty for no limit. Both apply when both are set. Limits are only for agent (run-scoped) tokens and MCP connections: a full token can change its own limits, so a cap on it would not hold.

A call over a limit starts no run. Over MCP the client gets a tool error, and over HTTP a `429`, naming the agent and the limit:

```text
Agent "support-bot" reached its limit of 5 runs per hour of refund_order. Try again in 12 minutes, or raise the limit in Settings → Agents.
```

- The window slides: a call counts for the next 60 to 61 minutes, so a limit never lets through more than its value in any 60 minutes.
- Agent limits are checked after the plan's run rate and monthly budget, and only calls that pass all of them count toward the agent's limits.
- Changes take up to 30 seconds to reach every region.
- An MCP connection keeps its limits for as long as it stays connected. If the app signs in again from scratch, the new connection starts with none.

Set them through the API too, when you create the token or later:

```bash
curl -X PATCH https://api.actuate.run/v1/tokens/tok_5mXq2Lr0aBc9Df1G \
  -H "Authorization: Bearer $ACTUATE_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"limits": {"runsPerHour": 200, "tools": {"refund_order": 5}}}'
```

`"limits": null` removes them. See [Platform API](/docs/reference/platform-api/#tokens).

Limits count runs started by the agent. They don't limit `actuate_get_run`, `actuate_list_runs` (which has its [own limit](#its-own-runs)), `actuate_cancel_run`, reads of a run, or work a run does once it has started. For limits on the work itself, see [Limits](/docs/reference/limits/).

## Its own runs

Over MCP, [`actuate_list_runs`](/docs/guides/connect-your-agent/#list-runs) shows an agent token, or a client that signed in, only the runs it started: runs whose `trigger.agent` is that token. Runs started by a webhook, a schedule, the dashboard or another token don't appear. A full token sees every run. Each token may call it 30 times a minute (a full token, 120), because every call reads runs against your monthly rows-read budget.

## Cancelling runs

An agent may cancel the runs it started only if you allow it. It is off for every new agent token and sign-in. To turn it on, click **Edit** on the agent in **Settings → Agents** and tick **Can cancel runs it started**, or send `{"canCancelRuns": true}` to [`PATCH /v1/tokens/:id`](/docs/reference/platform-api/#tokens).

- The agent then gets the [`actuate_cancel_run`](/docs/guides/connect-your-agent/#cancel-a-run) tool. Without the permission, the tool isn't in its tool list at all.
- It can cancel only runs it started that are still running or waiting, never another agent's or anyone else's.
- Cancelling doesn't undo steps the run already completed. The run records `Cancelled by agent "<name>"` as its error, shown on its page, and in its log.
- Full tokens can always cancel any run, so the setting applies to agent tokens and sign-ins only; sending it for a full token is `400`.
- Changes take up to 30 seconds to reach every region. An MCP connection keeps the setting for as long as it stays connected; if the app signs in again from scratch, the new connection starts without it.

Whatever you allow, an agent token still cannot approve or reject steps, answer questions, post events (such as a faked `payment.<ref>`), deploy, change configuration, read your tables, or see your tokens and settings.
