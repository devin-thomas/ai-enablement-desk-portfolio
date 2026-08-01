import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type AppInstance } from '../src/app.js'
import type { ServerEnv } from '../src/config/env.js'
import { createMemoryDatabase, type Database, type DatabaseSession, type QueryResult } from '../src/database.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused',
  geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
}

class FailingDatabase implements Database {
  failQueries = false

  constructor(private readonly delegate: Database) {}

  query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<Row>> {
    if (this.failQueries) return Promise.reject(new Error('Synthetic database outage'))
    return this.delegate.query<Row>(sql, parameters)
  }

  transaction<T>(operation: (database: DatabaseSession) => Promise<T>): Promise<T> {
    return this.delegate.transaction(operation)
  }

  close(): Promise<void> {
    return this.delegate.close()
  }
}

describe('health probes', () => {
  let app: AppInstance | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (!app) return
    await new Promise<void>((resolve) => app?.server.close(() => resolve()))
    await app.database.close()
    app = undefined
  })

  it('keeps liveness independent while readiness reports a database outage', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const database = new FailingDatabase(createMemoryDatabase())
    app = await createApp({ database, env })
    await new Promise<void>((resolve) => app?.server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

    expect(await fetch(`${baseUrl}/health/live`)).toMatchObject({ status: 200 })
    expect(await fetch(`${baseUrl}/health/ready`)).toMatchObject({ status: 200 })

    database.failQueries = true
    const readiness = await fetch(`${baseUrl}/health/ready`)
    expect(readiness.status).toBe(503)
    await expect(readiness.json()).resolves.toMatchObject({ ok: false, persistence: 'unavailable' })
    expect(await fetch(`${baseUrl}/health/live`)).toMatchObject({ status: 200 })
    expect(errorLog).toHaveBeenCalledWith('Readiness database check failed', expect.any(Error))
  })
})
