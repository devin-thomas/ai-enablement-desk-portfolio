import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AIRequestAnalysis, HumanDecision } from '@ai-enablement/contracts'
import { createApp, type AppInstance } from '../src/app.js'
import type { AnalysisProvider, AnalysisProviderInput, AnalysisProviderResult } from '../src/analysisProvider.js'
import { createMemoryDatabase } from '../src/database.js'
import type { ServerEnv } from '../src/config/env.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused',
  geminiModel: 'stub-model', geminiSchemaVersion: 'analysis-v1', geminiPromptVersion: 'prompt-v1', geminiTimeoutMs: 1000,
}

function modelAnalysis(overrides: Partial<AIRequestAnalysis> = {}): AIRequestAnalysis {
  return {
    normalizedTitle: 'Synthetic process review', requestType: 'ai_project', businessProblem: 'Review a synthetic workflow.',
    desiredOutcome: 'Provide a human-reviewed summary.', intendedUsers: ['Demo reviewers'], currentProcess: 'Manual review',
    dataSources: ['Synthetic records'], systemsToIntegrate: [], successMetrics: ['Validated recall'], missingInformation: [],
    clarificationQuestions: [], riskFlags: [], readinessScore: 100, estimatedValue: 'medium', recommendedDisposition: 'ready_for_discovery',
    reviewerSummary: 'Synthetic advisory analysis ready for named human review.',
    facts: [{ value: 'The current process is manual.', source: 'requester', confirmed: true }],
    assumptions: [{ value: 'Input structure is consistent.', source: 'model_inference', confirmed: false }], unknowns: [], ruleEvaluation: [], ...overrides,
  }
}

class ReviewProvider implements AnalysisProvider {
  readonly name = 'stub-gemini'; readonly model = 'stub-model'; readonly schemaVersion = 'analysis-v1'; readonly promptVersion = 'prompt-v1'
  readonly steps: AIRequestAnalysis[] = []
  async analyze(_input: AnalysisProviderInput): Promise<AnalysisProviderResult> {
    const analysis = this.steps.shift()
    if (!analysis) throw new Error('No scripted analysis')
    return { analysis, latencyMs: 10 }
  }
}

describe('human review decisions', () => {
  let app: AppInstance
  let provider: ReviewProvider
  let baseUrl: string

  beforeEach(async () => {
    provider = new ReviewProvider()
    app = await createApp({ database: createMemoryDatabase(), env, analysisProvider: provider })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    await app.database.close()
  })

  async function createRequest(privacy = false): Promise<string> {
    const response = await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: privacy ? 'Sensitive employee review' : 'Synthetic process review', requestType: 'ai_project', department: privacy ? 'People Operations' : 'Operations',
      requesterName: 'Synthetic Requester', requesterRole: 'Process Owner',
      businessProblem: privacy ? 'A manager wants a public AI service to summarize employee medical records.' : 'A process owner needs a governed summary of synthetic operational records.',
      desiredOutcome: 'Provide a human-reviewed summary.', currentProcess: 'Authorized staff review records manually.', intendedUsers: ['Demo reviewers'],
      dataSources: privacy ? ['Employee medical records', 'Public AI service'] : ['Synthetic records'],
    }) })
    return (await response.json()).request.id
  }

  async function analyze(requestId: string, value = modelAnalysis()): Promise<{ id: string; version: number }> {
    provider.steps.push(value)
    const run = (await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })).json()).analysisRun
    const detail = await (await fetch(`${baseUrl}/api/requests/${requestId}`)).json()
    return { id: run.id, version: detail.request.version }
  }

  async function decide(requestId: string, analysisRunId: string, expectedVersion: number, decision: HumanDecision['decision']) {
    return fetch(`${baseUrl}/api/requests/${requestId}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      reviewerName: 'Synthetic Reviewer', rationale: `Documented synthetic rationale for ${decision}.`, decision, analysisRunId, expectedVersion,
    }) })
  }

  it('completes analyzed, clarified, re-analyzed, and human-approved lifecycle with permanent evidence', async () => {
    const requestId = await createRequest()
    const first = await analyze(requestId, modelAnalysis({ missingInformation: ['Human validator'], clarificationQuestions: [
      { id: 'CQ-VALIDATOR', question: 'Who validates the result and how is success measured?', targetField: 'humanValidator', reason: 'Approval requires human validation.', priority: 1, blocking: true },
    ] }))
    await fetch(`${baseUrl}/api/requests/${requestId}/clarifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      questionId: 'CQ-VALIDATOR', answer: 'A synthetic reviewer performs human review and measures validated recall.', actorType: 'requester', actorName: 'Synthetic Requester',
    }) })
    const second = await analyze(requestId)
    expect(second.id).not.toBe(first.id)

    const response = await decide(requestId, second.id, second.version, 'approve_for_discovery')
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ decision: { reviewerName: 'Synthetic Reviewer', previousStatus: 'ready_for_review', nextStatus: 'approved_for_discovery', analysisRunId: second.id, resultingVersion: second.version + 1 } })

    const decisions = await (await fetch(`${baseUrl}/api/requests/${requestId}/decisions`)).json()
    expect(decisions.decisions).toHaveLength(1)
    const audit = await (await fetch(`${baseUrl}/api/requests/${requestId}/audit-events`)).json()
    expect(new Set(audit.auditEvents.map((event: { actorType: string }) => event.actorType))).toEqual(new Set(['requester', 'ai', 'system', 'human', 'workflow']))
    expect(audit.auditEvents).toContainEqual(expect.objectContaining({ actorType: 'human', actorName: 'Synthetic Reviewer', eventType: 'human_decision_recorded' }))
  })

  it.each([['defer', 'deferred'], ['decline', 'declined'], ['request_clarification', 'needs_clarification']] as const)('records legal %s decisions transactionally', async (decision, nextStatus) => {
    const requestId = await createRequest()
    const analysis = await analyze(requestId)
    const response = await decide(requestId, analysis.id, analysis.version, decision)
    expect(response.status).toBe(201)
    expect((await response.json()).decision.nextStatus).toBe(nextStatus)
  })

  it('rejects approval for high-risk and incomplete requests through the direct API', async () => {
    const privacyId = await createRequest(true)
    const privacyAnalysis = await analyze(privacyId)
    const privacyResponse = await decide(privacyId, privacyAnalysis.id, privacyAnalysis.version, 'approve_for_discovery')
    expect(privacyResponse.status).toBe(409)

    const incompleteId = await createRequest()
    const incomplete = await analyze(incompleteId, modelAnalysis({ missingInformation: ['Owner'], clarificationQuestions: [
      { id: 'CQ-OWNER', question: 'Who owns validation?', targetField: 'owner', reason: 'Ownership is required.', priority: 1, blocking: true },
    ] }))
    const incompleteResponse = await decide(incompleteId, incomplete.id, incomplete.version, 'approve_for_discovery')
    expect(incompleteResponse.status).toBe(409)
  })

  it('prevents stale simultaneous decisions from silently overwriting each other', async () => {
    const requestId = await createRequest()
    const analysis = await analyze(requestId)
    const results = await Promise.all([
      decide(requestId, analysis.id, analysis.version, 'defer'),
      decide(requestId, analysis.id, analysis.version, 'decline'),
    ])
    expect(results.map((response) => response.status).sort()).toEqual([201, 409])
    expect((await (await fetch(`${baseUrl}/api/requests/${requestId}/decisions`)).json()).decisions).toHaveLength(1)
  })

  it('rejects illegal transitions without partially writing a second decision or audit event', async () => {
    const requestId = await createRequest()
    const analysis = await analyze(requestId)
    const approved = await decide(requestId, analysis.id, analysis.version, 'approve_for_discovery')
    const approvedDecision = (await approved.json()).decision
    const illegal = await decide(requestId, analysis.id, approvedDecision.resultingVersion, 'decline')
    expect(illegal.status).toBe(409)
    expect(await illegal.json()).toMatchObject({ code: 'illegal_transition' })
    expect((await (await fetch(`${baseUrl}/api/requests/${requestId}/decisions`)).json()).decisions).toHaveLength(1)
    const audit = await (await fetch(`${baseUrl}/api/requests/${requestId}/audit-events`)).json()
    expect(audit.auditEvents.filter((event: { eventType: string }) => event.eventType === 'human_decision_recorded')).toHaveLength(1)
  })

  it('requires reviewer identity, rationale, analysis version, and request version at the server boundary', async () => {
    const requestId = await createRequest()
    const analysis = await analyze(requestId)
    const response = await fetch(`${baseUrl}/api/requests/${requestId}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      reviewerName: '', rationale: 'short', decision: 'approve_for_discovery', analysisRunId: analysis.id, expectedVersion: analysis.version,
    }) })
    expect(response.status).toBe(422)
    expect((await (await fetch(`${baseUrl}/api/requests/${requestId}/decisions`)).json()).decisions).toHaveLength(0)
  })
})
