import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceSigner } from '../src/workspace.js'
import { nativeFetch } from './browser.js'

describe('workspace cookie attributes', () => {
  let server: Server

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('marks production workspace cookies secure with the seven-day lifetime', async () => {
    const signer = new WorkspaceSigner('production-test-secret', true)
    server = createServer((request, response) => {
      signer.resolve(request, response)
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)

    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Max-Age=604800')
  })
})
