import {
  analysisSchema,
  type AIRequestAnalysis,
  type AnalysisOutcome,
  type AnalysisRun,
  type ClarificationAnswerRecord,
  type ClarificationAnswerSubmission,
  type RequestRecord,
  type RuleEvaluation,
} from '@ai-enablement/contracts'
import { assessRisk, calculateReadiness, recommendRoute } from '@ai-enablement/domain'
import type { AnalysisProvider } from './analysisProvider.js'
import { AnalysisProviderError } from './analysisProvider.js'
import type { Database, DatabaseSession } from './database.js'
import { getRequest } from './requests.js'

type AnalysisRow = {
  id: string
  request_id: string
  provider: string
  model: string
  schema_version: string
  prompt_version: string
  latency_ms: number
  outcome: AnalysisOutcome
  sanitized_error_code: string | null
  raw_structured_output: unknown | null
  model_recommendation: AnalysisRun['modelRecommendation']
  system_recommendation: AnalysisRun['systemRecommendation']
  rule_evaluation: unknown
  created_at: Date | string
}

type ClarificationRow = {
  id: string
  request_id: string
  question_id: string
  question: string
  answer: string
  actor_type: ClarificationAnswerRecord['actorType']
  actor_name: string
  created_at: Date | string
}

export class AnalysisRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly analysisRun?: AnalysisRun) {
    super(message)
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function mapAnalysis(row: AnalysisRow): AnalysisRun {
  const raw = jsonValue(row.raw_structured_output)
  const modelAnalysis = raw ? analysisSchema.parse(raw) : null
  const ruleEvaluation = jsonValue(row.rule_evaluation)
  return {
    id: row.id,
    requestId: row.request_id,
    provider: row.provider,
    model: row.model,
    schemaVersion: row.schema_version,
    promptVersion: row.prompt_version,
    latencyMs: Number(row.latency_ms),
    outcome: row.outcome,
    sanitizedErrorCode: row.sanitized_error_code,
    modelAnalysis,
    modelRecommendation: row.model_recommendation,
    systemRecommendation: row.system_recommendation,
    ruleEvaluation: Array.isArray(ruleEvaluation) ? ruleEvaluation as RuleEvaluation[] : [],
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function mapClarification(row: ClarificationRow): ClarificationAnswerRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    questionId: row.question_id,
    question: row.question,
    answer: row.answer,
    actorType: row.actor_type,
    actorName: row.actor_name,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export async function listAnalyses(database: Database, workspaceId: string, requestId: string): Promise<{ analyses: AnalysisRun[]; clarificationAnswers: ClarificationAnswerRecord[] }> {
  if (!await getRequest(database, workspaceId, requestId)) throw new AnalysisRequestError(404, 'Request not found', 'request_not_found')
  const [analyses, clarifications] = await Promise.all([
    database.query<AnalysisRow>('select * from analysis_runs where request_id = $1 order by created_at desc, id desc', [requestId]),
    database.query<ClarificationRow>('select * from clarification_answers where request_id = $1 order by created_at, id', [requestId]),
  ])
  return { analyses: analyses.rows.map(mapAnalysis), clarificationAnswers: clarifications.rows.map(mapClarification) }
}

export async function runAnalysis(database: Database, provider: AnalysisProvider, workspaceId: string, requestId: string): Promise<AnalysisRun> {
  const detail = await getRequest(database, workspaceId, requestId)
  if (!detail) throw new AnalysisRequestError(404, 'Request not found', 'request_not_found')
  if (!['submitted', 'needs_clarification', 'analysis_failed'].includes(detail.status)) {
    throw new AnalysisRequestError(409, `Request cannot be analyzed from status ${detail.status}.`, 'analysis_not_allowed')
  }
  const clarificationAnswers = (await listAnalyses(database, workspaceId, requestId)).clarificationAnswers

  try {
    const providerResult = await provider.analyze({ request: detail, clarificationAnswers })
    validateEvidenceSemantics(providerResult.analysis)
    const deterministic = evaluateDeterministicRules(detail, providerResult.analysis, clarificationAnswers)
    return database.transaction(async (transaction) => {
      const run = await insertSuccessfulRun(transaction, provider, detail, providerResult.analysis, providerResult.latencyMs, deterministic)
      const hasPrivacyGate = deterministic.ruleEvaluation.some((rule) => rule.rule === 'privacy_high_risk_gate' && rule.result === 'failed')
      const nextStatus = hasPrivacyGate || deterministic.systemRecommendation === 'needs_clarification' ? 'needs_clarification' : 'ready_for_review'
      await transaction.query('update ai_requests set status = $2, version = version + 1, updated_at = now() where id = $1', [requestId, nextStatus])
      await insertAudit(transaction, requestId, 'ai', `${provider.name}/${provider.model}`, 'analysis_completed', 'Advisory model analysis completed and passed the shared contract.', { analysisRunId: run.id, modelRecommendation: run.modelRecommendation })
      await insertAudit(transaction, requestId, 'system', 'Deterministic routing rules', 'routing_evaluated', `System recommendation: ${run.systemRecommendation}.`, { analysisRunId: run.id, ruleEvaluation: run.ruleEvaluation })
      return run
    })
  } catch (error) {
    const providerError = error instanceof AnalysisProviderError ? error : new AnalysisProviderError('invalid_output', 'Analysis output failed validation.', 0)
    const failed = await database.transaction(async (transaction) => {
      const run = await insertFailedRun(transaction, provider, requestId, providerError)
      await transaction.query("update ai_requests set status = 'analysis_failed', version = version + 1, updated_at = now() where id = $1", [requestId])
      await insertAudit(transaction, requestId, 'system', 'Analysis service', 'analysis_failed', `Analysis failed with retryable state ${providerError.code}.`, { analysisRunId: run.id, errorCode: providerError.code })
      return run
    })
    const status = providerError.code === 'unavailable_key' ? 503 : providerError.code === 'rate_limited' ? 429 : 502
    throw new AnalysisRequestError(status, providerError.message, providerError.code, failed)
  }
}

function validateEvidenceSemantics(analysis: AIRequestAnalysis): void {
  const invalidFact = analysis.facts.some((item) => item.source === 'model_inference' || !item.confirmed)
  const invalidAssumption = analysis.assumptions.some((item) => item.source !== 'model_inference' || item.confirmed)
  if (invalidFact || invalidAssumption) throw new AnalysisProviderError('invalid_output', 'Evidence provenance failed semantic validation.', 0)
}

function evaluateDeterministicRules(request: RequestRecord, analysis: AIRequestAnalysis, answers: ClarificationAnswerRecord[]): { systemRecommendation: AIRequestAnalysis['recommendedDisposition']; riskFlags: AIRequestAnalysis['riskFlags']; readinessScore: number; ruleEvaluation: RuleEvaluation[] } {
  const answerText = answers.map((answer) => `${answer.question} ${answer.answer}`).join(' ').toLowerCase()
  const deterministicRisk = assessRisk(request).filter((flag) => !(flag.category === 'accuracy' && /human|validator|review/.test(answerText)))
  const riskFlags = [...analysis.riskFlags]
  for (const flag of deterministicRisk) {
    if (!riskFlags.some((current) => current.category === flag.category && current.severity === flag.severity)) riskFlags.push(flag)
  }
  const readinessScore = calculateReadiness({
    hasOutcome: Boolean(request.desiredOutcome), hasDataSource: request.dataSources.length > 0,
    hasOwner: Boolean(request.currentProcess), hasMetric: /metric|measure|success/.test(answerText),
    hasHumanValidator: /human|validator|review/.test(answerText),
  })
  const systemRecommendation = recommendRoute({ requestType: request.requestType, missingInformation: analysis.missingInformation, riskFlags, readinessScore })
  const privacyBlocked = riskFlags.some((flag) => flag.category === 'privacy' && flag.severity === 'high')
  const ruleEvaluation: RuleEvaluation[] = [
    { rule: 'privacy_high_risk_gate', result: privacyBlocked ? 'failed' : 'passed', explanation: privacyBlocked ? 'High-risk privacy input requires human governance and cannot become approval-ready.' : 'No deterministic high-risk privacy signal was found.' },
    { rule: 'readiness_calculation', result: readinessScore >= 60 ? 'passed' : 'needs_review', explanation: `Deterministic readiness is ${readinessScore}; model readiness is advisory only.` },
    { rule: 'deterministic_routing', result: systemRecommendation === analysis.recommendedDisposition ? 'passed' : 'needs_review', explanation: systemRecommendation === analysis.recommendedDisposition ? 'Model suggestion is compatible with deterministic routing.' : `System override: ${analysis.recommendedDisposition} -> ${systemRecommendation}.` },
  ]
  return { systemRecommendation, riskFlags, readinessScore, ruleEvaluation }
}

async function insertSuccessfulRun(database: DatabaseSession, provider: AnalysisProvider, request: RequestRecord, analysis: AIRequestAnalysis, latencyMs: number, deterministic: ReturnType<typeof evaluateDeterministicRules>): Promise<AnalysisRun> {
  const result = await database.query<AnalysisRow>(`insert into analysis_runs (
    request_id, provider, model, schema_version, prompt_version, latency_ms, outcome, summary, readiness_score,
    estimated_value, risk_level, recommended_disposition, missing_information, risk_flags, raw_structured_output,
    model_recommendation, system_recommendation, rule_evaluation, facts, assumptions, unknowns, clarification_questions
  ) values ($1,$2,$3,$4,$5,$6,'success',$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb)
  returning *`, [
    request.id, provider.name, provider.model, provider.schemaVersion, provider.promptVersion, latencyMs,
    analysis.reviewerSummary, deterministic.readinessScore, analysis.estimatedValue,
    deterministic.riskFlags.some((flag) => flag.severity === 'high') ? 'high' : deterministic.riskFlags.some((flag) => flag.severity === 'medium') ? 'medium' : 'low',
    deterministic.systemRecommendation, JSON.stringify(analysis.missingInformation), JSON.stringify(deterministic.riskFlags), JSON.stringify(analysis),
    analysis.recommendedDisposition, deterministic.systemRecommendation, JSON.stringify(deterministic.ruleEvaluation),
    JSON.stringify(analysis.facts), JSON.stringify(analysis.assumptions), JSON.stringify(analysis.unknowns), JSON.stringify(analysis.clarificationQuestions),
  ])
  return mapAnalysis(result.rows[0])
}

async function insertFailedRun(database: DatabaseSession, provider: AnalysisProvider, requestId: string, error: AnalysisProviderError): Promise<AnalysisRun> {
  const result = await database.query<AnalysisRow>(`insert into analysis_runs (
    request_id, provider, model, schema_version, prompt_version, latency_ms, outcome, sanitized_error_code
  ) values ($1,$2,$3,$4,$5,$6,$7,$7) returning *`, [requestId, provider.name, provider.model, provider.schemaVersion, provider.promptVersion, error.latencyMs, error.code])
  return mapAnalysis(result.rows[0])
}

async function insertAudit(database: DatabaseSession, requestId: string, actorType: string, actorName: string, eventType: string, description: string, metadata: Record<string, unknown>): Promise<void> {
  await database.query(`insert into audit_events (request_id, actor_type, actor_name, event_type, description, metadata)
    values ($1,$2,$3,$4,$5,$6::jsonb)`, [requestId, actorType, actorName, eventType, description, JSON.stringify(metadata)])
}

export async function answerClarification(database: Database, workspaceId: string, requestId: string, submission: ClarificationAnswerSubmission): Promise<ClarificationAnswerRecord> {
  const history = await listAnalyses(database, workspaceId, requestId)
  const question = history.analyses.flatMap((run) => run.modelAnalysis?.clarificationQuestions ?? []).find((item) => item.id === submission.questionId)
  if (!question) throw new AnalysisRequestError(404, 'Clarification question not found', 'clarification_not_found')
  return database.transaction(async (transaction) => {
    const result = await transaction.query<ClarificationRow>(`insert into clarification_answers (
      request_id, question_id, question, answer, actor_type, actor_name
    ) values ($1,$2,$3,$4,$5,$6) returning *`, [requestId, submission.questionId, question.question, submission.answer, submission.actorType, submission.actorName])
    const answer = mapClarification(result.rows[0])
    await transaction.query('update ai_requests set version = version + 1, updated_at = now() where id = $1', [requestId])
    await insertAudit(transaction, requestId, submission.actorType, submission.actorName, 'clarification_answered', `Clarification ${submission.questionId} was answered.`, { clarificationAnswerId: answer.id, questionId: submission.questionId })
    return answer
  })
}
