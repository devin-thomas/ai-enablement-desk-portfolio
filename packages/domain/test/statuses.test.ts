import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition } from '../src/statuses'

describe('request status transitions', () => {
  it.each([
    ['ready_for_review', 'approved_for_discovery'],
    ['ready_for_review', 'deferred'],
    ['ready_for_review', 'declined'],
    ['ready_for_review', 'needs_clarification'],
  ] as const)('allows governed review transition %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })

  it('rejects a final status rewrite', () => {
    expect(() => assertTransition('approved_for_discovery', 'declined')).toThrow('Illegal request status transition')
  })
})
