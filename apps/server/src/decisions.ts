import type { AIRequestAnalysis, DecisionRecord, HumanDecision, RuleEvaluation } from '@ai-enablement/contracts'
import { assertTransition, type RequestStatus } from '@ai-enablement/domain'
import type { Database, DatabaseSession } from './database.js'

type DecisionRow = {
  id: string
  request_id: string
  reviewer_name: string
  decision: DecisionRecord['decision']
  rationale: string
  analysis_run_id: string
  previous_status: string
  next_status: string
  resulting_version: number
  created_at: Date | string
}

type ReviewRequestRow = { id: string; status: RequestStatus; version: number; request_type: string }
type ReviewAnalysisRow = {
  id: string
  system_recommendation: AIRequestAnalysis['recommendedDisposition']
  rule_evaluation: RuleEvaluation[] | string
  raw_structured_output: AIRequestAnalysis | string
}

export class DecisionRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message) }
}

function mapDecision(row: DecisionRow): DecisionRecord {
  return {
    id: row.id, requestId: row.request_id, reviewerName: row.reviewer_name, decision: row.decision,
    rationale: row.rationale, analysisRunId: row.analysis_run_id, expectedVersion: row.resulting_version - 1,
    previousStatus: row.previous_status, nextStatus: row.next_status, resultingVersion: Number(row.resulting_version),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

const targetStatuses: Record<HumanDecision['decision'], RequestStatus> = {
  approve_for_discovery: 'approved_for_discovery', defer: 'deferred', decline: 'declined', request_clarification: 'needs_clarification',
}

export async function listDecisions(database: Database, workspaceId: string, requestId: string): Promise<DecisionRecord[]> {
  const request = await database.query('select id from ai_requests where id = $1 and workspace_id = $2', [requestId, workspaceId])
  if (request.rows.length === 0) throw new DecisionRequestError(404, 'Request not found', 'request_not_found')
  const result = await database.query<DecisionRow>('select * from decisions where request_id = $1 order by created_at, id', [requestId])
  return result.rows.map(mapDecision)
}

export async function recordDecision(database: Database, workspaceId: string, requestId: string, submission: HumanDecision): Promise<DecisionRecord> {
  return database.transaction(async (transaction) => {
    const requestResult = await transaction.query<ReviewRequestRow>('select id, status, version, request_type from ai_requests where id = $1 and workspace_id = $2', [requestId, workspaceId])
    if (requestResult.rows.length === 0) throw new DecisionRequestError(404, 'Request not found', 'request_not_found')
    const request = requestResult.rows[0]
    if (request.version !== submission.expectedVersion) throw new DecisionRequestError(409, 'The request changed after this review was loaded. Refresh and review the latest evidence.', 'stale_request_version')

    const analysisResult = await transaction.query<ReviewAnalysisRow>("select id, system_recommendation, rule_evaluation, raw_structured_output from analysis_runs where request_id = $1 and outcome = 'success' order by created_at desc, id desc limit 1", [requestId])
    if (analysisResult.rows.length === 0) throw new DecisionRequestError(409, 'A successful analysis is required before a human decision.', 'analysis_required')
    const analysis = analysisResult.rows[0]
    if (analysis.id !== submission.analysisRunId) throw new DecisionRequestError(409, 'The reviewed analysis is no longer the latest successful analysis.', 'stale_analysis')

    const nextStatus = targetStatuses[submission.decision]
    try { assertTransition(request.status, nextStatus) }
    catch { throw new DecisionRequestError(409, `Illegal request status transition: ${request.status} -> ${nextStatus}`, 'illegal_transition') }

    if (submission.decision === 'approve_for_discovery') assertApprovalEligible(request, analysis)

    const updated = await transaction.query<{ version: number }>('update ai_requests set status = $3, version = version + 1, updated_at = now() where id = $1 and workspace_id = $4 and version = $2 returning version', [requestId, submission.expectedVersion, nextStatus, workspaceId])
    if (updated.rows.length === 0) throw new DecisionRequestError(409, 'Another reviewer recorded a decision first. Refresh before continuing.', 'concurrent_decision')
    const resultingVersion = Number(updated.rows[0].version)
    const inserted = await transaction.query<DecisionRow>(`insert into decisions (
      request_id, reviewer_name, decision, rationale, analysis_run_id, previous_status, next_status, resulting_version
    ) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [requestId, submission.reviewerName, submission.decision, submission.rationale, submission.analysisRunId, request.status, nextStatus, resultingVersion])
    const decision = mapDecision(inserted.rows[0])
    await insertHumanAudit(transaction, decision)
    return decision
  })
}

function assertApprovalEligible(request: ReviewRequestRow, row: ReviewAnalysisRow): void {
  const modelAnalysis = parseJson(row.raw_structured_output)
  const rules = parseJson(row.rule_evaluation)
  const privacyBlocked = rules.some((rule) => rule.rule === 'privacy_high_risk_gate' && rule.result === 'failed')
  const blockingQuestions = modelAnalysis.clarificationQuestions.some((question) => question.blocking)
  if (request.request_type !== 'ai_project') throw new DecisionRequestError(409, 'Tool-access requests cannot be approved for discovery.', 'approval_not_eligible')
  if (row.system_recommendation !== 'ready_for_discovery' || privacyBlocked || modelAnalysis.missingInformation.length > 0 || blockingQuestions) {
    throw new DecisionRequestError(409, 'This request is incomplete or blocked by deterministic governance rules.', 'approval_not_eligible')
  }
}

async function insertHumanAudit(database: DatabaseSession, decision: DecisionRecord): Promise<void> {
  await database.query(`insert into audit_events (request_id, actor_type, actor_name, event_type, description, metadata)
    values ($1,'human',$2,'human_decision_recorded',$3,$4::jsonb)`, [
    decision.requestId, decision.reviewerName, `${decision.reviewerName} recorded ${decision.decision.replaceAll('_', ' ')} with rationale.`,
    JSON.stringify({ decisionId: decision.id, analysisRunId: decision.analysisRunId, previousStatus: decision.previousStatus, nextStatus: decision.nextStatus, resultingVersion: decision.resultingVersion, rationale: decision.rationale }),
  ])
}
