import { z } from 'zod'

export const automationStatusSchema = z.enum(['pending', 'retrying', 'success', 'failed', 'disabled', 'unavailable'])
export const automationNameSchema = z.enum(['request-submitted', 'request-decision-recorded', 'generate-audio-briefing'])

export const automationAttemptSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  automationName: automationNameSchema,
  workflowVersion: z.string().min(1),
  correlationId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  status: automationStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  externalExecutionId: z.string().nullable(),
  sanitizedErrorCode: z.string().nullable(),
})

export const artifactSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  artifactType: z.literal('audio_briefing'),
  provider: z.string().min(1),
  status: z.literal('success'),
  mimeType: z.string().startsWith('audio/'),
  byteLength: z.number().int().positive(),
  externalArtifactId: z.string().nullable(),
  sourceAnalysisRunId: z.string().uuid(),
  createdAt: z.string().datetime(),
  contentUrl: z.string().min(1),
})

export type AutomationAttempt = z.infer<typeof automationAttemptSchema>
export type AutomationName = z.infer<typeof automationNameSchema>
export type AutomationStatus = z.infer<typeof automationStatusSchema>
export type ArtifactRecord = z.infer<typeof artifactSchema>
