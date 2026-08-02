import { readFileSync } from 'node:fs'

const parameterPath = process.argv[2]
if (!parameterPath) throw new Error('Provide the path to the private Azure parameter file.')

const parameters = JSON.parse(readFileSync(parameterPath, 'utf8')).parameters
const getValue = (name) => parameters[name]?.value
const fail = (field) => {
  throw new Error(`Private Azure parameter validation failed: ${field}`)
}

const settings = getValue('deploymentSettings')
const secrets = getValue('applicationSecrets')
if (!settings || typeof settings !== 'object') fail('deploymentSettings is required')
if (!secrets || typeof secrets !== 'object') fail('applicationSecrets is required')
if (typeof settings.demoResetEnabled !== 'boolean') fail('demoResetEnabled must be explicitly set in deploymentSettings')
if (getValue('location') !== 'centralus') fail('location must be centralus')
if (settings.budgetAmount !== 50) fail('budgetAmount must be 50')

const tags = getValue('resourceGroupTags')
if (!tags || tags.app !== 'ai-enablement-desk' || tags.environment !== 'preview' || !tags.expiresOn || !tags.owner) fail('required resource-group tags are missing')
if (!Array.isArray(settings.alertEmailRecipients) || settings.alertEmailRecipients.length === 0 || settings.alertEmailRecipients.some((value) => typeof value !== 'string' || !value.includes('@'))) fail('at least one alert email recipient is required')

const imageDigest = settings.apiImageDigest
if (typeof imageDigest !== 'string' || !/@sha256:[a-f0-9]{64}$/i.test(imageDigest)) fail('apiImageDigest must be an immutable sha256 digest')

const databaseUrl = secrets.databaseUrl
if (typeof databaseUrl !== 'string') fail('databaseUrl is required')

let parsedDatabaseUrl
try {
  parsedDatabaseUrl = new URL(databaseUrl)
} catch {
  fail('databaseUrl must be a valid PostgreSQL URL')
}

if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) fail('databaseUrl must use a PostgreSQL URL')
if (parsedDatabaseUrl.searchParams.get('sslmode') !== 'verify-full') fail('databaseUrl must use sslmode=verify-full')
if (!parsedDatabaseUrl.username) fail('databaseUrl must include an application database username')
if (parsedDatabaseUrl.username === settings.postgresAdministratorLogin) fail('databaseUrl must not use the PostgreSQL administrator username')

for (const name of ['workspaceSigningKey', 'originSharedSecret']) {
  if (typeof secrets[name] !== 'string' || secrets[name].length < 32) fail(`${name} must be at least 32 characters`)
}
if (secrets.originSharedSecretSecondary !== undefined && (typeof secrets.originSharedSecretSecondary !== 'string' || secrets.originSharedSecretSecondary.length < 32)) fail('originSharedSecretSecondary must be at least 32 characters when configured')

if (settings.geminiPublicLaunchApproved && !secrets.geminiApiKey) fail('geminiApiKey is required when Gemini launch is approved')
if ((settings.fishVoicePreflightApproved || settings.audioBriefingsEnabled) && !secrets.fishApiKey) fail('fishApiKey is required when Fish audio is approved or enabled')
if (settings.audioBriefingsEnabled && !settings.fishVoicePreflightApproved) fail('audioBriefingsEnabled requires the Fish voice preflight approval')

console.log('Private Azure parameter validation passed.')
