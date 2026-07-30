# Governance

- Demo data is synthetic only.
- Human reviewers own final approve, defer, and decline decisions.
- Voice is optional; the written reviewer summary is the primary artifact.
- High-risk personal data requests are escalated or declined by deterministic rules.
- Provider boundaries remain replaceable, and failures must preserve the usable text workflow.
- Automated recommendations and human decisions are recorded as separate audit events.
- Every consequential human decision records reviewer identity, rationale, reviewed analysis, prior and next status, and request version.
- Server-side legal-transition checks and optimistic concurrency prevent browser manipulation or stale reviews from overwriting a decision.
