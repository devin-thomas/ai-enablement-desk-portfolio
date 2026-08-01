import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recruiterDemoRequest } from './recruiterDemoApi'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  clear() { this.values.clear() }
}

describe('recruiter sandbox', () => {
  const storage = new MemoryStorage()

  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', storage)
  })

  it('supports the clarification and approval walkthrough in isolated browser state', async () => {
    const reset = await recruiterDemoRequest('/api/demo/reset', { method: 'POST' }) as { requests: Array<{ id: string }> }
    expect(reset.requests).toHaveLength(10)
    const requestId = reset.requests[0].id
    const first = await recruiterDemoRequest(`/api/requests/${requestId}/analyses`, { method: 'POST' }) as { analysisRun: { id: string; systemRecommendation: string } }
    expect(first.analysisRun.systemRecommendation).toBe('needs_clarification')

    await recruiterDemoRequest(`/api/requests/${requestId}/clarifications`, {
      method: 'POST',
      body: JSON.stringify({ questionId: 'CQ-HUMAN_VALIDATOR', answer: 'The reliability manager validates every summary.', actorType: 'human', actorName: 'Synthetic Reviewer' }),
    })
    const second = await recruiterDemoRequest(`/api/requests/${requestId}/analyses`, { method: 'POST' }) as { analysisRun: { id: string; systemRecommendation: string } }
    expect(second.analysisRun.systemRecommendation).toBe('ready_for_discovery')

    const detail = await recruiterDemoRequest(`/api/requests/${requestId}`) as { request: { version: number } }
    const result = await recruiterDemoRequest(`/api/requests/${requestId}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ reviewerName: 'Synthetic Reviewer', rationale: 'The bounded synthetic workflow has a named validator.', decision: 'approve_for_discovery', analysisRunId: second.analysisRun.id, expectedVersion: detail.request.version }),
    }) as { decision: { nextStatus: string } }
    expect(result.decision.nextStatus).toBe('approved_for_discovery')
  })

  it('keeps the high-risk employee scenario blocked from approval', async () => {
    const requestId = '10000000-0000-4000-8000-000000000003'
    await recruiterDemoRequest('/api/demo/reset', { method: 'POST' })
    const analyzed = await recruiterDemoRequest(`/api/requests/${requestId}/analyses`, { method: 'POST' }) as { analysisRun: { id: string; systemRecommendation: string } }
    const detail = await recruiterDemoRequest(`/api/requests/${requestId}`) as { request: { version: number } }
    expect(analyzed.analysisRun.systemRecommendation).toBe('decline')
    await expect(recruiterDemoRequest(`/api/requests/${requestId}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ reviewerName: 'Synthetic Reviewer', rationale: 'Attempting an approval should remain impossible.', decision: 'approve_for_discovery', analysisRunId: analyzed.analysisRun.id, expectedVersion: detail.request.version }),
    })).rejects.toThrow('prohibit approval')
  })
})
