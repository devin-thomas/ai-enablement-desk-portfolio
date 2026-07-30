import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import type { ServerEnv } from './config/env.js'
import { repositoryRoot } from './paths.js'

export type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[]
  rowCount: number
}

export interface DatabaseSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<Row>>
}

export interface Database extends DatabaseSession {
  transaction<T>(operation: (database: DatabaseSession) => Promise<T>): Promise<T>
  close(): Promise<void>
}

class PGliteDatabase implements Database {
  constructor(private readonly client: PGlite) {}

  async query<Row extends Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(sql, parameters)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }

  async transaction<T>(operation: (database: DatabaseSession) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction) => operation({
      query: async <Row extends Record<string, unknown>>(sql: string, parameters: unknown[] = []) => {
        const result = await transaction.query<Row>(sql, parameters)
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
      },
    }))
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

class PostgresDatabase implements Database {
  constructor(private readonly pool: pg.Pool) {}

  async query<Row extends Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.pool.query<Row>(sql, parameters)
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
  }

  async transaction<T>(operation: (database: DatabaseSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const value = await operation({
        query: async <Row extends Record<string, unknown>>(sql: string, parameters: unknown[] = []) => {
          const result = await client.query<Row>(sql, parameters)
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
        },
      })
      await client.query('commit')
      return value
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export async function createDatabase(env: ServerEnv): Promise<Database> {
  if (env.databaseUrl) return new PostgresDatabase(new pg.Pool({ connectionString: env.databaseUrl }))
  if (!env.demoMode) throw new Error('DATABASE_URL is required outside demo mode')

  const dataPath = resolve(repositoryRoot, env.demoDatabasePath)
  await mkdir(dirname(dataPath), { recursive: true })
  return new PGliteDatabase(new PGlite(dataPath))
}

export function createMemoryDatabase(): Database {
  return new PGliteDatabase(new PGlite())
}
