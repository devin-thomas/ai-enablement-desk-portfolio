# Screenshot walkthrough

## 1. Persisted intake and queue

![Persisted queue loaded from Postgres](evidence/aed-001-persisted-queue.png)

The queue is loaded from the request API. Reset restores the three committed synthetic scenarios; refresh does not erase submitted records.

## 2. Analysis provenance and deterministic override

![Analysis provenance](evidence/aed-002-analysis-provenance.png)

The reviewer sees model provenance, confirmed facts, unconfirmed assumptions, unknowns, clarification questions, and the deterministic route separately.

## 3. Named human decision and audit history

![Human decision and audit](evidence/aed-003-human-decision-audit.png)

The final decision records reviewer identity, rationale, analysis binding, version transition, and actor-separated history. Live n8n and Fish evidence is recorded in [AED-004](evidence/AED-004.md).
