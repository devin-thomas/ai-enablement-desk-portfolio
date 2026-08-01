# Temporary Azure preview runtime

These Bicep files describe the disposable preview runtime and nothing outside its
resource group: a Basic registry, Log Analytics workspace, Consumption Container
Apps environment, API app, hourly workspace-expiry job, PostgreSQL Flexible
Server/database, Azure-services-only temporary firewall exception, and a
resource-group budget/action group.

The deployment entry point is `main.bicep`, which deliberately requires all
resource names, owner/expiry tags, alert recipients, image digest, dates, and
secret values as parameters. Do not replace these required values with defaults,
commit a filled parameter file, pass secrets as CLI arguments, add them to build
arguments, or print them in deployment logs. `parameters.example.json` is a
schema guide only and is intentionally not deployable.

## Authorized launch sequence

Use one private parameter source throughout; it must stay outside this repository.
The template defaults `deployWorkloads` to `false`, so a fresh deployment creates
only the disposable resource group and foundation (registry, logs, Container Apps
environment, PostgreSQL, budget, and alert action group). It cannot create the
API app or expiry job in this phase.

1. Deploy the foundation with `deployWorkloads=false` and the provisioning-only
   PostgreSQL administrator password supplied through a redacted secure mechanism.
2. Build the runtime image for the Azure architecture, push it to that new ACR,
   and record the resulting immutable `@sha256:` digest. Never promote a tag.
3. Add the generated application values to the private parameter source and run
   `npm run validate:azure:private -- /absolute/path/to/private-parameters.json`.
   The gate checks the digest, `sslmode=verify-full`, and that the app connection
   uses a non-administrator database user without printing any value.
4. Only after that gate passes, deploy the workload phase with
   `deployWorkloads=true`. It creates the API, scheduled job, and their ACR pull
   assignments from the exact digest.
5. System-assigned identities do not exist until their workload is created, and
   ACR role propagation is asynchronous. Wait until both explicit `AcrPull` role
   assignments are effective, then redeploy the same workload parameters and
   unchanged digest. Do not replace the digest or bypass the role assignment to
   work around an initial image-pull failure.

From the repository root, the authorized executor uses this command shape; the
absolute private parameter path must resolve outside the repository and must
already pass the private validator:

```bash
npm run validate:azure
npm run validate:azure:private -- /absolute/private/path/azure.private.json
az deployment sub create --location centralus --template-file infra/azure/main.bicep --parameters @/absolute/private/path/azure.private.json --parameters deployWorkloads=false
az acr build --registry <registry-from-private-parameters> --image api:<immutable-build-id> .
az acr repository show --name <registry-from-private-parameters> --image api:<immutable-build-id> --query digest --output tsv
az deployment sub create --location centralus --template-file infra/azure/main.bicep --parameters @/absolute/private/path/azure.private.json --parameters deployWorkloads=true
```

After the first workload deployment creates both system identities, verify both
`AcrPull` assignments by principal ID, allow Azure RBAC propagation to complete,
and repeat the final deployment command without changing the recorded digest.
Do not place secret values directly after `--parameters`; the only command-line
override above is the non-secret phase switch.

This sequence is intentionally a handoff, not a deployment command: it must be
performed only by an authorized executor with the approved private parameter
source. It never requires a public parameter file or secret-bearing build input.

The API and job use managed identities to pull the immutable image from ACR. The
API starts as the image's non-root default process; it has explicit startup,
liveness, and readiness probes on port 3001. The job runs `npm run
workspaces:expire` on the same digest every hour, with only its database
connection exposed to the job environment.

PostgreSQL requires encrypted transport, uses a separate application connection
string secret, has no high availability or storage autogrow, and retains backups
for seven days. The `0.0.0.0` Azure-services firewall rule is a temporary
Consumption-plan egress compromise, not an allowlist for this deployment. Do not
widen it. The budget emits notification-only actual-cost alerts at 40%, 70%, and
90%; it is not a kill switch.

The workload phase also creates four operational alerts to the same action group:
Container Apps readiness/revision/restart platform events, API HTTP 5xx responses,
PostgreSQL CPU credits remaining, and PostgreSQL failed connections. Alerts are
notifications for human response, not remediation automation.

Before any authorized deployment, keep the private launch parameter source and
the generated values outside this repository, confirm the image reference is a
digest (not a mutable tag), and use a secure deployment mechanism that redacts
parameter values. Keep all provider gates false until their account preflights
pass, then enable them only in the private deployment settings. Provision the
least-privilege application database role separately through a redacted database
session; the `databaseUrl` secret must never use the server administrator. Teardown
must delete the entire dedicated resource group after
traffic and scheduled activity are disabled; do not retain its registry, database,
or logs as a shared resource.

Run `npm run validate:azure` for an offline structural and compiled-template
check. It deliberately does not authenticate to Azure, inspect a subscription,
build an image, or deploy anything. It requires the official standalone
[Bicep CLI](https://learn.microsoft.com/azure/azure-resource-manager/bicep/install)
on `PATH` (or its absolute path in `BICEP_BIN`); the validator compiles only into
a temporary local directory and removes that output afterward.
