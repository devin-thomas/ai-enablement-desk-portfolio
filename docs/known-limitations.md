# Known limitations

- This is a single-workspace portfolio demonstration without production authentication, authorization, tenant isolation, or enterprise IAM.
- Local reviewer identity is typed by the user. Production must derive identity from authenticated claims.
- Supabase/Postgres is supported as a persistence target, but production RLS, backup, retention, and operational monitoring are not implemented here.
- Gemini, n8n, and Fish Audio require external configuration. Automated tests use replaceable stubs; live evidence is documented separately.
- The deterministic rules demonstrate governance mechanics, not an organization’s approved policy. Legal, privacy, security, and procurement owners must define production rules.
- n8n runs locally for evidence and is not a production notification deployment. Slack, Teams, and email delivery are out of scope.
- The free Fish model is suitable for development evidence and has no production SLA. Audio is never an approval mechanism.
- Accessibility covers the primary keyboard, focus, loading, validation, and error paths, but no independent WCAG audit has been performed.
- The demo does not include full observability, disaster recovery, penetration testing, or load testing.
