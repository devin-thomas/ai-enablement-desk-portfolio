import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const cookieName = 'aed_workspace'
const maxAgeSeconds = 60 * 60 * 24 * 7

export class WorkspaceSigner {
  constructor(private readonly secret: string, private readonly secure: boolean) {}

  resolve(request: IncomingMessage, response: ServerResponse): string {
    const value = readCookie(request.headers.cookie, cookieName)
    const workspaceId = value && this.verify(value)
    if (workspaceId) return workspaceId

    const id = randomUUID()
    const secureAttribute = this.secure ? '; Secure' : ''
    response.setHeader('set-cookie', `${cookieName}=${this.sign(id)}; Path=/; HttpOnly${secureAttribute}; SameSite=Lax; Max-Age=${maxAgeSeconds}`)
    return id
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
