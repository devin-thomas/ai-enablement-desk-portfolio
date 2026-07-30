import { z } from 'zod'

export const decisionSchema = z.object({
  reviewerName: z.string().trim().min(1).max(120),
  decision: z.enum(['approve_for_discovery', 'defer', 'decline', 'request_clarification']),
  rationale: z.string().trim().min(10).max(4000),
  analysisRunId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
})

export type HumanDecision = z.infer<typeof decisionSchema>

export const decisionRecordSchema = decisionSchema.extend({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  previousStatus: z.string().min(1),
  nextStatus: z.string().min(1),
  resultingVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
})

export type DecisionRecord = z.infer<typeof decisionRecordSchema>
