import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp } from '../apps/server/src/app.js'
import type { AnalysisProvider } from '../apps/server/src/analysisProvider.js'
import type { ServerEnv } from '../apps/server/src/config/env.js'

const root = process.cwd()
const apiPort = 3001
const webPort = 4173
const screenshot = resolve(root, 'docs/evidence/aed-003-human-decision-audit.png')
await mkdir(resolve(root, 'docs/evidence'), { recursive: true })

const modelAnalysis: AIRequestAnalysis = {
  normalizedTitle: 'Maintenance report discovery', requestType: 'ai_project', businessProblem: 'Review synthetic field reports.',
  desiredOutcome: 'Surface issues for human validation.', intendedUsers: ['Maintenance managers'], currentProcess: 'Manual review',
  dataSources: ['Synthetic field reports'], systemsToIntegrate: [], successMetrics: ['Validated issue recall'], missingInformation: [], clarificationQuestions: [],
  riskFlags: [], readinessScore: 100, estimatedValue: 'high', recommendedDisposition: 'ready_for_discovery', reviewerSummary: 'Evidence is complete enough for a named human to decide whether discovery should begin.',
  facts: [{ value: 'Managers currently review reports manually.', source: 'requester', confirmed: true }],
  assumptions: [{ value: 'Report structure is stable.', source: 'model_inference', confirmed: false }], unknowns: [], ruleEvaluation: [],
}
const provider: AnalysisProvider = { name: 'gemini-stub', model: 'synthetic-evidence', schemaVersion: 'analysis-v1', promptVersion: 'prompt-v1', analyze: async () => ({ analysis: modelAnalysis, latencyMs: 11 }) }
const env: ServerEnv = { nodeEnv: 'development', port: apiPort, demoMode: true, demoDatabasePath: 'tmp/aed-003-capture/database', geminiApiKey: 'synthetic-evidence-key', geminiModel: 'gemini-2.5-flash-lite', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 20_000 }
const app = await createApp({ env, analysisProvider: provider })
await new Promise<void>((resolveListen) => app.server.listen(apiPort, '127.0.0.1', resolveListen))
await fetch(`http://127.0.0.1:${apiPort}/api/demo/reset`, { method: 'POST' })
const created = await (await fetch(`http://127.0.0.1:${apiPort}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  title: 'Governed maintenance discovery', requestType: 'ai_project', department: 'Operations Excellence', requesterName: 'Synthetic Maintenance Requester', requesterRole: 'Maintenance Manager',
  businessProblem: 'Maintenance managers need a governed summary of synthetic field reports for issue review.', desiredOutcome: 'Surface issues for human review.',
  currentProcess: 'Managers read synthetic reports manually.', intendedUsers: ['Maintenance managers'], dataSources: ['Synthetic field reports'],
}) })).json()
const analyzed = await (await fetch(`http://127.0.0.1:${apiPort}/api/requests/${created.request.id}/analyses`, { method: 'POST' })).json()
const reviewed = await (await fetch(`http://127.0.0.1:${apiPort}/api/requests/${created.request.id}`)).json()
await fetch(`http://127.0.0.1:${apiPort}/api/requests/${created.request.id}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  reviewerName: 'Synthetic Reviewer', decision: 'approve_for_discovery', rationale: 'Synthetic evidence is complete and deterministic governance checks pass.',
  analysisRunId: analyzed.analysisRun.id, expectedVersion: reviewed.request.version,
}) })
const vite = await createViteServer({ root, server: { host: '127.0.0.1', port: webPort } })
await vite.listen()

try {
  await new Promise<void>((resolveCapture, rejectCapture) => {
    const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=5000', '--window-size=1440,2300',
      `--screenshot=${screenshot}`, `http://127.0.0.1:${webPort}`,
    ], { stdio: 'inherit' })
    chrome.on('error', rejectCapture)
    chrome.on('exit', (code) => code === 0 ? resolveCapture() : rejectCapture(new Error(`Chrome exited with code ${code}`)))
  })
  console.log(screenshot)
} finally {
  await vite.close()
  await new Promise<void>((resolveClose) => app.server.close(() => resolveClose()))
  await app.database.close()
}
