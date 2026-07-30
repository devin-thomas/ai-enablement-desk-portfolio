import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp } from '../apps/server/src/app.js'
import type { AnalysisProvider } from '../apps/server/src/analysisProvider.js'
import { loadEnv } from '../apps/server/src/config/env.js'

const modelAnalysis: AIRequestAnalysis = {
  normalizedTitle: 'Synthetic live n8n verification',
  requestType: 'ai_project',
  businessProblem: 'A synthetic workflow needs observable automation evidence.',
  desiredOutcome: 'Record real workflow execution identifiers without personal data.',
  intendedUsers: ['Demo reviewers'],
  currentProcess: 'Synthetic records are reviewed manually.',
  dataSources: ['Synthetic records'],
  systemsToIntegrate: [],
  successMetrics: ['Persisted n8n execution evidence'],
  missingInformation: [],
  clarificationQuestions: [],
  riskFlags: [],
  readinessScore: 100,
  estimatedValue: 'medium',
  recommendedDisposition: 'ready_for_discovery',
  reviewerSummary: 'This synthetic request is ready for a named human discovery decision.',
  facts: [{ value: 'All verification content is synthetic.', source: 'requester', confirmed: true }],
  assumptions: [{ value: 'The local n8n workflow is available.', source: 'model_inference', confirmed: false }],
  unknowns: [],
  ruleEvaluation: [],
}

const provider: AnalysisProvider = {
  name: 'gemini-stub',
  model: 'synthetic-live-evidence',
  schemaVersion: 'analysis-v1',
  promptVersion: 'prompt-v1',
  analyze: async () => ({ analysis: modelAnalysis, latencyMs: 1 }),
}

const env = loadEnv()
const app = await createApp({ env, analysisProvider: provider })
await new Promise<void>((resolve) => app.server.listen(env.port, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${env.port}`

try {
  const list = await (await fetch(`${baseUrl}/api/requests`)).json() as { requests: Array<{ id: string; title: string; status: string }> }
  let request = list.requests.find((item) => item.title === 'Synthetic live n8n verification' && item.status === 'submitted')
  if (!request) {
    const created = await (await fetch(`${baseUrl}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Synthetic live n8n verification', requestType: 'ai_project', department: 'Demo Operations',
        requesterName: 'Synthetic Requester', requesterRole: 'Demo Owner',
        businessProblem: 'A synthetic workflow needs observable automation evidence.',
        desiredOutcome: 'Record real workflow execution identifiers without personal data.',
        currentProcess: 'Synthetic records are reviewed manually.', intendedUsers: ['Demo reviewers'],
        dataSources: ['Synthetic records'], syntheticDemoSafe: true,
      }),
    })).json() as { request: { id: string; title: string; status: string } }
    request = created.request
  }

  const analyzed = await (await fetch(`${baseUrl}/api/requests/${request.id}/analyses`, { method: 'POST' })).json() as { analysisRun: { id: string } }
  const detail = await (await fetch(`${baseUrl}/api/requests/${request.id}`)).json() as { request: { version: number } }
  const decisionResponse = await fetch(`${baseUrl}/api/requests/${request.id}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reviewerName: 'Synthetic Reviewer',
      decision: 'approve_for_discovery',
      rationale: 'Synthetic evidence is complete and deterministic governance checks pass.',
      analysisRunId: analyzed.analysisRun.id,
      expectedVersion: detail.request.version,
    }),
  })
  const decision = await decisionResponse.json() as { automationAttempt?: { status: string; externalExecutionId: string | null } }
  if (!decisionResponse.ok) throw new Error(`Decision verification failed with HTTP ${decisionResponse.status}`)

  const audioResponse = await fetch(`${baseUrl}/api/requests/${request.id}/audio-briefings`, { method: 'POST' })
  const audio = await audioResponse.json() as { code?: string; artifact?: { id: string; provider: string; status: string; byteLength: number } }
  const automations = await (await fetch(`${baseUrl}/api/requests/${request.id}/automations`)).json() as { automationAttempts: Array<{ automationName: string; status: string; externalExecutionId: string | null; correlationId: string }> }
  console.log(JSON.stringify({
    requestId: request.id,
    decisionAutomation: decision.automationAttempt,
    audioEvidence: { httpStatus: audioResponse.status, code: audio.code ?? null, artifact: audio.artifact ?? null },
    automationAttempts: automations.automationAttempts,
  }, null, 2))
} finally {
  await new Promise<void>((resolve) => app.server.close(() => resolve()))
  await app.database.close()
}
