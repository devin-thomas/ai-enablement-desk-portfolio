# Architecture and trust boundaries

The React browser owns intake and review interactions but is never authoritative. The Node server revalidates shared Zod contracts, owns state transitions, and writes to Postgres. Local demonstrations use file-backed PGlite; hosted deployments can use Supabase/Postgres through the same database interface.

Gemini output is untrusted advisory data. The adapter requests structured JSON, validates its shape and evidence semantics, and persists immutable provenance. Deterministic rules then independently calculate risk, readiness, and routing. A model suggestion cannot write an approval.

n8n receives HMAC-signed, idempotent events only after the relevant database transaction commits. It orchestrates side effects and returns its execution identifier; decision logic remains in the application. Fish Audio is replaceable behind a server-only adapter. It receives only the written reviewer summary for records explicitly marked synthetic-safe, and only real non-empty audio bytes become an artifact.

Audit actors are structurally distinct: requester, AI provider, deterministic system, workflow, and named human. Human decisions bind reviewer identity, rationale, analysis run, previous status, resulting status, and request version in one transaction.

Failure is explicit: missing keys, disabled providers, timeouts, invalid output, retries, and payment errors never become success-shaped UI. Provider failures do not roll back an already committed request or decision, and written text remains available when audio fails.
