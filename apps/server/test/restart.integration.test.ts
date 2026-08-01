import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type AppInstance } from '../src/app.js'
import type { ServerEnv } from '../src/config/env.js'

describe('restart-safe demo persistence', () => {
  const apps: AppInstance[] = []
  const directories: string[] = []

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      if (app.server.listening) await new Promise<void>((resolve) => app.server.close(() => resolve()))
      await app.database.close()
    }
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('reloads a submitted request after the server and database are reopened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aed-restart-'))
    directories.push(directory)
    const env: ServerEnv = { nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: join(directory, 'database'), workspaceCookieSecret: 'restart-test-workspace-secret', geminiModel: 'stub-model', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000 }

    const first = await createApp({ env })
    apps.push(first)
    await new Promise<void>((resolve) => first.server.listen(0, '127.0.0.1', resolve))
    const firstUrl = `http://127.0.0.1:${(first.server.address() as AddressInfo).port}`
    const created = await (await fetch(`${firstUrl}/api/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        title: 'Restart persistence verification', requestType: 'ai_project', department: 'Synthetic Operations',
        requesterName: 'Demo Requester', requesterRole: 'Process Owner',
        businessProblem: 'A synthetic process owner needs restart-safe evidence for request persistence.',
        desiredOutcome: 'Verify the request remains after a server restart.', currentProcess: null,
        intendedUsers: ['Demo reviewers'], dataSources: ['Synthetic verification data'],
      }),
    })).json()
    await new Promise<void>((resolve) => first.server.close(() => resolve()))
    await first.database.close()
    apps.splice(apps.indexOf(first), 1)

    const second = await createApp({ env })
    apps.push(second)
    await new Promise<void>((resolve) => second.server.listen(0, '127.0.0.1', resolve))
    const secondUrl = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`
    const reloaded = await (await fetch(`${secondUrl}/api/requests/${created.request.id}`)).json()
    expect(reloaded.request.id).toBe(created.request.id)
    expect(reloaded.request.auditEvents[0].eventType).toBe('request_submitted')
  }, 20_000)
})
