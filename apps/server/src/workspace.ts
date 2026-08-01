import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database, DatabaseSession } from './database.js'

const cookieName = 'aed_workspace'
const maxAgeSeconds = 60 * 60 * 24 * 7
const leaseSeconds = 5 * 60

export type WorkspaceLease = { workspaceId: string; leaseId: string }

export class WorkspaceSigner {
  constructor(
    private readonly secret: string,
    private readonly secure: boolean
  ) {}

  async resolve(database: Database, request: IncomingMessage, response: ServerResponse): Promise<WorkspaceLease> {
    const value = readCookie(request.headers.cookie, cookieName)
    const workspaceId = value && this.verify(value)
    if (workspaceId) {
      const lease = await database.transaction((transaction) => this.leaseLiveWorkspace(transaction, workspaceId))
      if (lease) return lease
    }

    const id = randomUUID()
    const leaseId = randomUUID()
    await database.transaction(async (transaction) => {
      await transaction.query('insert into workspaces (id) values ($1)', [id])
      await this.insertLease(transaction, id, leaseId)
    })
    const secureAttribute = this.secure ? '; Secure' : ''
    response.setHeader('set-cookie', `${cookieName}=${this.sign(id)}; Path=/; HttpOnly${secureAttribute}; SameSite=Lax; Max-Age=${maxAgeSeconds}`)
    return { workspaceId: id, leaseId }
  }

  async complete(database: Database, lease: WorkspaceLease, successful: boolean): Promise<void> {
    await database.transaction(async (transaction) => {
      const root = await transaction.query<{ id: string }>('select id from workspaces where id = $1 and not is_quarantine for update', [lease.workspaceId])
      if (successful && root.rows.length !== 1) throw new Error('Workspace lease lost its root before successful completion')
      if (successful && root.rows.length === 1) {
        await transaction.query('update workspaces set last_activity_at = transaction_timestamp() where id = $1', [lease.workspaceId])
      }
      await transaction.query('delete from workspace_activity_leases where id = $1 and workspace_id = $2', [lease.leaseId, lease.workspaceId])
    })
  }

  private async leaseLiveWorkspace(database: DatabaseSession, workspaceId: string): Promise<WorkspaceLease | null> {
    const root = await database.query<{ id: string }>("select id from workspaces where id = $1 and not is_quarantine and last_activity_at > transaction_timestamp() - interval '7 days' for update", [workspaceId])
    if (root.rows.length !== 1) return null
    const leaseId = randomUUID()
    await this.insertLease(database, workspaceId, leaseId)
    return { workspaceId, leaseId }
  }

  private async insertLease(database: DatabaseSession, workspaceId: string, leaseId: string): Promise<void> {
    await database.query("insert into workspace_activity_leases (id, workspace_id, expires_at) values ($1, $2, transaction_timestamp() + ($3 * interval '1 second'))", [leaseId, workspaceId, leaseSeconds])
  }

  private sign(workspaceId: string): string {
    return `${workspaceId}.${createHmac('sha256', this.secret).update(workspaceId).digest('base64url')}`
  }

  private verify(value: string): string | null {
    const [workspaceId, signature, ...extra] = value.split('.')
    if (extra.length || !workspaceId || !signature || !isUuid(workspaceId)) return null
    const expected = this.sign(workspaceId)
    if (value.length !== expected.length) return null
    return timingSafeEqual(Buffer.from(value), Buffer.from(expected)) ? workspaceId : null
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=') || null
  }
  return null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
