# AI Enablement Desk

A synthetic portfolio demonstration of governed AI request intake, analysis, clarification, human review, automation evidence, and optional audio. It is a working vertical slice, not a production-ready enterprise system.

![Persisted request queue](docs/evidence/aed-001-persisted-queue.png)

## What it demonstrates

- A typed intake contract validated again at the trusted server boundary.
- Postgres persistence for requests, immutable analyses, clarification evidence, decisions, automation attempts, artifacts, and actor-separated audit events.
- Gemini structured output treated as untrusted advice, followed by deterministic risk and readiness rules.
- Named, rationale-backed human decisions with legal transitions and optimistic concurrency protection.
- Signed n8n webhooks with correlation IDs, bounded retries, idempotency, and real execution identifiers.
- Optional Fish Audio generated only for explicitly synthetic-safe records; written text remains authoritative.

## Architecture

```mermaid
flowchart LR
  UI[React reviewer UI] --> API[Trusted Node server]
  API --> DB[(Postgres / local PGlite)]
  API --> GEM[Gemini adapter]
  GEM --> RULES[Deterministic rules]
  RULES --> API
  API --> N8N[n8n signed webhooks]
  API --> FISH[Fish Audio adapter]
  N8N --> API
  FISH --> API
```

```mermaid
stateDiagram-v2
  [*] --> submitted
  submitted --> needs_clarification: analysis needs evidence
  submitted --> ready_for_review: validated analysis
  needs_clarification --> ready_for_review: answer and re-analysis
  ready_for_review --> approved_for_discovery: named human approval
  ready_for_review --> deferred
  ready_for_review --> declined
  ready_for_review --> needs_clarification
```

The browser is a view cache. The server owns validation and consequential writes. Gemini cannot approve a request; deterministic rules may override its suggestion, and only a named human can record a final review decision.

## Run locally

Prerequisites: Node.js 22+ and npm 10+. External providers are optional.

```bash
npm ci
copy .env.example .env
npm run db:migrate
npm run dev
```

Open `http://localhost:5173`. With no `DATABASE_URL`, the application uses restart-safe embedded Postgres under `DEMO_DATABASE_PATH`. Set `DATABASE_URL` to a Supabase/Postgres connection string for hosted persistence.

Use **Reset demo** in the UI or `POST /api/demo/reset` to restore exactly three synthetic scenarios and remove prior generated demo records and artifacts:

1. Maintenance-report discovery candidate.
2. AI writing-tool access request.
3. High-risk employee-data request that deterministic privacy rules prevent from being approved.

## Optional providers

The application remains usable when every provider is absent and reports the degraded state in `/health` and the UI.

- **Gemini:** set `GEMINI_API_KEY`; structured output is schema-validated before deterministic routing.
- **n8n:** import `automation/n8n/*.json`, configure `AED_WEBHOOK_SECRET` in n8n, and set the matching `N8N_*` values from `.env.example`.
- **Fish Audio:** set `FISH_AUDIO_API_KEY`, keep `FISH_AUDIO_MODEL=s2.1-pro-free`, and set `AUDIO_BRIEFINGS_ENABLED=true`. The API key stays server-side.

`npm run verify:aed-004:live` performs a synthetic live provider verification when n8n and Fish are configured. It can consume provider quota and is intentionally excluded from the offline quality gate.

## Verification

```bash
npm run quality
```

This runs typecheck, Biome lint, unit tests, integration tests, production build, portfolio end-to-end tests, a web/server/database/provider-boundary smoke test, and the public-safety scan. CI runs `npm ci` before the same command.

## Evidence and walkthrough

- [Architecture details](docs/architecture.md)
- [90-second and three-minute demo scripts](docs/demo-script.md)
- [Screenshot walkthrough](docs/walkthrough.md)
- [Public-safety checklist](docs/public-safety.md)
- [Known limitations](docs/known-limitations.md)
- [AED-001 through AED-004 evidence](docs/evidence)

## Honest boundaries

Implemented capabilities, injected test providers, and live provider evidence are identified separately in the evidence documents. The repository contains no production identity, enterprise IAM, real employee directory, private company policy corpus, or autonomous approval logic. See [known limitations](docs/known-limitations.md) before treating this design as production guidance.
