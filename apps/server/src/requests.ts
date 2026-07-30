import type { AuditEventRecord, RequestDetail, RequestRecord, RequestSubmission } from '@ai-enablement/contracts'
import type { Database, DatabaseSession } from './database.js'

type RequestRow = {
  id: string
  title: string
  raw_request: RequestSubmission
  request_type: RequestRecord['requestType']
  department: string
  requester_name: string
  requester_role: string
  business_problem: string
  desired_outcome: string
  current_process: string | null
  intended_users: string[]
  data_sources: string[]
  submitted_at: Date | string
  updated_at: Date | string
  status: RequestRecord['status']
  version: number
  synthetic_demo_safe: boolean
}

type AuditRow = {
  id: string
  request_id: string
  actor_type: AuditEventRecord['actorType']
  actor_name: string
  event_type: string
  description: string
  metadata: Record<string, unknown>
  created_at: Date | string
}

function iso(value: Date | string): string {
  return new Date(value).toISOString()
}

function mapRequest(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    title: row.title,
    requestType: row.request_type,
    department: row.department,
    requesterName: row.requester_name,
    requesterRole: row.requester_role,
    businessProblem: row.business_problem,
    desiredOutcome: row.desired_outcome,
    currentProcess: row.current_process,
    intendedUsers: row.intended_users,
    dataSources: row.data_sources,
    status: row.status,
    version: Number(row.version),
    syntheticDemoSafe: row.synthetic_demo_safe,
    submittedAt: iso(row.submitted_at),
    updatedAt: iso(row.updated_at),
  }
}

function mapAudit(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    actorType: row.actor_type,
    actorName: row.actor_name,
    eventType: row.event_type,
    description: row.description,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  }
}

const requestColumns = `id, title, raw_request, request_type, department, requester_name, requester_role,
  business_problem, desired_outcome, current_process, intended_users, data_sources, submitted_at, updated_at, status, version, synthetic_demo_safe`

export async function createRequest(database: Database, submission: RequestSubmission): Promise<RequestDetail> {
  return database.transaction(async (transaction) => {
    const inserted = await transaction.query<RequestRow>(`insert into ai_requests (
      title, raw_request, request_type, department, requester_name, requester_role, business_problem,
      desired_outcome, current_process, intended_users, data_sources, synthetic_demo_safe
    ) values ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
    returning ${requestColumns}`, [
      submission.title, JSON.stringify(submission), submission.requestType, submission.department,
      submission.requesterName, submission.requesterRole, submission.businessProblem, submission.desiredOutcome,
      submission.currentProcess, JSON.stringify(submission.intendedUsers), JSON.stringify(submission.dataSources), submission.syntheticDemoSafe,
    ])
    const request = mapRequest(inserted.rows[0])
    const audit = await insertSubmissionAudit(transaction, request)
    return { ...request, auditEvents: [audit] }
  })
}

async function insertSubmissionAudit(database: DatabaseSession, request: RequestRecord): Promise<AuditEventRecord> {
  const inserted = await database.query<AuditRow>(`insert into audit_events (
    request_id, actor_type, actor_name, event_type, description, metadata
  ) values ($1, 'requester', $2, 'request_submitted', $3, $4::jsonb) returning *`, [
    request.id, request.requesterName, `${request.requesterName} submitted ${request.title}.`,
    JSON.stringify({ requestType: request.requestType }),
  ])
  return mapAudit(inserted.rows[0])
}

export async function listRequests(database: Database): Promise<RequestRecord[]> {
  const result = await database.query<RequestRow>(`select ${requestColumns} from ai_requests order by submitted_at desc, id desc`)
  return result.rows.map(mapRequest)
}

export async function getRequest(database: Database, id: string): Promise<RequestDetail | null> {
  const requestResult = await database.query<RequestRow>(`select ${requestColumns} from ai_requests where id = $1`, [id])
  if (requestResult.rows.length === 0) return null
  const auditResult = await database.query<AuditRow>('select * from audit_events where request_id = $1 order by created_at, id', [id])
  return { ...mapRequest(requestResult.rows[0]), auditEvents: auditResult.rows.map(mapAudit) }
}

export async function listAuditEvents(database: Database, id: string): Promise<AuditEventRecord[]> {
  const request = await database.query('select id from ai_requests where id = $1', [id])
  if (request.rows.length === 0) return []
  const auditResult = await database.query<AuditRow>('select * from audit_events where request_id = $1 order by created_at, id', [id])
  return auditResult.rows.map(mapAudit)
}

export async function resetDemo(database: Database, submissions: RequestSubmission[]): Promise<RequestRecord[]> {
  await database.transaction(async (transaction) => {
    await transaction.query('delete from audit_events')
    await transaction.query('delete from ai_requests')
  })
  for (const submission of submissions) await createRequest(database, submission)
  return listRequests(database)
}
