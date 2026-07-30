import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { clarificationAnswerSubmissionSchema, decisionSchema, requestSubmissionSchema, type RequestSubmission } from '@ai-enablement/contracts'
import { ZodError } from 'zod'
import { loadEnv, type ServerEnv } from './config/env.js'
import { createDatabase, type Database } from './database.js'
import { migrate } from './migrations.js'
import { createRequest, getRequest, listAuditEvents, listRequests, resetDemo } from './requests.js'
import { repositoryRoot } from './paths.js'
import { GeminiAnalysisProvider, type AnalysisProvider } from './analysisProvider.js'
import { AnalysisRequestError, answerClarification, listAnalyses, runAnalysis } from './analyses.js'
import { DecisionRequestError, listDecisions, recordDecision } from './decisions.js'
import { AutomationDispatcher, AutomationRequestError, listAutomations } from './automations.js'
import { AudioRequestError, FishAudioProvider, generateAudioBriefing, getArtifactContent, listArtifacts, type AudioProvider } from './audio.js'

type AppOptions = {
  database?: Database
  env?: ServerEnv
  migrationsDirectory?: string
  analysisProvider?: AnalysisProvider
  audioProvider?: AudioProvider
}

export type AppInstance = {
  server: Server
  database: Database
  appliedMigrations: string[]
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new HttpError(413, 'Request body exceeds 1 MB')
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new HttpError(400, 'A JSON request body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message)
  }
}

async function loadDemoSubmissions(): Promise<RequestSubmission[]> {
  const fixtures = [
    'fixtures/requests/maintenance-report-summary.json',
    'fixtures/requests/tool-access-request.json',
    'fixtures/requests/unsafe-sensitive-data-request.json',
  ]
  return Promise.all(fixtures.map(async (path) => {
    const value = JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8'))
    return requestSubmissionSchema.parse(value)
  }))
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, database: Database, env: ServerEnv, analysisProvider: AnalysisProvider, audioProvider: AudioProvider, automations: AutomationDispatcher): Promise<void> {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, null)
    return
  }
  const url = new URL(request.url ?? '/', 'http://localhost')

  if (request.method === 'GET' && url.pathname === '/health') {
    const n8n = !env.n8nRequestSubmittedWebhook && !env.n8nDecisionRecordedWebhook ? 'disabled' : env.n8nWebhookSecret ? 'configured' : 'unavailable'
    const fishAudio = !env.audioBriefingsEnabled ? 'disabled' : env.fishAudioApiKey ? 'configured' : 'unavailable'
    sendJson(response, 200, { ok: true, service: 'ai-enablement-server', demoMode: env.demoMode, persistence: env.databaseUrl ? 'supabase-postgres' : 'embedded-postgres', providers: { gemini: env.geminiApiKey ? 'configured' : 'unavailable_key', n8n, fishAudio } })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/requests') {
    const submission = requestSubmissionSchema.parse(await readJson(request))
    const created = await createRequest(database, submission)
    const automationAttempt = await automations.dispatch({ requestId: created.id, automationName: 'request-submitted', idempotencyKey: `request-submitted:${created.id}`, payload: { requestId: created.id, requestType: created.requestType } })
    sendJson(response, 201, { request: await getRequest(database, created.id), automationAttempt })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/requests') {
    sendJson(response, 200, { requests: await listRequests(database) })
    return
  }
  const analysesMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/analyses$/i)
  if (analysesMatch && request.method === 'GET') {
    sendJson(response, 200, await listAnalyses(database, analysesMatch[1]))
    return
  }
  if (analysesMatch && request.method === 'POST') {
    sendJson(response, 201, { analysisRun: await runAnalysis(database, analysisProvider, analysesMatch[1]) })
    return
  }
  const clarificationMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/clarifications$/i)
  if (clarificationMatch && request.method === 'POST') {
    const submission = clarificationAnswerSubmissionSchema.parse(await readJson(request))
    sendJson(response, 201, { clarificationAnswer: await answerClarification(database, clarificationMatch[1], submission) })
    return
  }
  const decisionsMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/decisions$/i)
  if (decisionsMatch && request.method === 'GET') {
    sendJson(response, 200, { decisions: await listDecisions(database, decisionsMatch[1]) })
    return
  }
  if (decisionsMatch && request.method === 'POST') {
    const submission = decisionSchema.parse(await readJson(request))
    const decision = await recordDecision(database, decisionsMatch[1], submission)
    const automationAttempt = await automations.dispatch({ requestId: decisionsMatch[1], automationName: 'request-decision-recorded', idempotencyKey: `request-decision-recorded:${decision.id}`, payload: { requestId: decisionsMatch[1], decisionId: decision.id, decision: decision.decision } })
    sendJson(response, 201, { decision, automationAttempt })
    return
  }
  const auditMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/audit-events$/i)
  if (auditMatch && request.method === 'GET') {
    const auditEvents = await listAuditEvents(database, auditMatch[1])
    if (auditEvents.length === 0 && !await getRequest(database, auditMatch[1])) throw new HttpError(404, 'Request not found')
    sendJson(response, 200, { auditEvents })
    return
  }
  const automationsMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/automations$/i)
  if (automationsMatch && request.method === 'GET') {
    sendJson(response, 200, { automationAttempts: await listAutomations(database, automationsMatch[1]) })
    return
  }
  const automationRetryMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/automations\/([0-9a-f-]+)\/retry$/i)
  if (automationRetryMatch && request.method === 'POST') {
    sendJson(response, 201, { automationAttempt: await automations.retry(automationRetryMatch[1], automationRetryMatch[2]) })
    return
  }
  const audioMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/audio-briefings$/i)
  if (audioMatch && request.method === 'POST') {
    sendJson(response, 201, { artifact: await generateAudioBriefing(database, env, audioProvider, audioMatch[1]) })
    return
  }
  const artifactsMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/artifacts$/i)
  if (artifactsMatch && request.method === 'GET') {
    sendJson(response, 200, { artifacts: await listArtifacts(database, artifactsMatch[1]) })
    return
  }
  const artifactContentMatch = url.pathname.match(/^\/api\/artifacts\/([0-9a-f-]+)\/content$/i)
  if (artifactContentMatch && request.method === 'GET') {
    const content = await getArtifactContent(database, artifactContentMatch[1])
    if (!content) throw new HttpError(404, 'Artifact not found')
    response.writeHead(200, { 'content-type': content.mimeType, 'content-length': String(content.bytes.byteLength), 'cache-control': 'private, max-age=300' })
    response.end(Buffer.from(content.bytes))
    return
  }
  const detailMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)$/i)
  if (request.method === 'GET' && detailMatch) {
    const record = await getRequest(database, detailMatch[1])
    if (!record) throw new HttpError(404, 'Request not found')
    sendJson(response, 200, { request: record })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
    if (!env.demoMode) throw new HttpError(403, 'Demo reset is disabled outside demo mode')
    const requests = await resetDemo(database, await loadDemoSubmissions())
    sendJson(response, 200, { requests })
    return
  }
  throw new HttpError(404, 'Route not found')
}

export async function createApp(options: AppOptions = {}): Promise<AppInstance> {
  const env = options.env ?? loadEnv()
  const database = options.database ?? await createDatabase(env)
  const analysisProvider = options.analysisProvider ?? new GeminiAnalysisProvider(env)
  const audioProvider = options.audioProvider ?? new FishAudioProvider(env)
  const automations = new AutomationDispatcher(database, env)
  const appliedMigrations = await migrate(database, options.migrationsDirectory)
  const server = createServer((request, response) => {
    void handleRequest(request, response, database, env, analysisProvider, audioProvider, automations).catch((error: unknown) => {
      if (error instanceof ZodError) {
        sendJson(response, 422, { error: 'Request validation failed', details: error.issues })
        return
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message, details: error.details })
        return
      }
      if (error instanceof AnalysisRequestError) {
        sendJson(response, error.status, { error: error.message, code: error.code, analysisRun: error.analysisRun })
        return
      }
      if (error instanceof DecisionRequestError) {
        sendJson(response, error.status, { error: error.message, code: error.code })
        return
      }
      if (error instanceof AutomationRequestError || error instanceof AudioRequestError) {
        sendJson(response, error.status, { error: error.message, code: error.code })
        return
      }
      console.error('Unhandled request error', error)
      sendJson(response, 500, { error: 'Internal server error' })
    })
  })
  return { server, database, appliedMigrations }
}
