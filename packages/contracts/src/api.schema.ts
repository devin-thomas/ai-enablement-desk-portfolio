import { z } from 'zod'
import { analysisSchema } from './analysis.schema'
import { analysisRunSchema, clarificationAnswerRecordSchema } from './analysis.schema'
import { auditEventSchema } from './audit.schema'
import { auditEventRecordSchema } from './audit.schema'
import { requestRecordSchema } from './request.schema'
import { decisionRecordSchema } from './decision.schema'
import { artifactSchema, automationAttemptSchema } from './automation.schema'

export const requestDetailSchema = requestRecordSchema.extend({
  auditEvents: z.array(auditEventRecordSchema),
})

export const requestListResponseSchema = z.object({ requests: z.array(requestRecordSchema) })
export const requestDetailResponseSchema = z.object({ request: requestDetailSchema })
export const requestCreateResponseSchema = requestDetailResponseSchema

export type RequestDetail = z.infer<typeof requestDetailSchema>

export const analysisListResponseSchema = z.object({
  analyses: z.array(analysisRunSchema),
  clarificationAnswers: z.array(clarificationAnswerRecordSchema),
})

export const analysisRunResponseSchema = z.object({ analysisRun: analysisRunSchema })
export const clarificationAnswerResponseSchema = z.object({ clarificationAnswer: clarificationAnswerRecordSchema })
export const decisionResponseSchema = z.object({ decision: decisionRecordSchema })
export const decisionListResponseSchema = z.object({ decisions: z.array(decisionRecordSchema) })
export const auditEventListResponseSchema = z.object({ auditEvents: z.array(auditEventRecordSchema) })
export const automationAttemptResponseSchema = z.object({ automationAttempt: automationAttemptSchema })
export const automationListResponseSchema = z.object({ automationAttempts: z.array(automationAttemptSchema) })
export const artifactResponseSchema = z.object({ artifact: artifactSchema })
export const artifactListResponseSchema = z.object({ artifacts: z.array(artifactSchema) })

export const analysisResponseSchema = z.object({
  requestId: z.string(),
  analysis: analysisSchema,
  auditEvent: auditEventSchema,
})

export type AnalysisResponse = z.infer<typeof analysisResponseSchema>
