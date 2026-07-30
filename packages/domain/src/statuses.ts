import type { z } from 'zod'
import type { requestStatusSchema } from '@ai-enablement/contracts'

export type RequestStatus = z.infer<typeof requestStatusSchema>

const transitions: Record<RequestStatus, RequestStatus[]> = {
  draft: ['submitted'],
  submitted: ['analyzing', 'access_request'],
  analyzing: ['needs_clarification', 'ready_for_review', 'analysis_failed'],
  needs_clarification: ['analyzing', 'deferred'],
  ready_for_review: ['approved_for_discovery', 'needs_clarification', 'deferred', 'declined'],
  approved_for_discovery: ['poc_in_progress', 'cancelled'],
  poc_in_progress: ['completed', 'cancelled'],
  completed: [],
  access_request: ['ready_for_review', 'deferred', 'declined'],
  deferred: ['submitted', 'cancelled'],
  declined: [],
  analysis_failed: ['analyzing', 'cancelled'],
  cancelled: [],
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return transitions[from].includes(to)
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal request status transition: ${from} -> ${to}`)
}
