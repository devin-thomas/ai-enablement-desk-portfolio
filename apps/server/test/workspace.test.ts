import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceSigner } from '../src/workspace.js'
import { createMemoryDatabase } from '../src/database.js'
import { migrate } from '../src/migrations.js'
import { nativeFetch } from './browser.js'

describe('workspace cookie attributes', () => {
  let server: Server
  const database = createMemoryDatabase()

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await database.close()
  })

  it('marks production workspace cookies secure with the seven-day lifetime', async () => {
    const signer = new WorkspaceSigner('production-test-secret', true)
    server = createServer((request, response) => {
      void signer.resolve(database, request, response).then(() => response.end())
    })
    await migrate(database)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)

    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Max-Age=604800')
  })
})
