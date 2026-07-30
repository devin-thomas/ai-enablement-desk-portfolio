import { describe, expect, it } from 'vitest'
import { recommendRoute } from '../src/routing'

describe('deterministic routing', () => {
  it('overrides readiness when high-risk privacy evidence exists', () => {
    expect(recommendRoute({ requestType: 'ai_project', missingInformation: [], readinessScore: 100, riskFlags: [
      { category: 'privacy', severity: 'high', explanation: 'Synthetic workforce data.' },
    ] })).toBe('decline')
  })

  it('keeps incomplete requests in clarification', () => {
    expect(recommendRoute({ requestType: 'ai_project', missingInformation: ['Human validator'], readinessScore: 80, riskFlags: [] })).toBe('needs_clarification')
  })
})
