---
title: Fix, retry and roll back
description: On the hosted platform each run stays on the version it started on. Deploy a fix, retry failed runs from the step that broke, run them again, or roll back to an earlier version.
---

Something broke in production. A provider was down, or your code had a bug. On the hosted platform you can fix it without losing the runs it hit:

1. **Deploy a fix.** Runs already in flight keep running the version they started on.
2. **Retry the failed runs** from the step that failed, on the new version. Steps that completed don't run again, so a payment made in a completed step is not charged twice.
3. Or, if the new version is the problem, **roll back** to an earlier one.

All of this is hosted only. In `actuate dev` and a [self-hosted runtime](/docs/guides/self-hosting/) a deploy replaces the code for every run, including runs that are sleeping or waiting, and there is no retry or rollback.

## Runs stay on their version

Every deploy creates a new version: v1, v2, v3. The platform pins a run to the version that was current when it started, and every later pass of that run (after a sleep, a wait, a retry backoff) runs that same code, even if you have deployed since. So a deploy that renames, reorders or removes steps can't replay an old run's journal through code it wasn't written for. New runs start on the current version.

The run page shows the version, the runs list has a **Version** column, and run records in the API have a `version` field. Runs started before versions were recorded show `null` ("not recorded") and run on the current version.

Running an earlier version next to the current one costs an extra worker that day, so your plan allows a number of such days a month (see [limits](/docs/reference/limits/#plans)). A day counts once per earlier version, whatever the number of its runs. If the allowance runs out, runs still pinned to an earlier version fail with a message saying so. Retry them to move them to the current version.

The platform doesn't version configuration, so a pinned run uses the current configuration. When you change the config schema, keep it working for versions that still have runs in flight, or let those runs finish first.

## Retry a failed run

On a failed run's page, click **Retry from failed step**. The run continues under the same run ID, with the same input and trigger, on the **current** version:

- Steps that **completed** keep their stored results and don't run again.
- Every other step (the one that failed, one that was cut off mid-attempt, a wait that hadn't finished) is cleared and runs again from the start.
- The run's pass count starts again at 0, so it has the plan's full passes per run.
- The log keeps the earlier passes and adds a line such as `Retried on v8 from step "refund"`, with the version, the cleared steps and who retried it.
- Provider calls in the steps that run again get new [idempotency keys](/docs/concepts/steps-and-replay/#idempotency-keys): Actuate adds `:retry1` (then `:retry2`, ...) to the keys it derives (`<runId>:<step>:<method>:<n>`). So the fixed step reaches Stripe or Resend as a new call, rather than getting the failed call's saved answer or a "different parameters" error. If a call had already succeeded before its step failed (or the step was cut off after it), the retry makes it again. To keep such a call to once across retries, pass your own `idempotencyKey`, such as `refund-${orderId}` or `` `${ctx.runId}:refund` ``. Actuate sends keys you pass as given, unless they have the exact form it derives (`<runId>:<step>:send:0` and the like), which is reserved.

The run becomes `WAITING`, due now, and continues in the background within moments. If it fails again, you get another [alert](/docs/guides/alerts/) and can retry again.

A retry counts as a run against your monthly runs and the run rate. The platform refuses it while the actuator is paused (resume it first), while its database is over the plan's size limit, and when the run budget is used up. You can retry only `FAILED` runs. For a run that is stuck `WAITING`, use **Resume**, which runs another pass now.

:::caution[Keep the names of steps that ran]
Replay finds a completed step's result by its name. If your fix renames a step that already completed in the failed runs, the renamed step runs again on retry, side effects included. Change the code inside a step freely, and rename only steps that hadn't run. See [Steps and replay](/docs/concepts/steps-and-replay/#step-names).
:::

## Retry many runs

After deploying a fix for something that hit many runs, open the **Runs** tab, filter by **Failed**, and click **Retry failed runs**. Choose how far back to go (the last hour, 24 hours or 7 days). The platform retries each run that failed in that window as above, oldest first, up to 100 at a time. Click **Retry again** while it says more remain. Each retry counts as a run, and the batch stops early, with the reason, if the run budget runs out.

A bulk retry skips runs that were already retried on the current version, so a run that fails again after its retry isn't picked up again by **Retry again**. If your fix didn't work, deploy another. After that deploy, the same bulk retry picks those runs up again.

## Run again

**Run again**, on any finished run, starts a **new** run (new run ID, current version) with the same input. It keeps nothing from the old run, so every step runs again, side effects included. Use it to repeat a run that completed, or to start a failed one from scratch. The platform checks the input against the current input schema, and the new run's trigger is `api`.

## Roll back

If a deploy is the problem, make an earlier version current again. On the actuator's **Settings** tab, under **Version history**, click **Roll back to v6** and confirm.

- The rollback is a **new** version: rolling back from v8 to v6 creates v9, with v6's code, metadata and cron schedules. History is append-only, so you can roll forward again the same way. The dashboard marks versions that share code "same code as v6".
- Runs in flight finish on the version they started on. New runs use v9.
- It runs the same checks as a deploy: your plan must allow v6's capabilities, their providers must be configured, and its cron schedules, `http.allow` list and input patterns must pass today's rules.
- Your configuration stays as it is, and it must fit v6's config schema. Otherwise the platform refuses the rollback and says which fields don't fit. Through the API you can pass a configuration that fits with the rollback.
- A rollback counts as a deploy toward your plan's [deploys per day and per month](/docs/reference/limits/#plans).

You can then retry runs that failed on the bad version. A retry moves them to the current version, which is the rolled-back one.

## From the API

There are no CLI commands for these yet. With a full token:

```bash
API=https://api.actuate.run/v1/actuators/refund_order

# Retry one failed run.
curl -X POST "$API/runs/run_01a19b8e7c2d4f60a1b2c3d4e5f6/retry" -H "Authorization: Bearer $ACTUATE_API_TOKEN"

# Retry everything that failed since 09:00 UTC, 100 at a time, while "more" is true.
curl -X POST "$API/runs/retry-failed" -H "Authorization: Bearer $ACTUATE_API_TOKEN" \
  -H 'content-type: application/json' -d '{"since": "2026-11-03T09:00:00Z"}'

# Start a new run with an old run's input.
curl -X POST "$API/runs/run_01a19b8e7c2d4f60a1b2c3d4e5f6/rerun" -H "Authorization: Bearer $ACTUATE_API_TOKEN"

# Version history, then roll back to v6.
curl "$API/versions" -H "Authorization: Bearer $ACTUATE_API_TOKEN"
curl -X POST "$API/rollback" -H "Authorization: Bearer $ACTUATE_API_TOKEN" \
  -H 'content-type: application/json' -d '{"version": 6}'
```

See [Platform API](/docs/reference/platform-api/#runs-retries-and-versions) for the responses and errors.
