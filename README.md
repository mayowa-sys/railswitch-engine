# RailSwitch Engine

[![CI](https://github.com/mayowa-sys/railswitch-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/mayowa-sys/railswitch-engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A multi-tenant subscription billing and **payment-recovery** engine for Nigerian payment rails.

In Nigeria a failed card charge is the normal case, not the edge case. When a renewal fails, RailSwitch doesn't just retry the card — it moves the customer down a cascade of rails (payday-aware retries → one-time virtual account → USSD → WhatsApp) until the money arrives, while guaranteeing the customer is **never charged twice** for the same cycle.

TypeScript · Node.js 20 · Express · XState v5 · PostgreSQL 16 (row-level security) · Redis + BullMQ · Drizzle ORM · Vitest · Docker

---

## What makes it interesting

| Problem | How the engine handles it |
|---|---|
| **Exactly-once charging** under duplicate, late or concurrent webhooks | Each subscription is a 12-state [XState machine](src/state-machines/subscription.ts) with guarded transitions. State changes go through a [transactional wrapper](src/wrapper/subscription-wrapper.ts) that takes a row lock (`SELECT … FOR UPDATE`), checks an optimistic `version`, and records processed event IDs — so a replayed or racing webhook can't move the machine twice. |
| **Tenant isolation** that doesn't depend on every query remembering `WHERE merchant_id = …` | Postgres row-level security, actually enforced: each API request pins one connection that switches to an unprivileged role and sets the tenant ([src/db/client.ts](src/db/client.ts)). [Tests](tests/tenants/rls-enforcement.test.ts) prove cross-tenant reads, writes, updates, deletes and concurrent scopes are blocked by the database itself. |
| **Recovering revenue**, not just reporting failure | A [cascade coordinator](src/rails/cascade-coordinator.ts) escalates across rails; a [pure retry-timing function](src/rails/retry-timing.ts) applies exponential backoff with jitter, snaps to Nigerian payday windows (25th–30th) and the 10:00–14:00 WAT liquidity window. |
| **LLM-written customer messages** that can't embarrass a merchant | Gemini personalises dunning copy behind deterministic [guardrails](src/ai/dunning-checks.ts) (exact amount, exact account number, no threats, first name only, no card-like numbers). Anything that fails falls back to the merchant's template. An [eval harness](evals/dunning/README.md) scores the live model on a golden set, including a prompt-injection case. |
| **Merchant integrations** | HMAC-signed outbound webhooks with delivery logs and replay ([dispatcher](src/webhooks/webhook-dispatcher.ts)); HMAC-verified inbound provider webhooks. |

## Architecture

```
                 Authorization: Bearer sk_<live|test>_…
Merchant API ──────────────────────────────────────────────► /v1/*
                                                              │ API-key auth (SHA-256 hash lookup, fail closed)
                                                              │ pin connection · SET ROLE railswitch_app · set tenant
                                                              ▼
                                               Route handlers ──► SubscriptionWrapper
                                                                     │ row lock + version check + idempotency
                                                                     ▼
Nomba webhooks ──► /webhooks/nomba (HMAC) ──────────────────► XState subscription machine
                                                                     │ side effects
                         BullMQ billing worker ◄──── Redis ◄─────────┤
                                 │                                   ▼
                                 └──► Rail orchestrator ──► card · virtual account · USSD · WhatsApp/email
                                                                     │
                                                          Outbound webhooks (HMAC) ──► merchant
```

### Subscription lifecycle

`pending → trialing → active ⇄ charging → retrying → va_fallback → ussd_fallback → whatsapp_fallback → past_due → cancelled`, plus `paused` and `refunded`. Every transition is guarded. An event that isn't valid in the current state is a no-op: no state change, no side effects, no audit row. Every real transition writes an audit entry to a table whose RLS policies forbid updates and deletes.

### Two database scopes

| Scope | Used by | RLS |
|---|---|---|
| **Tenant** | Every authenticated `/v1` request | Enforced — queries run as `railswitch_app` with `app.current_merchant_id` set on a dedicated connection |
| **System** | Billing worker, provider webhooks, register/login | Bypassed deliberately — this code spans tenants and resolves the merchant from trusted data |

The exported `db` is an `AsyncLocalStorage`-backed proxy, so the same code runs correctly in either scope; connections are reset (`RESET ROLE`, `RESET app.current_merchant_id`) before returning to the pool, or destroyed if the reset fails.

## API overview

All `/v1` endpoints except register/login require `Authorization: Bearer sk_…`.

| Area | Endpoints |
|---|---|
| Auth | `POST /v1/auth/register`, `POST /v1/auth/login`, `GET/POST/DELETE /v1/auth/keys` |
| Catalogue | `/v1/plans`, `/v1/customers`, `/v1/payment-methods` |
| Billing | `/v1/subscriptions` (create, pause, resume, cancel, plan-change preview), `/v1/invoices` (+ PDF) |
| Recovery ops | `/v1/actions/:id/{retry, fallback, send-reminder, mark-recovered, refund}` |
| Webhooks | `/v1/webhooks/endpoints`, `/v1/webhooks/deliveries` (+ replay), `/v1/webhooks/events` |
| AI | `/v1/ai/dunning-preview`, `/v1/ai/retry-recommendation`, `/v1/ai/churn` |
| Customer portal | `POST /v1/portal/customers/:id/portal-link`; signed-token `/v1/portal/subscription/*` |
| Provider ingress | `POST /webhooks/nomba` |
| Ops | `GET /health`, `GET /status` (Postgres + Redis probes, version, git SHA) |

## Running locally

```bash
cp .env.example .env
docker compose up -d          # Postgres 16 + Redis 7
npm install
npx drizzle-kit migrate       # schema, RLS policies, railswitch_app role
npm run dev                   # http://localhost:3001
```

Without Nomba credentials the engine runs against a deterministic [mock client](src/rails/mock-nomba-client.ts); without `GEMINI_API_KEY`, AI features fall back to rules and templates.

## Testing

```bash
npm test                      # 298 tests: unit + Postgres-backed integration
npm run test:ai               # AI guardrails + offline eval over the golden set
npm run eval:dunning          # live Gemini eval (needs GEMINI_API_KEY)
```

CI runs type-checking, lint, migrations against a real Postgres, the full test suite, the production build and a Docker image build on every push and pull request; any failure blocks the merge.

Highlights of the suite:

- **State machine and wrapper:** lifecycle transitions, idempotent replay of duplicate events, no-op events, rollback of state, audit and idempotency on persist failure, row-lock acquisition.
- **Tenancy:** RLS enforcement at the database level plus HTTP-level cross-tenant checks with forged keys and spoofed headers.
- **Proration:** plan changes, pause and resume.
- **Retry timing:** payday and liquidity-window snapping, jitter bounds.
- **AI:** guardrail checks, golden-set PII boundary, broken-output rejection, client failure modes.

## Project structure

```
src/
  state-machines/   XState subscription machine
  wrapper/          Transactional wrapper: locking, versioning, idempotency, audit
  rails/            Orchestrator, cascade coordinator, retry timing, Nomba clients, notification rails
  workers/ queues/  BullMQ billing worker
  proration/        Plan change, pause, resume
  webhooks/         Outbound webhook signing and dispatch
  ai/               Gemini client, dunning generator + guardrails, retry model, churn scoring
  db/ middleware/   Tenant-scoped connections, API-key auth, RLS context
  routes/           /v1 HTTP API
  schema/ drizzle/  Drizzle schema and migrations (incl. RLS policies)
tests/              Vitest unit and integration tests
evals/dunning/      Golden set, thresholds and results for the AI eval
```

## Design notes

- **Why a state machine?** Billing bugs are almost always illegal transitions under concurrency. Making states and guards explicit turns "can this happen?" into a question the code answers, and makes the lifecycle testable as data.
- **Why enforce RLS instead of trusting `WHERE` clauses?** A single missing filter is a cross-tenant data leak. With RLS enforced per request, that mistake returns zero rows instead of another merchant's data.
- **Why guardrails *and* evals for the LLM?** The same checks run at runtime (to protect customers today) and offline (to measure the model and gate prompt changes), so what is measured is exactly what is enforced.

## Credits

RailSwitch began as a team project for the Nomba Hackathon 2026. This repository is the standalone engine, with history preserved. It was led by [Abdurrahman Balogun](https://github.com/mayowa-sys), who owns the payment-recovery core: the state machine, cascade, retry timing and AI recovery features. Since then it has been hardened for multi-tenant production use: enforced RLS, API-key auth, guardrailed AI and strict CI. Thanks to the teammates who built the original dashboard, portal and gateway.

MIT licensed.
