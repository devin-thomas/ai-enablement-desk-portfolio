import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiAnalysisProvider, AnalysisProviderError } from '../src/analysisProvider.js'
import type { ServerEnv } from '../src/config/env.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', geminiApiKey: 'synthetic-test-key',
  geminiModel: 'gemini-2.5-flash-lite', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000, geminiPublicLaunchApproved: true,
}

describe('Gemini provider contract validation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects malformed structured model output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ recommendedDisposition: 'ready_for_discovery' }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new GeminiAnalysisProvider(env)
    await expect(provider.analyze({ request: {} as never, clarificationAnswers: [] })).rejects.toMatchObject<Partial<AnalysisProviderError>>({ code: 'invalid_output' })
  })

  it('uses the documented structured-output contract and retries one transient unavailable response', async () => {
    const analysis = {
      normalizedTitle: 'Synthetic analysis', requestType: 'ai_project', businessProblem: 'Synthetic problem', desiredOutcome: 'Human review.', intendedUsers: [], currentProcess: null,
      dataSources: [], systemsToIntegrate: [], successMetrics: [], missingInformation: [], clarificationQuestions: [], riskFlags: [], readinessScore: 0, estimatedValue: 'low', recommendedDisposition: 'needs_clarification', reviewerSummary: 'Synthetic advisory summary.', facts: [], assumptions: [], unknowns: [], ruleEvaluation: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new GeminiAnalysisProvider(env)
    await expect(provider.analyze({ request: {} as never, clarificationAnswers: [] })).resolves.toMatchObject({ analysis: { normalizedTitle: 'Synthetic analysis' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const request = fetchMock.mock.calls[0]?.[0] as string
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(request).toContain('/v1beta/models/gemini-2.5-flash-lite:generateContent')
    expect(JSON.parse(String(options.body))).toMatchObject({ generationConfig: { responseMimeType: 'application/json', responseSchema: expect.any(Object) } })
    const schema = JSON.parse(String(options.body)).generationConfig.responseSchema
    expect(schema).toMatchObject({ type: 'object', properties: { currentProcess: { type: 'string', nullable: true } } })
    expect(JSON.stringify(schema)).not.toContain('$schema')
    expect(JSON.stringify(schema)).not.toContain('minLength')
    expect(JSON.stringify(schema)).not.toContain('additionalProperties')
  })

  it.each([[429, 'rate_limited'], [503, 'provider_unavailable']] as const)('classifies exhausted transient HTTP %i as %s', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
    const provider = new GeminiAnalysisProvider(env)
    await expect(provider.analyze({ request: {} as never, clarificationAnswers: [] })).rejects.toMatchObject<Partial<AnalysisProviderError>>({ code })
  })

  it('rejects a configured model other than the stable Gemini contract', () => {
    expect(() => new GeminiAnalysisProvider({ ...env, geminiModel: 'gemini-2.5-flash' })).toThrow('GEMINI_MODEL must be gemini-2.5-flash-lite')
  })

  it('does not call Gemini until the explicit public launch gate is approved', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const provider = new GeminiAnalysisProvider({ ...env, geminiPublicLaunchApproved: false })
    await expect(provider.analyze({ request: {} as never, clarificationAnswers: [] })).rejects.toMatchObject<Partial<AnalysisProviderError>>({ code: 'approval_required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
