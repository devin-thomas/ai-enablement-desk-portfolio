import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryDatabase, type Database, type DatabaseSession } from '../src/database.js'
import { migrate } from '../src/migrations.js'
import { expireInactiveWorkspaces } from '../src/workspaceCleanup.js'

describe('workspace expiry cleanup', () => {
  let database: Database

  beforeEach(async () => {
    database = createMemoryDatabase()
    await migrate(database)
  })

  afterEach(async () => database.close())

  it('treats the exact database-time seven-day boundary as expired', async () => {
    const boundary = '10000000-0000-4000-8000-000000000000'
    await database.transaction(async (transaction) => {
      await transaction.query("insert into workspaces (id, last_activity_at) values ($1, transaction_timestamp() - interval '7 days')", [boundary])
      const eligible = await transaction.query("select id from workspaces where id = $1 and last_activity_at <= transaction_timestamp() - interval '7 days'", [boundary])
      expect(eligible.rows).toHaveLength(1)
    })
  })

  it('deletes expired roots with every cascade, preserves active and quarantine roots, and logs aggregates only', async () => {
    const expired = '10000000-0000-4000-8000-000000000001'
    const active = '10000000-0000-4000-8000-000000000002'
    await database.query("insert into workspaces (id, last_activity_at) values ($1, transaction_timestamp() - interval '7 days')", [expired])
    await database.query('insert into workspaces (id) values ($1)', [active])
    const request = await database.query<{ id: string }>(
      `insert into ai_requests (title, raw_request, request_type, department, requester_name, requester_role, business_problem, desired_outcome, workspace_id)
      values ('Expired', '{}'::jsonb, 'ai_project', 'Ops', 'Synthetic', 'Owner', 'Test', 'Test', $1) returning id`,
      [expired]
    )
    const requestId = request.rows[0].id
    await database.query("insert into analysis_runs (request_id, provider, model, schema_version) values ($1, 'test', 'test', '1')", [requestId])
    await database.query("insert into clarification_answers (request_id, question_id, question, answer, actor_type, actor_name) values ($1, 'q', 'q', 'a', 'requester', 'Synthetic')", [requestId])
    await database.query("insert into decisions (request_id, reviewer_name, decision, rationale) values ($1, 'Synthetic', 'defer', 'Test')", [requestId])
    await database.query("insert into audit_events (request_id, actor_type, actor_name, event_type, description) values ($1, 'system', 'Synthetic', 'test', 'Test')", [requestId])
    await database.query("insert into automation_attempts (request_id, automation_name, workflow_version, correlation_id, idempotency_key, attempt_number, status) values ($1, 'request-submitted', '1', gen_random_uuid(), 'test', 1, 'success')", [requestId])
    await database.query("insert into artifacts (request_id, artifact_type, status, artifact_data, byte_length) values ($1, 'audio', 'success', decode('010203', 'hex'), 3)", [requestId])

    const events: unknown[] = []
    const result = await expireInactiveWorkspaces(database, (event) => events.push(event), 'execution-test')

    expect(result).toMatchObject({ outcome: 'cleanup_completed', executionId: 'execution-test', counts: { workspaces: 1, requests: 1, analyses: 1, clarifications: 1, decisions: 1, auditEvents: 1, automationAttempts: 1, artifacts: 1, artifactBytes: 3 } })
    expect(events).toEqual([result])
    expect(JSON.stringify(result)).not.toContain(expired)
    await expectCounts({ workspaces: 2, ai_requests: 0, analysis_runs: 0, clarification_answers: 0, decisions: 0, audit_events: 0, automation_attempts: 0, artifacts: 0 })
    expect((await database.query('select id from workspaces where id = $1', [active])).rows).toHaveLength(1)
    expect((await database.query('select id from workspaces where is_quarantine')).rows).toHaveLength(1)

    const second = await expireInactiveWorkspaces(database, () => undefined, 'second-run')
    expect(second.counts).toEqual({ workspaces: 0, requests: 0, analyses: 0, clarifications: 0, decisions: 0, auditEvents: 0, automationAttempts: 0, artifacts: 0, artifactBytes: 0 })
  })

  it('rolls back all candidate deletion when a dependent delete fails', async () => {
    const expired = '20000000-0000-4000-8000-000000000001'
    await database.query("insert into workspaces (id, last_activity_at) values ($1, transaction_timestamp() - interval '8 days')", [expired])
    await database.query(
      `insert into ai_requests (title, raw_request, request_type, department, requester_name, requester_role, business_problem, desired_outcome, workspace_id)
      values ('Rollback', '{}'::jsonb, 'ai_project', 'Ops', 'Synthetic', 'Owner', 'Test', 'Test', $1)`,
      [expired]
    )
    const failingDatabase: Database = {
      query: database.query.bind(database),
      close: database.close.bind(database),
      transaction: async <T>(operation: (transaction: DatabaseSession) => Promise<T>) =>
        database.transaction(async (transaction) =>
          operation({
            query: async (sql, parameters) => {
              if (sql.startsWith('delete from workspaces')) throw new Error('Synthetic delete failure')
              return transaction.query(sql, parameters)
            }
          })
        )
    }

    await expect(expireInactiveWorkspaces(failingDatabase, () => undefined)).rejects.toThrow('Synthetic delete failure')
    expect((await database.query('select id from workspaces where id = $1', [expired])).rows).toHaveLength(1)
    expect((await database.query('select id from ai_requests where workspace_id = $1', [expired])).rows).toHaveLength(1)
  })

  it('skips leased activity until the bounded lease expires', async () => {
    const workspaceId = '30000000-0000-4000-8000-000000000001'
    await database.query("insert into workspaces (id, last_activity_at) values ($1, transaction_timestamp() - interval '8 days')", [workspaceId])
    await database.query("insert into workspace_activity_leases (id, workspace_id, expires_at) values ('30000000-0000-4000-8000-000000000002', $1, transaction_timestamp() + interval '5 minutes')", [workspaceId])

    const protectedRun = await expireInactiveWorkspaces(database, () => undefined)
    expect(protectedRun.counts.workspaces).toBe(0)
    expect((await database.query('select id from workspaces where id = $1', [workspaceId])).rows).toHaveLength(1)

    await database.query("update workspace_activity_leases set expires_at = transaction_timestamp() - interval '1 second' where workspace_id = $1", [workspaceId])
    const expiredRun = await expireInactiveWorkspaces(database, () => undefined)
    expect(expiredRun.counts.workspaces).toBe(1)
    expect((await database.query('select id from workspaces where id = $1', [workspaceId])).rows).toHaveLength(0)
  })

  it('reports advisory-lock contention as a sanitized successful skip', async () => {
    const events: unknown[] = []
    const lockBusyDatabase: Database = {
      close: async () => undefined,
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async <T>(operation: (transaction: DatabaseSession) => Promise<T>) => operation({ query: async <Row extends Record<string, unknown>>() => ({ rows: [{ acquired: false }] as Row[], rowCount: 1 }) })
    }

    const result = await expireInactiveWorkspaces(lockBusyDatabase, (event) => events.push(event), 'lock-busy')
    expect(result).toMatchObject({ outcome: 'cleanup_skipped', cutoff: null, executionId: 'lock-busy', counts: { workspaces: 0 } })
    expect(events).toEqual([result])
    expect(JSON.stringify(result)).not.toMatch(/workspaceId|cookie|secret/i)
  })

  async function expectCounts(expected: Record<string, number>): Promise<void> {
    for (const [table, count] of Object.entries(expected)) {
      const result = await database.query<{ count: number }>(`select count(*)::int as count from ${table}`)
      expect(Number(result.rows[0].count)).toBe(count)
    }
  }
})
