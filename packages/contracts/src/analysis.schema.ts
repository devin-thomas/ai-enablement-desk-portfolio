import { z } from 'zod'
import { requestTypeSchema } from './request.schema'

export const riskFlagSchema = z.object({
  category: z.enum(['privacy', 'security', 'compliance', 'accuracy', 'ownership', 'cost', 'adoption']),
  severity: z.enum(['low', 'medium', 'high']),
  explanation: z.string().min(1),
})

export const evidenceItemSchema = z.object({
  value: z.string().min(1),
  source: z.enum(['requester', 'clarification', 'model_inference']),
  confirmed: z.boolean(),
})

export const clarificationQuestionSchema = z.object({
  id: z.string().regex(/^CQ-[A-Z0-9_-]+$/),
  question: z.string().min(1),
  targetField: z.string().min(1),
  reason: z.string().min(1),
  priority: z.number().int().min(1).max(5),
  blocking: z.boolean(),
})

export const ruleEvaluationSchema = z.object({
  rule: z.string().min(1),
  result: z.enum(['passed', 'failed', 'needs_review']),
  explanation: z.string().min(1),
})

export const analysisSchema = z.object({
  normalizedTitle: z.string().min(1),
  requestType: requestTypeSchema,
  businessProblem: z.string().min(1),
  desiredOutcome: z.string().min(1),
  intendedUsers: z.array(z.string()),
  currentProcess: z.string().nullable(),
  dataSources: z.array(z.string()),
  systemsToIntegrate: z.array(z.string()),
  successMetrics: z.array(z.string()),
  missingInformation: z.array(z.string()),
  clarificationQuestions: z.array(clarificationQuestionSchema),
  riskFlags: z.array(riskFlagSchema),
  readinessScore: z.number().int().min(0).max(100),
  estimatedValue: z.enum(['low', 'medium', 'high']),
  recommendedDisposition: z.enum(['needs_clarification', 'ready_for_discovery', 'tool_access_review', 'defer', 'decline']),
  reviewerSummary: z.string().min(1),
  facts: z.array(evidenceItemSchema).default([]),
  assumptions: z.array(evidenceItemSchema).default([]),
  unknowns: z.array(z.string()).default([]),
  ruleEvaluation: z.array(ruleEvaluationSchema).default([]),
})

export type AIRequestAnalysis = z.infer<typeof analysisSchema>
export type RuleEvaluation = z.infer<typeof ruleEvaluationSchema>

export const analysisOutcomeSchema = z.enum(['success', 'timeout', 'rate_limited', 'invalid_output', 'unavailable_key', 'approval_required', 'provider_unavailable', 'provider_error'])

export const analysisRunSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  provider: z.string().min(1),
  model: z.string().min(1),
  schemaVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  latencyMs: z.number().int().nonnegative(),
  outcome: analysisOutcomeSchema,
  sanitizedErrorCode: z.string().nullable(),
  modelAnalysis: analysisSchema.nullable(),
  modelRecommendation: analysisSchema.shape.recommendedDisposition.nullable(),
  systemRecommendation: analysisSchema.shape.recommendedDisposition.nullable(),
  ruleEvaluation: z.array(ruleEvaluationSchema),
  createdAt: z.string().datetime(),
})

export const clarificationAnswerSubmissionSchema = z.object({
  questionId: clarificationQuestionSchema.shape.id,
  answer: z.string().trim().min(2).max(2000),
  actorType: z.enum(['requester', 'human']),
  actorName: z.string().trim().min(1).max(120),
})

export const clarificationAnswerRecordSchema = clarificationAnswerSubmissionSchema.extend({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  question: z.string().min(1),
  createdAt: z.string().datetime(),
})

export type AnalysisRun = z.infer<typeof analysisRunSchema>
export type AnalysisOutcome = z.infer<typeof analysisOutcomeSchema>
export type ClarificationAnswerSubmission = z.infer<typeof clarificationAnswerSubmissionSchema>
export type ClarificationAnswerRecord = z.infer<typeof clarificationAnswerRecordSchema>
