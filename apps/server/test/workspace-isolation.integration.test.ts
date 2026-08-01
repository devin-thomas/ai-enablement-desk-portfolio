import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp, type AppInstance } from '../src/app.js'
import type { AnalysisProvider } from '../src/analysisProvider.js'
import type { AudioProvider } from '../src/audio.js'
import { createMemoryDatabase } from '../src/database.js'
import type { ServerEnv } from '../src/config/env.js'
import { nativeFetch } from './browser.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', workspaceCookieSecret: 'test-workspace-secret',
  geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000, audioBriefingsEnabled: true,
}

const analysisProvider: AnalysisProvider = {
  name: 'stub-gemini', model: 'stub', schemaVersion: '1', promptVersion: '1',
  analyze: async () => ({ latencyMs: 1, analysis: {
    normalizedTitle: 'Synthetic workspace review', requestType: 'ai_project', businessProblem: 'Review synthetic workspace data.', desiredOutcome: 'Preserve isolated test evidence.',
    intendedUsers: ['Demo reviewers'], currentProcess: 'Manual review', dataSources: ['Synthetic records'], systemsToIntegrate: [], successMetrics: [], missingInformation: ['Named validator'],
    clarificationQuestions: [{ id: 'CQ-WORKSPACE', question: 'Who validates this workspace result?', targetField: 'validator', reason: 'A named validator is required.', priority: 1, blocking: true }], riskFlags: [],
    readinessScore: 100, estimatedValue: 'medium', recommendedDisposition: 'ready_for_discovery', reviewerSummary: 'Synthetic written summary.',
    facts: [{ value: 'Content is synthetic.', source: 'requester', confirmed: true }], assumptions: [], unknowns: [], ruleEvaluation: [],
  } satisfies AIRequestAnalysis }),
}

const audioProvider: AudioProvider = {
  name: 'fish-audio-stub', model: 'stub', generate: async () => ({ bytes: new Uint8Array([0x49, 0x44, 0x33]), mimeType: 'audio/mpeg', externalArtifactId: 'artifact-1' }),
}

const submission = {
  title: 'Synthetic workspace request', requestType: 'ai_project', department: 'Operations', requesterName: 'Demo Requester', requesterRole: 'Owner',
  businessProblem: 'A process owner needs a governed summary of synthetic records.', desiredOutcome: 'Provide an isolated reviewer summary.', currentProcess: 'Manual review.',
  intendedUsers: ['Demo reviewers'], dataSources: ['Synthetic records'], syntheticDemoSafe: true,
}

describe('anonymous workspace isolation', () => {
  let app: AppInstance
  let baseUrl: string

  beforeEach(async () => {
    app = await createApp({ database: createMemoryDatabase(), env, analysisProvider, audioProvider })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    await app.database.close()
  })

  it('isolates lifecycle data, reset, and forged cookies across browser workspaces', async () => {
    const createdA = await nativeFetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...submission, title: 'Workspace A' }) })
    const cookieA = cookieFrom(createdA)
    expect(createdA.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Max-Age=604800')
    expect(createdA.headers.get('set-cookie')).not.toContain('Secure')
    const createdBodyA = await createdA.json()
    const requestA = createdBodyA.request.id as string
    const automationA = createdBodyA.automationAttempt.id as string

    const createdB = await nativeFetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...submission, title: 'Workspace B' }) })
    const cookieB = cookieFrom(createdB)
    const requestB = (await createdB.json()).request.id as string

    expect(await requestJson('/api/requests', cookieA)).toMatchObject({ requests: [{ id: requestA }] })
    expect(await requestJson('/api/requests', cookieB)).toMatchObject({ requests: [{ id: requestB }] })
    expect((await requestJson(`/api/requests/${requestA}`, cookieB, { expectStatus: 404 })).error).toBe('Request not found')
    expect((await requestJson(`/api/requests/${requestA}/analyses`, cookieB, { method: 'POST', expectStatus: 404 })).code).toBe('request_not_found')

    const analysisA = (await requestJson(`/api/requests/${requestA}/analyses`, cookieA, { method: 'POST', expectStatus: 201 })).analysisRun
    const detailA = (await requestJson(`/api/requests/${requestA}`, cookieA)).request
    const clarification = { questionId: 'CQ-WORKSPACE', answer: 'A named synthetic reviewer validates it.', actorType: 'requester', actorName: 'Demo Requester' }
    expect((await requestJson(`/api/requests/${requestA}/clarifications`, cookieB, { method: 'POST', body: clarification, expectStatus: 404 })).code).toBe('request_not_found')
    expect((await requestJson(`/api/requests/${requestA}/decisions`, cookieB, { expectStatus: 404 })).code).toBe('request_not_found')
    expect((await requestJson(`/api/requests/${requestA}/decisions`, cookieB, { method: 'POST', body: {
      reviewerName: 'Hostile Reviewer', rationale: 'This cross-workspace decision must never be recorded.', decision: 'defer', analysisRunId: analysisA.id, expectedVersion: detailA.version,
    }, expectStatus: 404 })).code).toBe('request_not_found')
    expect((await requestJson(`/api/requests/${requestA}/audit-events`, cookieB, { expectStatus: 404 })).error).toBe('Request not found')
    expect((await requestJson(`/api/requests/${requestA}/automations`, cookieB, { expectStatus: 404 })).code).toBe('request_not_found')
    expect((await requestJson(`/api/requests/${requestA}/automations/${automationA}/retry`, cookieB, { method: 'POST', expectStatus: 404 })).code).toBe('attempt_not_found')
    expect((await requestJson(`/api/requests/${requestA}/automations`, cookieA)).automationAttempts).toHaveLength(1)

    const artifact = (await requestJson(`/api/requests/${requestA}/audio-briefings`, cookieA, { method: 'POST', expectStatus: 201 })).artifact
    expect((await requestJson(`/api/requests/${requestA}/artifacts`, cookieB)).artifacts).toEqual([])
    await requestJson(artifact.contentUrl, cookieB, { expectStatus: 404 })

    const resetA = await requestJson('/api/demo/reset', cookieA, { method: 'POST' })
    expect(resetA.requests).toHaveLength(10)
    expect((await requestJson('/api/requests', cookieB)).requests).toEqual([expect.objectContaining({ id: requestB })])

    const forgedCookie = 'aed_workspace=00000000-0000-4000-8000-000000000000.forged'
    const forged = await nativeFetch(`${baseUrl}/api/requests`, { headers: { cookie: forgedCookie } })
    expect(forged.status).toBe(200)
    expect(cookieFrom(forged)).not.toBe(forgedCookie)
    expect((await forged.json()).requests).toEqual([])
  })

  it('permits credentialed Vite development CORS only from known local origins', async () => {
    const allowed = await nativeFetch(`${baseUrl}/api/requests`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.headers.get('vary')).toBe('Origin')

    const denied = await nativeFetch(`${baseUrl}/api/requests`, { method: 'OPTIONS', headers: { origin: 'https://attacker.example' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(denied.headers.get('access-control-allow-credentials')).toBeNull()
  })

  async function requestJson(path: string, cookie: string, options: { method?: string; body?: unknown; expectStatus?: number } = {}): Promise<any> {
    const headers: Record<string, string> = { cookie }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await nativeFetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
    expect(response.status).toBe(options.expectStatus ?? 200)
    return response.json()
  }
})

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie')
  if (!cookie) throw new Error('Expected workspace cookie')
  return cookie.split(';')[0]
}
