# n8n automation boundary

Workflows in this folder are credential-free exports. Secrets belong in n8n credentials or environment variables, never in committed JSON.

Importable workflows:

- `request-submitted.json`: accepts a signed intake event and returns the real n8n execution ID.
- `request-decision-recorded.json`: accepts a signed human-decision event and returns the real n8n execution ID.

Set `AED_WEBHOOK_SECRET` in the n8n runtime, allow the Code node to use Node's built-in `crypto` module, import and activate both workflows, then configure the matching webhook URLs and the same secret in the desk server. The application signs the exact JSON body, records workflow version, correlation ID, idempotency key, retry state, and n8n's returned execution ID.

Fish Audio remains behind the trusted application server rather than committed n8n credentials. It is restricted to records explicitly marked synthetic demo-safe, creates an artifact only from non-empty `audio/*` bytes, and otherwise retains the written briefing as the authoritative fallback.
