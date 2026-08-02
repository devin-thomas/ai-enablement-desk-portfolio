import { readFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
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
import { AudioRequestError, FishAudioProvider, generateAudioBriefing, generateOriginalRequestNarration, getArtifactContent, listArtifacts, type AudioProvider } from './audio.js'
import { WorkspaceSigner } from './workspace.js'

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

type ResponseSink = {
  setHeader(name: string, value: number | string | readonly string[]): void
  writeHead(status: number, headers?: Record<string, string>): void
  end(chunk?: string | Buffer): void
}

function sendJson(response: ResponseSink, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

class BufferedResponse implements ResponseSink {
  private status = 200
  private readonly headers: Record<string, string> = {}
  private body: Buffer | undefined

  setHeader(name: string, value: number | string | readonly string[]): void {
    this.headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status
    Object.assign(this.headers, headers)
  }

  end(chunk?: string | Buffer): void {
    this.body = chunk === undefined ? undefined : Buffer.from(chunk)
  }

  flush(response: ServerResponse): void {
    response.writeHead(this.status, this.headers)
    response.end(this.body)
  }
}

const developmentOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

function applyDevelopmentCors(request: IncomingMessage, response: ServerResponse, env: ServerEnv): void {
  if (env.nodeEnv === 'production') return
  const origin = request.headers.origin
  if (!origin || !developmentOrigins.has(origin)) return
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-credentials', 'true')
  response.setHeader('access-control-allow-headers', 'content-type')
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  response.setHeader('vary', 'Origin')
}

function hasValidOriginCredential(request: IncomingMessage, expectedValues: readonly string[]): boolean {
  const supplied = request.headers['x-aed-origin-credential']
  if (typeof supplied !== 'string') return false
  return expectedValues.some((expected) => supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
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
    'fixtures/requests/customer-feedback-themes.json',
    'fixtures/requests/support-article-draft.json',
    'fixtures/requests/invoice-exception-triage.json',
    'fixtures/requests/meeting-action-items.json',
    'fixtures/requests/accessibility-issue-intake.json',
    'fixtures/requests/policy-question-routing.json',
    'fixtures/requests/incident-postmortem-summary.json',
  ]
  return Promise.all(fixtures.map(async (path) => {
    const value = JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8'))
    return requestSubmissionSchema.parse(value)
  }))
}

function isDemoResetEnabled(env: ServerEnv): boolean {
  return env.demoResetEnabled === true && (env.demoMode || env.nodeEnv === 'production')
}

async function handleRequest(request: IncomingMessage, httpResponse: ServerResponse, database: Database, env: ServerEnv, analysisProvider: AnalysisProvider, audioProvider: AudioProvider, workspaces: WorkspaceSigner): Promise<void> {
  applyDevelopmentCors(request, httpResponse, env)
  const url = new URL(request.url ?? '/', 'http://localhost')

  if (request.method === 'GET' && url.pathname === '/health/live') {
    sendJson(httpResponse, 200, { ok: true, service: 'ai-enablement-server' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    try {
      await database.query('select 1 as ready')
    } catch (error) {
      console.error('Readiness database check failed', error)
      sendJson(httpResponse, 503, { ok: false, service: 'ai-enablement-server', persistence: 'unavailable' })
      return
    }
    sendJson(httpResponse, 200, { ok: true, service: 'ai-enablement-server', persistence: env.databaseUrl ? 'supabase-postgres' : 'embedded-postgres' })
    return
  }
  const requiresOriginAuthentication = url.pathname === '/health' || url.pathname.startsWith('/api/')
  const originCredentials = [env.azureOriginCredential, env.azureOriginCredentialSecondary].filter((value): value is string => Boolean(value))
  if (requiresOriginAuthentication && originCredentials.length > 0 && !hasValidOriginCredential(request, originCredentials)) {
    sendJson(httpResponse, 403, { error: 'Origin authentication failed' })
    return
  }
  if (request.method === 'OPTIONS') {
    sendJson(httpResponse, 204, null)
    return
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    try {
      await database.query('select 1 as ready')
    } catch (error) {
      console.error('Readiness database check failed', error)
      sendJson(httpResponse, 503, { ok: false, service: 'ai-enablement-server', persistence: 'unavailable' })
      return
    }
    const n8n = !env.n8nRequestSubmittedWebhook && !env.n8nDecisionRecordedWebhook ? 'disabled' : env.n8nWebhookSecret ? 'configured' : 'unavailable'
    const gemini = !env.geminiApiKey ? 'unavailable_key' : env.geminiPublicLaunchApproved ? 'configured' : 'approval_required'
    const fishAudio = !env.audioBriefingsEnabled ? 'disabled' : !env.fishAudioApiKey ? 'unavailable_key' : env.fishVoicePreflightApproved ? 'configured' : 'approval_required'
    sendJson(httpResponse, 200, {
      ok: true,
      service: 'ai-enablement-server',
      demoMode: env.demoMode,
      persistence: env.databaseUrl ? 'supabase-postgres' : 'embedded-postgres',
      providers: { gemini, n8n, fishAudio },
      features: { demoReset: isDemoResetEnabled(env) },
    })
    return
  }
  const lease = await workspaces.resolve(database, request, httpResponse)
  const workspaceId = lease.workspaceId
  const bufferedResponse = new BufferedResponse()
  const response = bufferedResponse
  const automations = new AutomationDispatcher(database, env)
  try {
    await (async () => {
  if (request.method === 'POST' && url.pathname === '/api/requests') {
    const submission = requestSubmissionSchema.parse(await readJson(request))
    const created = await createRequest(database, workspaceId, submission)
    const automationAttempt = await automations.dispatch({ requestId: created.id, automationName: 'request-submitted', idempotencyKey: `request-submitted:${created.id}`, payload: { requestId: created.id, requestType: created.requestType } })
    sendJson(response, 201, { request: await getRequest(database, workspaceId, created.id), automationAttempt })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/requests') {
    sendJson(response, 200, { requests: await listRequests(database, workspaceId) })
    return
  }
  const analysesMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/analyses$/i)
  if (analysesMatch && request.method === 'GET') {
    sendJson(response, 200, await listAnalyses(database, workspaceId, analysesMatch[1]))
    return
  }
  if (analysesMatch && request.method === 'POST') {
    sendJson(response, 201, { analysisRun: await runAnalysis(database, analysisProvider, workspaceId, analysesMatch[1]) })
    return
  }
  const clarificationMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/clarifications$/i)
  if (clarificationMatch && request.method === 'POST') {
    const submission = clarificationAnswerSubmissionSchema.parse(await readJson(request))
    sendJson(response, 201, { clarificationAnswer: await answerClarification(database, workspaceId, clarificationMatch[1], submission) })
    return
  }
  const decisionsMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/decisions$/i)
  if (decisionsMatch && request.method === 'GET') {
    sendJson(response, 200, { decisions: await listDecisions(database, workspaceId, decisionsMatch[1]) })
    return
  }
  if (decisionsMatch && request.method === 'POST') {
    const submission = decisionSchema.parse(await readJson(request))
    const decision = await recordDecision(database, workspaceId, decisionsMatch[1], submission)
    const automationAttempt = await automations.dispatch({ requestId: decisionsMatch[1], automationName: 'request-decision-recorded', idempotencyKey: `request-decision-recorded:${decision.id}`, payload: { requestId: decisionsMatch[1], decisionId: decision.id, decision: decision.decision } })
    sendJson(response, 201, { decision, automationAttempt })
    return
  }
  const auditMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/audit-events$/i)
  if (auditMatch && request.method === 'GET') {
    const auditEvents = await listAuditEvents(database, workspaceId, auditMatch[1])
    if (auditEvents.length === 0 && !await getRequest(database, workspaceId, auditMatch[1])) throw new HttpError(404, 'Request not found')
    sendJson(response, 200, { auditEvents })
    return
  }
  const automationsMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/automations$/i)
  if (automationsMatch && request.method === 'GET') {
    sendJson(response, 200, { automationAttempts: await listAutomations(database, workspaceId, automationsMatch[1]) })
    return
  }
  const automationRetryMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/automations\/([0-9a-f-]+)\/retry$/i)
  if (automationRetryMatch && request.method === 'POST') {
    sendJson(response, 201, { automationAttempt: await automations.retry(workspaceId, automationRetryMatch[1], automationRetryMatch[2]) })
    return
  }
  const audioMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/audio-briefings$/i)
  if (audioMatch && request.method === 'POST') {
    sendJson(response, 201, { artifact: await generateAudioBriefing(database, env, audioProvider, workspaceId, audioMatch[1]) })
    return
  }
  const originalNarrationMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/original-request-narrations$/i)
  if (originalNarrationMatch && request.method === 'POST') {
    sendJson(response, 201, { artifact: await generateOriginalRequestNarration(database, env, audioProvider, workspaceId, originalNarrationMatch[1]) })
    return
  }
  const artifactsMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/artifacts$/i)
  if (artifactsMatch && request.method === 'GET') {
    sendJson(response, 200, { artifacts: await listArtifacts(database, workspaceId, artifactsMatch[1]) })
    return
  }
  const artifactContentMatch = url.pathname.match(/^\/api\/artifacts\/([0-9a-f-]+)\/content$/i)
  if (artifactContentMatch && request.method === 'GET') {
    const content = await getArtifactContent(database, workspaceId, artifactContentMatch[1])
    if (!content) throw new HttpError(404, 'Artifact not found')
    response.writeHead(200, { 'content-type': content.mimeType, 'content-length': String(content.bytes.byteLength), 'cache-control': 'private, max-age=300' })
    response.end(Buffer.from(content.bytes))
    return
  }
  const detailMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)$/i)
  if (request.method === 'GET' && detailMatch) {
    const record = await getRequest(database, workspaceId, detailMatch[1])
    if (!record) throw new HttpError(404, 'Request not found')
    sendJson(response, 200, { request: record })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
    if (!isDemoResetEnabled(env)) throw new HttpError(403, 'Demo reset is disabled')
    const requests = await resetDemo(database, workspaceId, await loadDemoSubmissions())
    sendJson(response, 200, { requests })
    return
  }
  throw new HttpError(404, 'Route not found')
    })()
  } catch (error) {
    await workspaces.complete(database, lease, false)
    throw error
  }
  await workspaces.complete(database, lease, true)
  bufferedResponse.flush(httpResponse)
}

export async function createApp(options: AppOptions = {}): Promise<AppInstance> {
  const env = options.env ?? loadEnv()
  if (env.nodeEnv === 'production') {
    if (!env.workspaceCookieSecret || env.workspaceCookieSecret.length < 32) throw new Error('WORKSPACE_COOKIE_SECRET must be at least 32 characters in production')
    if (!env.azureOriginCredential || env.azureOriginCredential.length < 32) throw new Error('AZURE_ORIGIN_CREDENTIAL must be at least 32 characters in production')
    if (env.azureOriginCredentialSecondary && env.azureOriginCredentialSecondary.length < 32) throw new Error('AZURE_ORIGIN_CREDENTIAL_SECONDARY must be at least 32 characters when configured')
  }
  const database = options.database ?? (await createDatabase(env))
  const analysisProvider = options.analysisProvider ?? new GeminiAnalysisProvider(env)
  const audioProvider = options.audioProvider ?? new FishAudioProvider(env)
  const workspaces = new WorkspaceSigner(env.workspaceCookieSecret ?? randomBytes(32).toString('base64url'), env.nodeEnv === 'production')
  const appliedMigrations = await migrate(database, options.migrationsDirectory)
  const server = createServer((request, response) => {
    void handleRequest(request, response, database, env, analysisProvider, audioProvider, workspaces).catch((error: unknown) => {
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
