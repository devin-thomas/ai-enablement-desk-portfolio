import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiAnalysisProvider, AnalysisProviderError } from '../src/analysisProvider.js'
import type { ServerEnv } from '../src/config/env.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', geminiApiKey: 'synthetic-test-key',
  geminiModel: 'stub-model', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
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
})
