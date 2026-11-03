---
title: Alerts
description: The hosted platform watches your actuators and tells you when a run fails, an actuator is paused, an approval is about to expire, a schedule didn't start or a provider rejects your credentials.
---

The hosted platform watches every actuator and tells you when something needs you: by email on every plan, and also on one of your messaging channels on Maker and Agency. You don't write any code for it. Alerts are sent in the background, so they never delay or fail a run.

Alerts are hosted only. The [open-source runtime](/docs/guides/self-hosting/) notifies nobody.

## What you are alerted about

Every kind is on until you turn it off.

| Kind | Sent when | At most one per actuator every |
| --- | --- | --- |
| `run_failed`: A run failed | A run ends `FAILED`. A step that is still retrying doesn't count. The alert names the run, the failing step and the error | Hour |
| `paused`: Work was paused automatically | An actuator was paused because 3 passes in a row were cut short by the CPU limit, or your account's monthly budget ran out (see below) | Hour |
| `wait_expiring`: An approval or question is about to expire | One hour before a `waitForApproval` or `waitForInput` times out, for waits of two hours or more. The alert lists the waits with links | 15 minutes |
| `cron_missed`: A scheduled run did not start | A cron schedule was due but no run started: the actuator is paused, the plan's run rate refused it, or the platform couldn't start it | 6 hours |
| `provider_auth`: A provider rejected your credentials | A messaging, payment or LLM provider answered `401`, or said the key or token is invalid, expired or revoked. The run still gets the error | 6 hours |

Details:

- **Pausing an actuator yourself** sends no `paused` alert. If it has cron schedules, you get one `cron_missed` alert for the skipped schedules per pause, not one per firing; resuming starts the count again.
- **A spent monthly budget** (runs, passes, rows written or read, HTTP requests, or total storage) is emailed once a month, whatever your settings say, because new runs are refused and waiting runs pause until the month resets. With a messaging channel set and `paused` on, it goes there too. Schedules refused for the budget don't also send `cron_missed`.
- **Expiring waits** are grouped: waits that time out within 15 minutes of each other come in one alert, listing up to five. When a wait times out, the run carries on as if nobody answered, so this is your last chance to answer in time. See [Human approvals and input](/docs/concepts/approvals/).
- **Rejected credentials** are recognised conservatively: only errors from the provider's own API, with status `401`, or a `400`, `403` or (for Slack) `200` whose message says the credentials are bad. Errors about one chat or channel, such as "blocked by the user" or "chat not found", don't count.

### Throttling

Each actuator sends at most one alert of a kind per window (the last column above). The first one goes out at once; the rest in that window are held back and counted, and the next alert of that kind after the window says how many:

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

Windows are per actuator and per kind, so a failing actuator never hides an alert from another one. Alerts for a kind you turned off, or for a muted actuator, are dropped, not held back: turning them on again alerts on the next event.

### Daily email cap

Alert emails, test alerts included, are capped per account per day (UTC): 10 on Sandbox, 100 on Maker, 300 on Agency. The last email of the day says so. After it, alerts still go to your messaging channel, if you have one, and the dashboard shows every failed run and waiting approval as usual.

## Where alerts go

Every alert is emailed to your account's address, from `notices@actuate.run`. That is the only destination on the Sandbox.

On Maker and Agency you can also send them to one messaging channel. Alerts use your own messaging provider, the same credentials your actuators use, so they arrive from your bot or account:

1. Connect the provider under **Settings → Providers** if you haven't.
2. In **Settings → Alerts**, under **Also send to**, pick the channel and enter the recipient.
3. Save, then **Send test alert**.

| Channel | Recipient |
| --- | --- |
| Telegram | A chat ID, such as `123456789`. Message your bot, then read `chat.id` from the Bot API's `getUpdates`. Group IDs start with `-100` |
| Slack | A channel ID, such as `C0123456789` (channel details, then **About**). Invite the bot to the channel |
| Discord | A channel ID. Turn on Developer Mode, right-click the channel and choose **Copy Channel ID** |
| WhatsApp | A phone number in international format, such as `60123456789` |
| Email (Resend) | An email address, such as `ops@yourcompany.com` |

The recipient is one ID or address, at most 200 characters, with no spaces. Messages to a channel are cut at about 1,900 characters (Discord's limit). If you later remove that provider, alerts go to email only until you pick another channel. If sending to the channel fails, the email still goes out.

**Send test alert** sends a test message to your email and the channel, whatever your toggles and mutes say, and shows what happened to each, including the provider's error if the channel failed. You can send one every 30 seconds, and five a day.

## Turn alerts off

- **A kind, for every actuator:** untick it under **Settings → Alerts → What to alert on**.
- **One actuator, every kind:** on the actuator's **Settings** tab, click **Mute alerts**. The monthly budget notice is account-wide and is still sent.

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
```

See [Platform API](/docs/reference/platform-api/#alerts) for every field and error.

## Fixing what an alert reports

A failed run usually means a bug or a provider outage. Deploy a fix, then retry the failed runs from the step that broke, without repeating the steps that worked: see [Fix, retry and roll back](/docs/guides/retry-and-rollback/).
