import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const template = readFileSync('infra/azure/runtime.bicep', 'utf8')
const example = readFileSync('infra/azure/parameters.example.json', 'utf8')
const required = [
  "targetScope = 'resourceGroup'",
  "name: 'Standard_B1ms'",
  "version: '16'",
  "storageSizeGB: 32",
  "backupRetentionDays: 7",
  "name: 'require_secure_transport'",
  "value: 'on'",
  "name: 'allow-azure-services-temporary'",
  "startIpAddress: '0.0.0.0'",
  "targetPort: 3001",
  "minReplicas: 1",
  "maxReplicas: 2",
  "concurrentRequests: '25'",
  "name: 'DEMO_MODE', value: 'false'",
  "value: string(settings.geminiPublicLaunchApproved)",
  "value: string(settings.fishVoicePreflightApproved)",
  "value: string(settings.audioBriefingsEnabled)",
  "cronExpression: '17 * * * *'",
  'replicaTimeout: 300',
  'replicaRetryLimit: 1',
  "'workspaces:expire'",
  "name: 'database-url'",
  "secretRef: 'database-url'",
  "name: 'workspace-signing-key'",
  "name: 'origin-shared-secret'",
  "threshold: 40",
  "threshold: 70",
  "threshold: 90",
  "Microsoft.Insights/scheduledQueryRules@2023-12-01",
  "Microsoft.Insights/metricAlerts@2018-03-01",
  "metricName: 'cpu_credits_remaining'",
  "metricName: 'connections_failed'",
]

const missing = required.filter((value) => !template.includes(value))
if (missing.length) throw new Error(`Azure template is missing required controls: ${missing.join(', ')}`)

const forbidden = [/administratorLoginPassword:\s*['"]/i, /value:\s*['"](?:AIza|Bearer\s+)/i]
const matches = forbidden.flatMap((pattern) => template.match(pattern) ?? [])
if (matches.length) throw new Error(`Azure template contains an inline secret: ${matches.join(', ')}`)

const forbiddenResources = ['virtualNetworks@', 'privateEndpoints@', 'vaults@', 'components@', 'natGateways@', 'publicIPAddresses@', 'backupVaults@', 'locks@']
const includedForbiddenResources = forbiddenResources.filter((value) => template.includes(value))
if (includedForbiddenResources.length) throw new Error(`Azure template contains out-of-scope resources: ${includedForbiddenResources.join(', ')}`)

if (!example.includes('REPLACE_WITH_SECURE_DEPLOYMENT_INPUT')) throw new Error('Example parameters must retain secure-value placeholders')
if (/rg-aiedesk|aiedesk-preview-cus-\d{8}|expiresOn\": \"20\d{2}-\d{2}-\d{2}/.test(example)) throw new Error('Example parameters must not embed private launch identifiers or expiry dates')

const compileDirectory = mkdtempSync(join(tmpdir(), 'aiedesk-bicep-'))
const compiledPath = join(compileDirectory, 'main.json')
try {
  execFileSync(process.env.BICEP_BIN ?? 'bicep', ['build', 'infra/azure/main.bicep', '--outfile', compiledPath], { stdio: 'pipe' })
  const compiled = readFileSync(compiledPath, 'utf8')
  const compiledTemplate = JSON.parse(compiled)
  const compiledRequired = [
    'securestring',
    'secureObject',
  ]
  const compiledMissing = compiledRequired.filter((value) => !compiled.includes(value))
  if (compiledMissing.length) throw new Error(`Compiled Azure template is missing required controls: ${compiledMissing.join(', ')}`)

  const resourceTypes = []
  const collectResourceTypes = (value) => {
    if (Array.isArray(value)) return value.forEach(collectResourceTypes)
    if (!value || typeof value !== 'object') return
    if (typeof value.type === 'string') resourceTypes.push(value.type)
    Object.values(value).forEach(collectResourceTypes)
  }
  collectResourceTypes(compiledTemplate.resources)
  const minimumCounts = new Map([
    ['Microsoft.App/containerApps', 1],
    ['Microsoft.App/jobs', 1],
    ['Microsoft.DBforPostgreSQL/flexibleServers', 1],
    ['Microsoft.Authorization/roleAssignments', 2],
    ['Microsoft.Insights/scheduledQueryRules', 1],
    ['Microsoft.Insights/metricAlerts', 3],
  ])
  const missingResources = [...minimumCounts].filter(([type, minimum]) => resourceTypes.filter((actual) => actual === type).length < minimum).map(([type]) => type)
  if (missingResources.length) throw new Error(`Compiled Azure template is missing required resources: ${missingResources.join(', ')}`)
} finally {
  rmSync(compileDirectory, { recursive: true, force: true })
}

console.log('Azure preview template structural and Bicep compilation validation passed.')
