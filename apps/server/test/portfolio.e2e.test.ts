import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp, type AppInstance } from '../src/app.js'
import type { AnalysisProvider, AnalysisProviderInput } from '../src/analysisProvider.js'
import type { AudioProvider } from '../src/audio.js'
import type { ServerEnv } from '../src/config/env.js'
import { createMemoryDatabase } from '../src/database.js'

function analysis(overrides: Partial<AIRequestAnalysis> = {}): AIRequestAnalysis {
  return {
    normalizedTitle: 'Synthetic maintenance review', requestType: 'ai_project', businessProblem: 'Review synthetic maintenance reports.',
    desiredOutcome: 'Route important findings to a named reviewer.', intendedUsers: ['Demo reviewers'], currentProcess: 'Manual review',
    dataSources: ['Synthetic field reports'], systemsToIntegrate: [], successMetrics: ['Human-validated recall'], missingInformation: [],
    clarificationQuestions: [], riskFlags: [], readinessScore: 100, estimatedValue: 'medium', recommendedDisposition: 'ready_for_discovery',
    reviewerSummary: 'Synthetic evidence is complete enough for a named human discovery decision.',
    facts: [{ value: 'Reports are synthetic.', source: 'requester', confirmed: true }],
    assumptions: [{ value: 'Report structure is stable.', source: 'model_inference', confirmed: false }], unknowns: [], ruleEvaluation: [], ...overrides,
  }
}

class PortfolioProvider implements AnalysisProvider {
  readonly name = 'gemini-stub'; readonly model = 'portfolio-e2e'; readonly schemaVersion = '1'; readonly promptVersion = '1'
  private maintenanceRuns = 0
  async analyze(input: AnalysisProviderInput) {
    if (input.request.businessProblem.includes('employee medical')) return { latencyMs: 1, analysis: analysis({ riskFlags: [{ category: 'privacy', severity: 'high', explanation: 'Sensitive employee data cannot enter a public AI service.' }] }) }
    this.maintenanceRuns += 1
    if (this.maintenanceRuns === 1) return { latencyMs: 1, analysis: analysis({ missingInformation: ['Named validator'], clarificationQuestions: [{ id: 'CQ-VALIDATOR', question: 'Who validates the summary?', targetField: 'validator', reason: 'Human validation is required.', priority: 1, blocking: true }] }) }
    return { latencyMs: 1, analysis: analysis() }
  }
}

describe('portfolio end-to-end scenarios', () => {
  let app: AppInstance
  let baseUrl: string
  const env: ServerEnv = { nodeEnv: 'test', port: 3001, demoMode: true, demoResetEnabled: true, demoDatabasePath: 'unused', geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000, audioBriefingsEnabled: true }
  const audioProvider: AudioProvider = { name: 'fish-audio-stub', model: 'synthetic-bytes', generate: async () => ({ bytes: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mimeType: 'audio/mpeg', externalArtifactId: 'synthetic-audio-1' }) }

  beforeAll(async () => {
    app = await createApp({ database: createMemoryDatabase(), env, analysisProvider: new PortfolioProvider(), audioProvider })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>((resolve) => app.server.close(() => resolve())); await app.database.close() })

  it('completes maintenance clarification, approval, evidence, audio, and deterministic reset', async () => {
    const created = await (await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: 'Synthetic maintenance report triage', requestType: 'ai_project', department: 'Demo Operations', requesterName: 'Synthetic Maintenance Requester', requesterRole: 'Maintenance Manager',
      businessProblem: 'Review synthetic maintenance reports for issues.', desiredOutcome: 'Route important findings to a named reviewer.', currentProcess: 'Manual review',
      intendedUsers: ['Demo reviewers'], dataSources: ['Synthetic field reports'], syntheticDemoSafe: true,
    }) })).json()
    const requestId = created.request.id
    const first = await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })).json()
    expect(first.analysisRun.systemRecommendation).toBe('needs_clarification')
    await fetch(`${baseUrl}/api/requests/${requestId}/clarifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: 'CQ-VALIDATOR', answer: 'A named demo reviewer validates every summary.', actorType: 'requester', actorName: 'Synthetic Maintenance Requester' }) })
    const second = await (await fetch(`${baseUrl}/api/requests/${requestId}/analyses`, { method: 'POST' })).json()
    const detail = await (await fetch(`${baseUrl}/api/requests/${requestId}`)).json()
    const decision = await fetch(`${baseUrl}/api/requests/${requestId}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewerName: 'Synthetic Reviewer', rationale: 'Synthetic evidence and deterministic checks support discovery.', decision: 'approve_for_discovery', analysisRunId: second.analysisRun.id, expectedVersion: detail.request.version }) })
    expect(decision.status).toBe(201)
    const audio = await (await fetch(`${baseUrl}/api/requests/${requestId}/audio-briefings`, { method: 'POST' })).json()
    expect(audio.artifact).toMatchObject({ status: 'success', byteLength: 10 })

    const reset = await (await fetch(`${baseUrl}/api/demo/reset`, { method: 'POST' })).json()
    expect(reset.requests).toHaveLength(10)
    const artifacts = await (await fetch(`${baseUrl}/api/requests/${requestId}/artifacts`)).json()
    expect(artifacts.artifacts).toEqual([])
  })

  it('prevents approval of the high-risk employee-data scenario', async () => {
    const reset = await (await fetch(`${baseUrl}/api/demo/reset`, { method: 'POST' })).json()
    const risky = reset.requests.find((request: { title: string }) => request.title === 'Employee records summarization')
    const analyzed = await (await fetch(`${baseUrl}/api/requests/${risky.id}/analyses`, { method: 'POST' })).json()
    expect(analyzed.analysisRun.systemRecommendation).toBe('decline')
    expect(analyzed.analysisRun.ruleEvaluation).toContainEqual(expect.objectContaining({ rule: 'privacy_high_risk_gate', result: 'failed' }))
    const detail = await (await fetch(`${baseUrl}/api/requests/${risky.id}`)).json()
    const response = await fetch(`${baseUrl}/api/requests/${risky.id}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewerName: 'Synthetic Reviewer', rationale: 'Attempted approval must be blocked by deterministic privacy governance.', decision: 'approve_for_discovery', analysisRunId: analyzed.analysisRun.id, expectedVersion: detail.request.version }) })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'illegal_transition' })
  })
})
