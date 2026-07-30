import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp, type AppInstance } from '../src/app.js'
import type { AnalysisProvider } from '../src/analysisProvider.js'
import type { AudioProvider } from '../src/audio.js'
import { createMemoryDatabase } from '../src/database.js'
import type { ServerEnv } from '../src/config/env.js'

const analysisProvider: AnalysisProvider = {
  name: 'stub-gemini', model: 'stub', schemaVersion: '1', promptVersion: '1',
  analyze: async () => ({ latencyMs: 4, analysis: {
    normalizedTitle: 'Synthetic audio review', requestType: 'ai_project', businessProblem: 'Review synthetic records.', desiredOutcome: 'Human review.',
    intendedUsers: ['Reviewers'], currentProcess: 'Manual review', dataSources: ['Synthetic records'], systemsToIntegrate: [], successMetrics: [], missingInformation: [], clarificationQuestions: [], riskFlags: [],
    readinessScore: 100, estimatedValue: 'medium', recommendedDisposition: 'ready_for_discovery', reviewerSummary: 'This written synthetic reviewer summary remains authoritative.',
    facts: [{ value: 'Content is synthetic.', source: 'requester', confirmed: true }], assumptions: [], unknowns: [], ruleEvaluation: [],
  } satisfies AIRequestAnalysis }),
}

describe('optional audio briefing', () => {
  let app: AppInstance
  let baseUrl: string
  let audioProvider: AudioProvider

  beforeEach(async () => {
    audioProvider = { name: 'fish-audio-stub', model: 'stub-model', generate: async () => ({ bytes: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mimeType: 'audio/mpeg', externalArtifactId: 'fish-artifact-1' }) }
  })

  afterEach(async () => {
    if (app) {
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
      await app.database.close()
    }
  })

  async function start(enabled: boolean) {
    const env: ServerEnv = { nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000, audioBriefingsEnabled: enabled }
    app = await createApp({ database: createMemoryDatabase(), env, analysisProvider, audioProvider })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  }

  async function createAndAnalyze(syntheticDemoSafe = true) {
    const created = await (await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: 'Synthetic audio request', requestType: 'ai_project', department: 'Operations', requesterName: 'Demo Requester', requesterRole: 'Owner',
      businessProblem: 'A process owner needs a reviewer summary for synthetic operational records.', desiredOutcome: 'Provide a text-first review.', currentProcess: 'Manual review.',
      intendedUsers: ['Demo reviewers'], dataSources: ['Synthetic records'], syntheticDemoSafe,
    }) })).json()
    await fetch(`${baseUrl}/api/requests/${created.request.id}/analyses`, { method: 'POST' })
    return created.request.id as string
  }

  it('persists and serves an artifact only when real audio bytes are returned', async () => {
    await start(true)
    const requestId = await createAndAnalyze()
    const response = await fetch(`${baseUrl}/api/requests/${requestId}/audio-briefings`, { method: 'POST' })
    expect(response.status).toBe(201)
    const artifact = (await response.json()).artifact
    expect(artifact).toMatchObject({ status: 'success', mimeType: 'audio/mpeg', byteLength: 10, externalArtifactId: 'fish-artifact-1' })
    const content = await fetch(`${baseUrl}${artifact.contentUrl}`)
    expect(content.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]))
  })

  it('does not create an artifact when audio is disabled or invalid', async () => {
    await start(false)
    const requestId = await createAndAnalyze()
    expect((await fetch(`${baseUrl}/api/requests/${requestId}/audio-briefings`, { method: 'POST' })).status).toBe(409)
    expect((await (await fetch(`${baseUrl}/api/requests/${requestId}/artifacts`)).json()).artifacts).toHaveLength(0)
    await new Promise<void>((resolve) => app.server.close(() => resolve())); await app.database.close(); app = undefined as never

    audioProvider = { name: 'fish-audio-stub', model: 'stub', generate: async () => ({ bytes: new Uint8Array(), mimeType: 'audio/mpeg', externalArtifactId: null }) }
    await start(true)
    const invalidId = await createAndAnalyze()
    expect((await fetch(`${baseUrl}/api/requests/${invalidId}/audio-briefings`, { method: 'POST' })).status).toBe(502)
    expect((await (await fetch(`${baseUrl}/api/requests/${invalidId}/artifacts`)).json()).artifacts).toHaveLength(0)
  })

  it('prohibits audio for requests not explicitly marked synthetic demo-safe', async () => {
    await start(true)
    const requestId = await createAndAnalyze(false)
    const response = await fetch(`${baseUrl}/api/requests/${requestId}/audio-briefings`, { method: 'POST' })
    expect(response.status).toBe(403)
    expect((await (await fetch(`${baseUrl}/api/requests/${requestId}/artifacts`)).json()).artifacts).toHaveLength(0)
  })
})
