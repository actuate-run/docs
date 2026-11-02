---
title: Templates
description: Start from a first-party actuator template - agent tools such as refunds, approvals and escalations, and automations such as deposit reminders and daily reports.
---

First-party templates live in a public repository: [github.com/actuate-run/templates](https://github.com/actuate-run/templates). Each template is one folder with an `actuator.ts`, a `README.md` and a `.env.example`.

Start a project from one by name:

```bash
npm create actuate my-bot -- --template deposit-reminder
# or, where @actuate/cli is already installed
actuate init my-bot --template deposit-reminder
```

This downloads the template's files into `my-bot/` and adds the usual `package.json`, `tsconfig.json` and `.gitignore`. Then `npm install` and `npx actuate dev`, as in the [Quickstart](/docs/getting-started/quickstart/). Use `--ref <branch-or-tag>` with either command to pin a version of the templates repository.

Most templates ship an `actuate.config.json` with example values (an approver's chat ID, a support address). Replace them before you deploy; locally, messages to those addresses are just printed.

## Agent tools

Small tools an AI agent calls over MCP. The model decides *what* should happen; the actuator decides *how*, with caps, approvals and an audit row the model cannot change. See [Deterministic agent tools](/docs/guides/agent-tools/) for the pattern.

| Template | What it does | Leans on |
| --- | --- | --- |
| `refund-order` | Refunds an order: amount capped in code, manager approval above a threshold, once per order, audit row | `waitForApproval` |
| `approve-message` | A person approves, edits or rejects the agent's draft before anything is sent | `waitForApproval` |
| `escalate-to-human` | Opens a ticket, asks a person, and returns their answer or a clear timeout | `waitForInput` |
| `lead-intake` | Saves a lead, follows up on day 1 and day 3, stops when they reply | `waitForEvent` |
| `schedule-follow-up` | Sends a message at a validated future time unless the customer replies first | `waitForEvent({ until })` |
| `order-status` | Read-only order lookup over the actuator's own SQLite, scoped to the customer's email | `ctx.db` |

## Automations

Webhook- and cron-driven actuators.

| Template | What it does | Capabilities |
| --- | --- | --- |
| `deposit-reminder` | Holds a booking, sends a deposit payment link, reminds if unpaid, confirms on payment. [Your first actuator](/docs/getting-started/first-actuator/) builds a similar bot step by step | payment, messaging |
| `support-escalation` | LLM triage of support messages; refunds capped in code, with an approval gate above a threshold | llm, messaging, payment |
| `payment-reconciler` | Records payment webhooks exactly once in SQLite and flags amounts that don't match | messaging (optional) |
| `github-release-telegram` | Posts a Telegram message when a GitHub release is published | messaging |
| `daily-report` | Collects events during the day and sends a morning summary on a cron | messaging |

`order-status` and `payment-reconciler` (whose `messaging` is optional) deploy on the free Sandbox plan. The others declare `messaging`, `payment` or `llm`, so deploying them needs Maker. All of them run under `actuate dev` with no account.

Read each template's README for the configuration and credentials it needs; `.env.example` lists the variables.

## Contributing a template

Templates are ordinary actuators. A good one:

- passes `actuate check` with no errors;
- has defaults for every `ConfigSchema` field, so it runs under `actuate dev` with no configuration;
- keeps credentials out of the code and lists them in `.env.example`;
- explains in its README what it does, what it needs, and how to test it locally.

Open a pull request against [actuate-run/templates](https://github.com/actuate-run/templates) with a new folder named in lowercase with hyphens.
