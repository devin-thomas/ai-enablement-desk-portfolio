import { createHmac, randomUUID } from 'node:crypto'
import type { AutomationAttempt, AutomationName, AutomationStatus } from '@ai-enablement/contracts'
import type { ServerEnv } from './config/env.js'
import type { Database, DatabaseSession } from './database.js'

type AutomationRow = {
  id: string
  request_id: string
  automation_name: AutomationName
  workflow_version: string
  correlation_id: string
  idempotency_key: string
  attempt_number: number
  status: AutomationStatus
  started_at: Date | string
  completed_at: Date | string | null
  external_execution_id: string | null
  sanitized_error_code: string | null
  payload: Record<string, unknown> | string
}

type DispatchInput = {
  requestId: string
  automationName: Exclude<AutomationName, 'generate-audio-briefing'>
  idempotencyKey: string
  payload: Record<string, unknown>
}

export class AutomationDispatcher {
  constructor(private readonly database: Database, private readonly env: ServerEnv) {}

  async dispatch(input: DispatchInput, forceRetry = false): Promise<AutomationAttempt> {
    const existing = await this.latestByIdempotency(input.idempotencyKey)
    if (existing && !forceRetry) return mapAttempt(existing)
    const correlationId = existing?.correlation_id ?? randomUUID()
    let attemptNumber = (existing?.attempt_number ?? 0) + 1
    const maxAttempts = this.env.automationMaxAttempts ?? 3
    const webhookUrl = input.automationName === 'request-submitted' ? this.env.n8nRequestSubmittedWebhook : this.env.n8nDecisionRecordedWebhook
    const workflowVersion = input.automationName === 'request-submitted' ? this.env.n8nRequestWorkflowVersion ?? '1.0.0' : this.env.n8nDecisionWorkflowVersion ?? '1.0.0'

    if (!webhookUrl) return this.recordUnavailable(input, workflowVersion, correlationId, attemptNumber, 'disabled', 'webhook_disabled')
    if (!this.env.n8nWebhookSecret) return this.recordUnavailable(input, workflowVersion, correlationId, attemptNumber, 'unavailable', 'webhook_secret_missing')

    let finalAttempt: AutomationAttempt | null = null
    for (let offset = 0; offset < maxAttempts; offset += 1) {
      const row = await this.insertAttempt(input, workflowVersion, correlationId, attemptNumber, 'pending')
      const delivery = await this.deliver(webhookUrl, input, correlationId)
      const retryable = delivery.retryable && offset < maxAttempts - 1
      finalAttempt = await this.completeAttempt(row.id, retryable ? 'retrying' : delivery.success ? 'success' : 'failed', delivery.externalExecutionId, delivery.errorCode)
      if (!retryable) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, (this.env.automationRetryDelayMs ?? 250) * (offset + 1)))
      attemptNumber += 1
    }
    if (!finalAttempt) throw new Error('Automation dispatch produced no attempt record')
    await this.appendAudit(finalAttempt)
    return finalAttempt
  }

  async retry(workspaceId: string, requestId: string, attemptId: string): Promise<AutomationAttempt> {
    const result = await this.database.query<AutomationRow>('select automation_attempts.* from automation_attempts join ai_requests on ai_requests.id = automation_attempts.request_id where automation_attempts.id = $1 and automation_attempts.request_id = $2 and ai_requests.workspace_id = $3', [attemptId, requestId, workspaceId])
    if (result.rows.length === 0) throw new AutomationRequestError(404, 'Automation attempt not found', 'attempt_not_found')
    const row = result.rows[0]
    if (row.automation_name === 'generate-audio-briefing') throw new AutomationRequestError(409, 'Retry audio from the audio briefing action.', 'audio_retry_required')
    if (!['failed', 'retrying', 'disabled', 'unavailable'].includes(row.status)) throw new AutomationRequestError(409, `Automation cannot be retried from ${row.status}.`, 'retry_not_allowed')
    return this.dispatch({ requestId, automationName: row.automation_name, idempotencyKey: row.idempotency_key, payload: parsePayload(row.payload) }, true)
  }

  private async deliver(webhookUrl: string, input: DispatchInput, correlationId: string): Promise<{ success: boolean; retryable: boolean; externalExecutionId: string | null; errorCode: string | null }> {
    const body = JSON.stringify({ event: input.automationName, correlationId, idempotencyKey: input.idempotencyKey, workflowVersion: input.automationName === 'request-submitted' ? this.env.n8nRequestWorkflowVersion ?? '1.0.0' : this.env.n8nDecisionWorkflowVersion ?? '1.0.0', payload: input.payload })
    const signature = `sha256=${createHmac('sha256', this.env.n8nWebhookSecret!).update(body).digest('hex')}`
    let response: Response
    try {
      response = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aed-signature': signature, 'x-aed-correlation-id': correlationId, 'idempotency-key': input.idempotencyKey }, body, signal: AbortSignal.timeout(10_000) })
    } catch {
      return { success: false, retryable: true, externalExecutionId: null, errorCode: 'network_error' }
    }
    if (!response.ok) return { success: false, retryable: response.status === 429 || response.status >= 500, externalExecutionId: null, errorCode: `http_${response.status}` }
    const payload = await response.json().catch(() => null) as { externalExecutionId?: unknown } | null
    if (!payload || typeof payload.externalExecutionId !== 'string' || !payload.externalExecutionId) return { success: false, retryable: false, externalExecutionId: null, errorCode: 'invalid_execution_evidence' }
    return { success: true, retryable: false, externalExecutionId: payload.externalExecutionId, errorCode: null }
  }

  private async latestByIdempotency(idempotencyKey: string): Promise<AutomationRow | null> {
    const result = await this.database.query<AutomationRow>('select * from automation_attempts where idempotency_key = $1 order by attempt_number desc limit 1', [idempotencyKey])
    return result.rows[0] ?? null
  }

  private async insertAttempt(input: DispatchInput, workflowVersion: string, correlationId: string, attemptNumber: number, status: AutomationStatus): Promise<AutomationRow> {
    const result = await this.database.query<AutomationRow>(`insert into automation_attempts (
      request_id, automation_name, workflow_version, correlation_id, idempotency_key, attempt_number, status, payload
    ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) returning *`, [input.requestId, input.automationName, workflowVersion, correlationId, input.idempotencyKey, attemptNumber, status, JSON.stringify(input.payload)])
    return result.rows[0]
  }

  private async completeAttempt(id: string, status: AutomationStatus, externalExecutionId: string | null, errorCode: string | null): Promise<AutomationAttempt> {
    const result = await this.database.query<AutomationRow>('update automation_attempts set status = $2, completed_at = now(), external_execution_id = $3, sanitized_error_code = $4 where id = $1 returning *', [id, status, externalExecutionId, errorCode])
    return mapAttempt(result.rows[0])
  }

  private async recordUnavailable(input: DispatchInput, workflowVersion: string, correlationId: string, attemptNumber: number, status: 'disabled' | 'unavailable', code: string): Promise<AutomationAttempt> {
    const row = await this.insertAttempt(input, workflowVersion, correlationId, attemptNumber, status)
    const attempt = await this.completeAttempt(row.id, status, null, code)
    await this.appendAudit(attempt)
    return attempt
  }

  private async appendAudit(attempt: AutomationAttempt): Promise<void> {
    await this.database.query(`insert into audit_events (request_id, actor_type, actor_name, event_type, description, metadata)
      values ($1,'workflow','n8n automation',$2,$3,$4::jsonb)`, [
      attempt.requestId, 'automation_attempt_recorded', `${attempt.automationName} automation ${attempt.status}.`,
      JSON.stringify({ automationAttemptId: attempt.id, correlationId: attempt.correlationId, workflowVersion: attempt.workflowVersion, externalExecutionId: attempt.externalExecutionId, status: attempt.status }),
    ])
  }
}

export class AutomationRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message) }
}

function parsePayload(value: AutomationRow['payload']): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value
}

function mapAttempt(row: AutomationRow): AutomationAttempt {
  return {
    id: row.id, requestId: row.request_id, automationName: row.automation_name, workflowVersion: row.workflow_version,
    correlationId: row.correlation_id, idempotencyKey: row.idempotency_key, attemptNumber: Number(row.attempt_number), status: row.status,
    startedAt: new Date(row.started_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    externalExecutionId: row.external_execution_id, sanitizedErrorCode: row.sanitized_error_code,
  }
}

export async function listAutomations(database: Database, workspaceId: string, requestId: string): Promise<AutomationAttempt[]> {
  const request = await database.query('select id from ai_requests where id = $1 and workspace_id = $2', [requestId, workspaceId])
  if (request.rows.length === 0) throw new AutomationRequestError(404, 'Request not found', 'request_not_found')
  const result = await database.query<AutomationRow>('select * from automation_attempts where request_id = $1 order by started_at, id', [requestId])
  return result.rows.map(mapAttempt)
}

export async function insertAutomationAttempt(database: DatabaseSession, values: { requestId: string; automationName: AutomationName; workflowVersion: string; correlationId: string; idempotencyKey: string; status: AutomationStatus; externalExecutionId?: string | null; errorCode?: string | null; payload?: Record<string, unknown> }): Promise<AutomationAttempt> {
  const result = await database.query<AutomationRow>(`insert into automation_attempts (
    request_id, automation_name, workflow_version, correlation_id, idempotency_key, attempt_number, status, completed_at, external_execution_id, sanitized_error_code, payload
  ) values ($1,$2,$3,$4,$5,1,$6,now(),$7,$8,$9::jsonb) returning *`, [values.requestId, values.automationName, values.workflowVersion, values.correlationId, values.idempotencyKey, values.status, values.externalExecutionId ?? null, values.errorCode ?? null, JSON.stringify(values.payload ?? {})])
  return mapAttempt(result.rows[0])
}
