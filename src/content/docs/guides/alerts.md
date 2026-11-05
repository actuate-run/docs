---
title: Alerts
description: The hosted platform watches your actuators and tells you when a run fails, an actuator is paused, an approval is about to expire, a schedule didn't start or a provider rejects your credentials, and, if you ask, when a run that waited finishes.
---

The hosted platform watches every actuator and tells you when something needs you. It emails you on every plan, and on Maker and Agency it also messages one of your messaging channels. You don't write any code for it. The platform sends alerts in the background, so they never delay or fail a run.

Alerts are hosted only. The [open-source runtime](/docs/guides/self-hosting/) notifies nobody. To send yourself a message of your own from an actuator, use [`ctx.notifyOwner`](/docs/concepts/actuators/#message-the-owner).

## What you are alerted about

Every kind in this table is on until you turn it off. One more, [run completed](#runs-that-finish-after-waiting), is off until you switch it on for an actuator.

| Kind | Sent when | At most one per actuator every |
| --- | --- | --- |
| `run_failed`: A run failed | A run ends `FAILED`. A step that is still retrying doesn't count. The alert names the run, the failing step and the error | Hour |
| `paused`: Work was paused automatically | The platform paused an actuator because the CPU limit cut short 3 passes in a row, or your account's monthly budget ran out (see below) | Hour |
| `wait_expiring`: An approval or question is about to expire | One hour before a `waitForApproval` or `waitForInput` times out, for waits of two hours or more. The alert lists the waits with links | 15 minutes |
| `cron_missed`: A scheduled run did not start | A cron schedule was due but no run started, because the actuator is paused, the plan's run rate refused it, or the platform couldn't start it | 6 hours |
| `provider_auth`: A provider rejected your credentials | A messaging, payment or LLM provider answered `401`, or said the key or token is invalid, expired or revoked. The run still gets the error | 6 hours |

Details:

- **Pausing an actuator yourself** sends no `paused` alert. If it has cron schedules, you get one `cron_missed` alert for the skipped schedules per pause, not one per firing. Resuming starts the count again.
- **A spent monthly budget** (runs, passes, rows written or read, HTTP requests, or total storage) is emailed once a month, whatever your settings say, because new runs are refused and waiting runs pause until the month resets. On the Sandbox, when only runs are used up, runs your schedules start keep starting and running while the month's [scheduled runs](/docs/concepts/triggers/#cron) last. With a messaging channel set and `paused` on, it goes there too. Schedules refused for the budget don't also send `cron_missed`.
- **Expiring waits** are grouped. Waits that time out within 15 minutes of each other come in one alert, listing up to five. When a wait times out, the run continues as if nobody answered, so this is your last chance to answer in time. See [Human approvals and input](/docs/concepts/approvals/).
- The platform recognises **rejected credentials** conservatively. It counts only errors from the provider's own API, with status `401`, or a `400`, `403` or (for Slack) `200` whose message says the credentials are bad. Errors about one chat or channel, such as "blocked by the user" or "chat not found", don't count.
- **Secret config values** never appear in an alert. In the errors, step names and output an alert quotes, the platform replaces [secret fields'](/docs/concepts/capabilities/#keys-and-tokens) values with `[secret]`.

### Runs that finish after waiting

When an agent starts a run that waits, for a day or for your approval, Actuate doesn't tell anyone when it finishes. Switch on **run completed** alerts for an actuator to hear about it. On the actuator's **Settings** tab, tick **Email me when a run that waited finishes**, or send `{"runCompleted": true}` to [`PUT /v1/actuators/:name/alerts`](/docs/reference/platform-api/#alerts).

- It is per actuator and off by default, so a busy actuator you don't care about never sends one. The **Alerts** section of **Settings** shows which actuators have it on, with links to their Settings tabs.
- Only runs that end `COMPLETED` after waiting at least once send this alert, meaning runs that slept, waited for an event, an approval or an answer, or retried a step. A run that finishes in its first pass already answered whoever started it, so it never alerts. Failed runs send `run_failed` alerts instead.
- The alert gives the run, the agent that started it (if one did), how long it ran, and the first 500 characters of its output as JSON, with a link to the run. The platform replaces [secret config values](/docs/concepts/capabilities/#redaction) in the output with `[secret]` before it cuts the output.
- The platform sends at most one per actuator every 5 minutes. Runs that finish in the meantime are counted into the next alert ("…and 3 more runs finished since …"), or, if none follows, into one alert at the end of those 5 minutes ("3 runs of refund_order that were waiting finished since …"), so a burst of results never goes unreported.
- They may use only half of your plan's [daily alert emails](#daily-email-cap), counted against every alert email sent that day, so failures and other alerts always have the other half. After that, the platform doesn't email them for the rest of the UTC day (the last one says so), but a messaging channel on Maker or Agency still gets every one.
- Muting the actuator stops these too.

```text
Subject: refund_order: a run finished

A run of refund_order that was waiting has finished.

Run: run_01a19b8e7c2d4f60a1b2c3d4e5f6
Started by agent: Claude
Ran for: 3 h 5 min
Output: {"status":"REFUNDED","amount":120}

Open the run: https://app.actuate.run/actuators/refund_order/runs/run_01a19b8e7c2d4f60a1b2c3d4e5f6

—
You get at most one alert like this per actuator every 5 minutes, because you switched it on for refund_order.
Switch it off or mute refund_order: https://app.actuate.run/actuators/refund_order/settings
```

### Throttling

Each actuator sends at most one alert of a kind per window (the last column above, or 5 minutes for run completed). The first one goes out at once. The platform holds back and counts the rest in that window, and the next alert of that kind after the window says how many:

```text
Subject: refund_order: a run failed

A run of refund_order failed.

Run: run_01a19b8e7c2d4f60a1b2c3d4e5f6
Failing step: refund
Error: Billplz: 503 Service Unavailable

Open the run: https://app.actuate.run/actuators/refund_order/runs/run_01a19b8e7c2d4f60a1b2c3d4e5f6

2 more alerts like this were held back since 2026-11-03 08:14 UTC.

—
You get at most one alert like this per actuator every hour.
Change alerts: https://app.actuate.run/settings/alerts
Mute refund_order: https://app.actuate.run/actuators/refund_order/settings
```

Windows are per actuator and per kind, so a failing actuator never hides an alert from another one. The platform drops alerts for a kind you turned off, or for a muted actuator, instead of holding them back. Turning them on again alerts on the next event.

### Daily email cap

Alert emails, test alerts included, are capped per account per day (UTC): 20 on Sandbox, 100 on Maker, 300 on Agency. The last email of the day says so. After it, alerts still go to your messaging channel, if you have one, and the dashboard shows every failed run and waiting approval as usual. [Run completed](#runs-that-finish-after-waiting) alerts may use only half of the day's emails. Messages your actuators send with [`ctx.notifyOwner`](/docs/concepts/actuators/#on-the-platform) count as alert emails too, and may also use only half.

## Where alerts go

The platform emails every alert to your account's address, from `notices@actuate.run`. That is the only destination on the Sandbox.

On Maker and Agency you can also send them to one messaging channel. Alerts use your own messaging provider, the same credentials your actuators use, so they arrive from your bot or account:

1. Connect the provider under **Providers** in **Settings** if you haven't.
2. In **Settings**, under **Alerts**, find **Also send to**, pick the channel and enter the recipient.
3. Save, then click **Send test alert**.

| Channel | Recipient |
| --- | --- |
| Telegram | A chat ID, such as `123456789`. Message your bot, then read `chat.id` from the Bot API's `getUpdates`. Group IDs start with `-100` |
| Slack | A channel ID, such as `C0123456789` (channel details, then **About**). Invite the bot to the channel |
| Discord | A channel ID. Turn on Developer Mode, right-click the channel and choose **Copy Channel ID** |
| WhatsApp | A phone number in international format, such as `60123456789` |
| Email (Resend) | An email address, such as `ops@yourcompany.com` |

The recipient is one ID or address, at most 200 characters, with no spaces. Messages to a channel are cut at about 1,900 characters (Discord's limit). If you later remove that provider, alerts go to email only until you pick another channel. If sending to the channel fails, the email still goes out.

**Send test alert** sends a test message to your email and the channel, whatever your toggles and mutes say, and shows what happened to each, including the provider's error if the channel failed. You can send one every 30 seconds, and ten a day.

## Turn alerts off

- To turn off one kind for every actuator, untick it in **Settings**, under **Alerts**, then **What to alert on**.
- To mute every kind for one actuator, click **Mute alerts** on the actuator's **Settings** tab. The monthly budget notice is account-wide and is still sent, and so are the actuator's own `ctx.notifyOwner` messages. To stop those, change the code.
- To turn off run completed alerts for one actuator, untick **Email me when a run that waited finishes** on its **Settings** tab.

Changes apply to the next alert.

## From the API

The same settings are in the API, with a full token:

```bash
# Turn off expiring-wait alerts and send the rest to Telegram too.
curl -X PUT https://api.actuate.run/v1/alerts \
  -H "Authorization: Bearer $ACTUATE_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kinds": {"wait_expiring": false}, "channel": {"kind": "telegram", "to": "123456789"}}'

# Mute one actuator.
curl -X PUT https://api.actuate.run/v1/actuators/refund_order/alerts \
  -H "Authorization: Bearer $ACTUATE_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"muted": true}'

# Hear when another actuator's runs finish after waiting.
curl -X PUT https://api.actuate.run/v1/actuators/order_followup/alerts \
  -H "Authorization: Bearer $ACTUATE_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"runCompleted": true}'
```

See [Platform API](/docs/reference/platform-api/#alerts) for every field and error.

## Fixing what an alert reports

A failed run usually means a bug or a provider outage. Deploy a fix, then retry the failed runs from the step that broke, without repeating the steps that worked. See [Fix, retry and roll back](/docs/guides/retry-and-rollback/).
