# YNAB → Notion Sync Worker

A [Notion Worker](https://developers.notion.com/docs/workers) that syncs your [YNAB (You Need A Budget)](https://www.ynab.com/) data into Notion databases. Accounts, categories, transactions, payees, monthly budgets — all kept in sync automatically, once a day.

![Notion Workers Alpha](https://img.shields.io/badge/Notion%20Workers-alpha-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## What It Does

This worker creates **7 linked Notion databases** from your YNAB budget:

| Database | What's In It |
|----------|-------------|
| **YNAB Accounts** | Bank accounts, credit cards, balances, reconciliation dates |
| **YNAB Category Groups** | Top-level budget groupings (e.g. "Bills", "Savings Goals") |
| **YNAB Categories** | Individual budget categories with goals, funding, and balances |
| **YNAB Payees** | Where your money goes, with emoji icons for known brands |
| **YNAB Transactions** | Every transaction with amount, date, payee, category, and flags |
| **YNAB Monthly Budgets** | Monthly summaries: income, budgeted, activity, age of money |
| **YNAB Sync Audit Log** | Security audit trail: API calls, status, record counts, errors |

All databases are **relationally linked** — transactions point to their account, payee, and category; categories point to their group. This means you can build Notion views that roll up spending by category, filter transactions by account, and more.

### Features

- **Daily sync** — runs automatically every 24 hours
- **Full replace** — always reflects the current state of your YNAB budget
- **USD formatting** — YNAB milliunits converted to proper dollar amounts
- **Emoji icons** — known payees (Amazon, Starbucks, Netflix, etc.) get recognizable emoji icons; YNAB categories with leading emoji preserve them
- **Two-way relations** — navigate between transactions, accounts, categories, and payees in Notion
- **Pagination** — handles large transaction histories without hitting size limits

## Prerequisites

- A **Notion workspace** with access to [Notion Custom Agents](https://www.notion.so/?target=ai) (requires workspace admin opt-in)
- A **YNAB account** with a [Personal Access Token](https://app.ynab.com/settings/developer)
- **Node.js 22+** and **npm 10.9.2+**
- The **`ntn` CLI** (Notion's worker management tool)

## Quick Start

### 1. Install the NTN CLI

```shell
npm i -g ntn
ntn login
```

### 2. Clone and install

```shell
git clone https://github.com/sbcatania/worker-ynab.git
cd worker-ynab
npm install
```

### 3. Get your YNAB Personal Access Token

1. Go to [YNAB Developer Settings](https://app.ynab.com/settings/developer)
2. Click **New Token**
3. Copy the token

### 4. Configure secrets

```shell
# Store your YNAB token as a worker secret
ntn workers env set YNAB_ACCESS_TOKEN=your-token-here

# Required: target a specific budget (find the ID in your YNAB app URL)
ntn workers env set YNAB_BUDGET_ID=your-budget-id
```

For local development, pull secrets to a `.env` file:

```shell
ntn workers env pull
```

### 5. Deploy

```shell
ntn workers deploy
```

That's it. The worker will create the databases in your Notion workspace and start syncing daily.

### 6. Monitor

```shell
# Check sync status
ntn workers sync status

# View recent runs
ntn workers runs list

# Get logs for a specific run
ntn workers runs logs <runId>

# Force an immediate sync
ntn workers sync force-run ynabAccountsSync
```

## Finding Your Budget ID

If you have multiple budgets and want to target a specific one, you can find the budget ID in the YNAB app URL — it's the UUID after `/budgets/` in the address bar. For example:

```
https://app.ynab.com/abcd1234-5678-9abc-def0-123456789abc/budget
                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                      This is your budget ID
```

You **must** set `YNAB_BUDGET_ID` — the worker will fail if it's missing to prevent accidentally syncing the wrong budget.

## Customizing with AI Coding Agents

This project is designed to be easy to fork and modify using AI coding tools like [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex](https://openai.com/index/codex/), [GitHub Copilot](https://github.com/features/copilot), or similar.

### Getting started with an agent

1. Fork this repo
2. Open it in your preferred AI coding environment
3. The `CLAUDE.md` file (symlinked from `.agents/INSTRUCTIONS.md`) provides project context that Claude Code and compatible agents will pick up automatically
4. The `.examples/` directory contains patterns for each capability type

### Common modifications to ask your agent for

- **Add new properties** — "Add a `Running Balance` column to the transactions database that shows the cumulative balance"
- **Change sync frequency** — "Make transactions sync every 6 hours instead of daily"
- **Filter data** — "Only sync transactions from the last 90 days" or "Skip closed accounts"
- **Add new syncs** — "Create a sync for scheduled transactions from YNAB"
- **Custom emoji mappings** — "Add emoji icons for [your local stores]"
- **Different currency** — "Format amounts in EUR instead of USD"
- **Incremental sync** — "Switch from full replace to incremental sync using YNAB's server_knowledge for delta updates"

### Project structure at a glance

```
src/index.ts          ← All sync definitions live here (single file)
.agents/              ← Agent instructions (auto-loaded by Claude Code)
.examples/            ← SDK usage patterns (sync, tool, OAuth, automation)
.env.example          ← Required environment variables
workers.json          ← NTN CLI configuration
```

The entire worker is a single `src/index.ts` file (~825 lines). Each sync is self-contained with its own schema, YNAB API call, and data mapping — easy to read, modify, or copy.

## How It Works

The worker uses the [YNAB API v1](https://api.ynab.com/v1) to fetch budget data and the [Notion Workers SDK](https://developers.notion.com/docs/workers) (`@notionhq/workers`) to define sync capabilities. Each sync:

1. Fetches data from a YNAB API endpoint
2. Maps YNAB fields to Notion database properties
3. Returns rows as upsert operations keyed by YNAB IDs

The Notion Workers runtime handles database creation, schema management, scheduling, and pagination.

### YNAB API Endpoints Used

| Endpoint | Sync |
|----------|------|
| `GET /budgets/{id}/accounts` | Accounts |
| `GET /budgets/{id}/categories` | Category Groups + Categories |
| `GET /budgets/{id}/transactions` | Transactions |
| `GET /budgets/{id}/payees` | Payees |
| `GET /budgets/{id}/months` | Monthly Budgets |

## Development

```shell
# Type-check
npm run check

# Build
npm run build

# Test a sync locally
ntn workers exec ynabAccountsSync --local

# Dry-run a sync (preview without writing to Notion)
ntn workers sync dry-run ynabAccountsSync

# Reset sync state and start fresh
ntn workers sync state reset ynabAccountsSync
```

## Links & References

- **YNAB API Documentation** — https://api.ynab.com
- **YNAB Developer Portal** — https://app.ynab.com/settings/developer
- **Notion Workers Documentation** — https://developers.notion.com/docs/workers
- **NTN CLI** — `npm i -g ntn` ([docs](https://developers.notion.com/docs/workers))
- **Notion Developer Slack** — [Join here](https://join.slack.com/t/notiondevs/shared_invite/zt-3r1aq1t1s-hM2har7iqfOfHJRrH9PHww)
- **Notion Workers SDK** — `@notionhq/workers` ([npm](https://www.npmjs.com/package/@notionhq/workers))

## Security

This worker handles **sensitive financial data**. Please review these considerations:

### Token Security

- Your YNAB Personal Access Token grants **full read access to ALL budgets** on your YNAB account, not just the one you configure. YNAB does not support scoped tokens.
- Tokens **do not expire** — a leaked token remains valid until you manually revoke it at [YNAB Developer Settings](https://app.ynab.com/settings/developer).
- **Rotate your token periodically** (recommended: every 90 days). Revoke the old token in YNAB, create a new one, and update via `ntn workers env set`.
- Never commit tokens to git. The `.gitignore` excludes `.env` files, but stay vigilant.

### Data Classification

All synced data is personally identifiable financial information (PII):
- Account balances and types
- Every transaction (amounts, merchants, dates, memos)
- Budget allocations and spending patterns

**Share your Notion databases only with trusted individuals.** Notion encrypts data in transit and at rest (SOC 2 Type II, ISO 27001), but access control is your responsibility.

### Audit Logging

The worker includes a built-in audit log sync (`ynabAuditLogSync`) that records every API call to a separate **YNAB Sync Audit Log** database in Notion. Each entry includes:
- Timestamp, sync name, and YNAB API endpoint called
- Success/error status and error messages (sanitized — no tokens or response bodies)
- Record counts and response times

Use this to detect anomalies, verify sync completeness, and maintain a compliance trail.

### Error Handling

- API errors are **sanitized** — error messages include only the HTTP status code and endpoint path, never response bodies (which could contain sensitive data).
- Transient failures (5xx, 429 rate limits) are retried up to 3 times with exponential backoff.
- Client errors (4xx other than 429) fail immediately.

## Note on Availability

Notion Workers is currently in **alpha**. The sync capability used by this worker is in **private alpha** — you'll need access to Notion Custom Agents and the sync feature to use it. The SDK and CLI may have breaking changes. See `README.ntn.md` in this repo for the latest Notion Workers SDK documentation.

## License

MIT
