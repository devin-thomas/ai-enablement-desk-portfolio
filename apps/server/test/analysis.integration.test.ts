import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp, type AppInstance } from '../src/app.js'
import { AnalysisProviderError, type AnalysisProvider, type AnalysisProviderInput, type AnalysisProviderResult } from '../src/analysisProvider.js'
import { createMemoryDatabase } from '../src/database.js'
import type { ServerEnv } from '../src/config/env.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused',
  geminiModel: 'stub-model', geminiSchemaVersion: 'analysis-v1', geminiPromptVersion: 'prompt-v1', geminiTimeoutMs: 1000,
}

function analysis(overrides: Partial<AIRequestAnalysis> = {}): AIRequestAnalysis {
  return {
    normalizedTitle: 'Maintenance field report triage', requestType: 'ai_project',
    businessProblem: 'Review long synthetic field reports.', desiredOutcome: 'Surface urgent issues for human validation.',
    intendedUsers: ['Maintenance managers'], currentProcess: 'Manual review', dataSources: ['Synthetic field reports'],
    systemsToIntegrate: [], successMetrics: [], missingInformation: ['Human validator and measurable success criteria'],
    clarificationQuestions: [{ id: 'CQ-HUMAN_VALIDATOR', question: 'Who validates the summary and what metric defines success?', targetField: 'humanValidator', reason: 'Human validation and a success metric are required.', priority: 1, blocking: true }],
    riskFlags: [], readinessScore: 95, estimatedValue: 'high', recommendedDisposition: 'ready_for_discovery',
    reviewerSummary: 'Advisory summary for a synthetic maintenance request.',
    facts: [{ value: 'Maintenance managers review synthetic reports.', source: 'requester', confirmed: true }],
    assumptions: [{ value: 'Reports have a consistent structure.', source: 'model_inference', confirmed: false }],
    unknowns: ['Human validator'], ruleEvaluation: [], ...overrides,
  }
}

class ScriptedProvider implements AnalysisProvider {
  readonly name = 'stub-gemini'
  readonly model = 'stub-model'
  readonly schemaVersion = 'analysis-v1'
  readonly promptVersion = 'prompt-v1'
  readonly steps: Array<AIRequestAnalysis | AnalysisProviderError> = []

  async analyze(_input: AnalysisProviderInput): Promise<AnalysisProviderResult> {
    const step = this.steps.shift()
    if (!step) throw new Error('No scripted provider result')
    if (step instanceof AnalysisProviderError) throw step
    return { analysis: step, latencyMs: 12 }
  }
}

describe('analysis and clarification API', () => {
  let app: AppInstance
  let provider: ScriptedProvider
  let baseUrl: string

  beforeEach(async () => {
    provider = new ScriptedProvider()
    app = await createApp({ database: createMemoryDatabase(), env, analysisProvider: provider })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    await app.database.close()
  })

  async function createRequest(kind: 'maintenance' | 'privacy' = 'maintenance'): Promise<string> {
    const privacy = kind === 'privacy'
    const response = await fetch(`${baseUrl}/api/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        title: privacy ? 'Sensitive employee record analysis' : 'Maintenance report analysis', requestType: 'ai_project',
        department: privacy ? 'People Operations' : 'Operations Excellence', requesterName: 'Synthetic Requester', requesterRole: 'Process Owner',
        businessProblem: privacy ? 'A manager wants a public AI service to summarize employee medical and performance records.' : 'Managers need to review long synthetic maintenance reports and identify urgent issues.',
        desiredOutcome: privacy ? 'Summarize employee records.' : 'Surface urgent issues for human review.',
        currentProcess: 'Authorized staff review records manually.', intendedUsers: ['Demo reviewers'],
        dataSources: privacy ? ['Employee medical records', 'Public AI service'] : ['Synthetic field reports'],
      }),
    })
    return (await response.json()).request.id
  }

  it('persists immutable analyses, clarification evidence, and deterministic overrides across re-analysis', async () => {
    const requestId = await createRequest()
    provider.steps.push(analysis())
    const first = await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })
    expect(first.status).toBe(201)
    const firstRun = (await first.json()).analysisRun
    expect(firstRun.modelRecommendation).toBe('ready_for_discovery')
    expect(firstRun.systemRecommendation).toBe('needs_clarification')
    expect(firstRun.ruleEvaluation).toContainEqual(expect.objectContaining({ rule: 'deterministic_routing', result: 'needs_review' }))

    const answered = await fetch(`${baseUrl}/api/requests/${requestId}/clarifications`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        questionId: 'CQ-HUMAN_VALIDATOR', answer: 'A named maintenance manager performs human review; success is measured by validated urgent-issue recall.',
        actorType: 'requester', actorName: 'Synthetic Requester',
      }),
    })
    expect(answered.status).toBe(201)

    provider.steps.push(analysis({ missingInformation: [], clarificationQuestions: [], unknowns: [], readinessScore: 100 }))
    const secondRun = (await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })).json()).analysisRun
    expect(secondRun.id).not.toBe(firstRun.id)
    expect(secondRun.systemRecommendation).toBe('ready_for_discovery')

    const history = await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`)).json()
    expect(history.analyses).toHaveLength(2)
    expect(history.clarificationAnswers).toMatchObject([{ questionId: 'CQ-HUMAN_VALIDATOR', actorType: 'requester' }])
    const detail = await (await fetch(`${baseUrl}/api/requests/${requestId}`)).json()
    expect(detail.request.auditEvents.map((event: { eventType: string }) => event.eventType)).toContain('clarification_answered')
  })

  it('overrides a model suggestion and keeps high-risk privacy input out of approval-ready status', async () => {
    const requestId = await createRequest('privacy')
    provider.steps.push(analysis({ missingInformation: [], clarificationQuestions: [], unknowns: [], riskFlags: [], recommendedDisposition: 'ready_for_discovery' }))
    const run = (await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })).json()).analysisRun
    expect(run.systemRecommendation).toBe('decline')
    expect(run.ruleEvaluation).toContainEqual(expect.objectContaining({ rule: 'privacy_high_risk_gate', result: 'failed' }))
    const detail = await (await fetch(`${baseUrl}/api/requests/${requestId}`)).json()
    expect(detail.request.status).toBe('needs_clarification')
  })

  it.each([
    ['timeout', 502], ['rate_limited', 429], ['invalid_output', 502], ['unavailable_key', 503],
  ] as const)('persists and exposes retryable %s failures', async (code, expectedStatus) => {
    const requestId = await createRequest()
    provider.steps.push(new AnalysisProviderError(code, `Synthetic ${code}`, 25))
    const response = await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })
    expect(response.status).toBe(expectedStatus)
    expect(await response.json()).toMatchObject({ code, analysisRun: { outcome: code, sanitizedErrorCode: code } })
    const history = await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`)).json()
    expect(history.analyses[0]).toMatchObject({ outcome: code, modelAnalysis: null })
    const detail = await (await fetch(`${baseUrl}/api/requests/${requestId}`)).json()
    expect(detail.request.status).toBe('analysis_failed')
  })
})
