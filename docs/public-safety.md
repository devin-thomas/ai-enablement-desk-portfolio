# Public-safety checklist

The automated `npm run public-safety` command scans Git-tracked paths and text for environment files, private keys, common API-key shapes, assigned secrets, service-account material, database/log artifacts, email addresses, and internal company identifiers.

Manual review completed on 2026-07-30:

- [x] `.env` is ignored and `.env.example` contains names and blank values only.
- [x] No API keys, webhook secrets, service-account files, database dumps, logs, or local provider data are tracked.
- [x] Fixtures use explicit synthetic requester identities and contain no real email addresses or personal records.
- [x] n8n exports contain no credentials; the shared secret is supplied only at runtime.
- [x] Screenshots were inspected and show synthetic demo content only.
- [x] No audio files are committed; live Fish artifacts remain in the ignored local demo database.
- [x] Documentation avoids private-company policies, employees, license counts, SLAs, and performance claims.
- [x] The exposed development Fish key was kept out of Git; rotation is recommended before any use beyond this time-bounded synthetic verification.

Binary media always requires human inspection because a text scanner cannot verify pixels or audio content.
