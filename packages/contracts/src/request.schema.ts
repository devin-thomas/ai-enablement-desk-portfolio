import { z } from 'zod'

export const requestTypeSchema = z.enum(['ai_project', 'tool_access', 'support', 'training', 'unknown'])
export const requestStatusSchema = z.enum(['draft', 'submitted', 'analyzing', 'needs_clarification', 'ready_for_review', 'approved_for_discovery', 'poc_in_progress', 'completed', 'access_request', 'deferred', 'declined', 'analysis_failed', 'cancelled'])

export const requestSubmissionSchema = z.object({
  title: z.string().trim().min(5).max(120),
  requestType: requestTypeSchema,
  department: z.string().trim().min(1).max(120),
  requesterName: z.string().trim().min(1).max(120),
  requesterRole: z.string().trim().min(1).max(120),
  requestText: z.string().trim().min(20).max(6000).optional(),
  businessProblem: z.string().trim().min(20).max(4000),
  desiredOutcome: z.string().trim().min(5).max(2000),
  currentProcess: z.string().trim().max(2000).nullable(),
  intendedUsers: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  dataSources: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  syntheticDemoSafe: z.boolean().default(false),
})

export const requestRecordSchema = requestSubmissionSchema.extend({
  id: z.string().uuid(),
  status: requestStatusSchema,
  version: z.number().int().positive(),
  submittedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export type RequestSubmission = z.infer<typeof requestSubmissionSchema>
export type RequestRecord = z.infer<typeof requestRecordSchema>
