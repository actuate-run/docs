---
title: Templates
description: Start from a first-party actuator template - deposit reminders, support escalation, payment reconciliation, release notifications and daily reports.
---

First-party templates live in a public repository: [github.com/actuate-run/templates](https://github.com/actuate-run/templates). Each template is one folder with an `actuator.ts`, a `README.md` and a `.env.example`.

Start a project from one by name:

```bash
npm create actuate my-bot -- --template deposit-reminder
# or, where @actuate/cli is already installed
actuate init my-bot --template deposit-reminder
```

This downloads the template's files into `my-bot/` and adds the usual `package.json`, `tsconfig.json` and `.gitignore`. Then `npm install` and `npx actuate dev`, as in the [Quickstart](/docs/getting-started/quickstart/). Use `--ref <branch-or-tag>` with `npm create actuate` to pin a version of the templates repository.

## The templates

| Template | What it does |
| --- | --- |
| `deposit-reminder` | Deposit and appointment reminder bot: sends a payment link, waits for the payment, reminds if it doesn't arrive. [Your first actuator](/docs/getting-started/first-actuator/) builds a similar bot step by step |
| `support-escalation` | AI support escalation with a refund approval gate. See [Deterministic agent tools](/docs/guides/agent-tools/) for the pattern |
| `payment-reconciler` | Payment webhook reconciler that records payments in SQLite |
| `github-release-telegram` | Posts new GitHub releases to a Telegram chat |
| `daily-report` | Daily report scheduler |

Read each template's README for the configuration and credentials it needs; `.env.example` lists the variables.

## Contributing a template

Templates are ordinary actuators. A good one:

- passes `actuate check` with no errors;
- has defaults for every `ConfigSchema` field, so it runs under `actuate dev` with no configuration;
- keeps credentials out of the code and lists them in `.env.example`;
- explains in its README what it does, what it needs, and how to test it locally.

Open a pull request against [actuate-run/templates](https://github.com/actuate-run/templates) with a new folder named in lowercase with hyphens.
