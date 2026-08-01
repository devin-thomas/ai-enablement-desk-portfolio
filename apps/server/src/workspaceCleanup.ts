import { randomUUID } from 'node:crypto'
import type { Database, DatabaseSession } from './database.js'

const cleanupAdvisoryLock = 884_210_041

type CleanupCounts = { workspaces: number; requests: number; analyses: number; clarifications: number; decisions: number; auditEvents: number; automationAttempts: number; artifacts: number; artifactBytes: number }

export type WorkspaceCleanupResult = { outcome: 'cleanup_completed' | 'cleanup_skipped'; cutoff: string | null; counts: CleanupCounts; durationMs: number; executionId: string }

export type CleanupLogger = (event: WorkspaceCleanupResult) => void

const emptyCounts = (): CleanupCounts => ({ workspaces: 0, requests: 0, analyses: 0, clarifications: 0, decisions: 0, auditEvents: 0, automationAttempts: 0, artifacts: 0, artifactBytes: 0 })

export async function expireInactiveWorkspaces(database: Database, log: CleanupLogger = (event) => console.log(JSON.stringify(event)), executionId = randomUUID()): Promise<WorkspaceCleanupResult> {
  const startedAt = performance.now()
  const transactionResult = await database.transaction(async (transaction) => {
    const lock = await transaction.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock($1) as acquired', [cleanupAdvisoryLock])
    if (!lock.rows[0]?.acquired) return { skipped: true as const, cutoff: null, counts: emptyCounts() }

    const cutoff = await transaction.query<{ cutoff: Date | string }>("select transaction_timestamp() - interval '7 days' as cutoff")
    const cutoffValue = new Date(cutoff.rows[0].cutoff).toISOString()
    await transaction.query('delete from workspace_activity_leases where expires_at <= transaction_timestamp()')
    const candidates = await transaction.query<{ id: string }>(
      "select id from workspaces where not is_quarantine and last_activity_at <= transaction_timestamp() - interval '7 days' and not exists (select 1 from workspace_activity_leases where workspace_id = workspaces.id) order by last_activity_at, id for update skip locked"
    )
    if (candidates.rows.length === 0) return { skipped: false as const, cutoff: cutoffValue, counts: emptyCounts() }

    const ids = candidates.rows.map((row) => row.id)
    const counts = await aggregateCounts(transaction, ids)
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ')
    const deleted = await transaction.query<{ id: string }>(`delete from workspaces where id in (${placeholders}) returning id`, ids)
    if (deleted.rowCount !== ids.length) throw new Error('Workspace cleanup deleted an unexpected number of roots')
    return { skipped: false as const, cutoff: cutoffValue, counts }
  })

  const event: WorkspaceCleanupResult = { outcome: transactionResult.skipped ? 'cleanup_skipped' : 'cleanup_completed', cutoff: transactionResult.cutoff, counts: transactionResult.counts, durationMs: Math.round(performance.now() - startedAt), executionId }
  log(event)
  return event
}

async function aggregateCounts(database: DatabaseSession, workspaceIds: string[]): Promise<CleanupCounts> {
  const placeholders = workspaceIds.map((_, index) => `$${index + 1}`).join(', ')
  const result = await database.query<CleanupCounts>(
    `select
    (select count(*)::int from workspaces where id in (${placeholders})) as workspaces,
    (select count(*)::int from ai_requests where workspace_id in (${placeholders})) as requests,
    (select count(*)::int from analysis_runs join ai_requests on ai_requests.id = analysis_runs.request_id where ai_requests.workspace_id in (${placeholders})) as analyses,
    (select count(*)::int from clarification_answers join ai_requests on ai_requests.id = clarification_answers.request_id where ai_requests.workspace_id in (${placeholders})) as clarifications,
    (select count(*)::int from decisions join ai_requests on ai_requests.id = decisions.request_id where ai_requests.workspace_id in (${placeholders})) as decisions,
    (select count(*)::int from audit_events join ai_requests on ai_requests.id = audit_events.request_id where ai_requests.workspace_id in (${placeholders})) as "auditEvents",
    (select count(*)::int from automation_attempts join ai_requests on ai_requests.id = automation_attempts.request_id where ai_requests.workspace_id in (${placeholders})) as "automationAttempts",
    (select count(*)::int from artifacts join ai_requests on ai_requests.id = artifacts.request_id where ai_requests.workspace_id in (${placeholders})) as artifacts,
    (select coalesce(sum(coalesce(artifacts.byte_length, octet_length(artifacts.artifact_data))), 0)::int from artifacts join ai_requests on ai_requests.id = artifacts.request_id where ai_requests.workspace_id in (${placeholders})) as "artifactBytes"`,
    workspaceIds
  )
  const counts = result.rows[0]
  if (!counts) throw new Error('Workspace cleanup could not aggregate candidates')
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])) as CleanupCounts
}
