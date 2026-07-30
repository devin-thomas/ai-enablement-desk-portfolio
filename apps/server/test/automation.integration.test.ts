import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AIRequestAnalysis } from '@ai-enablement/contracts'
import { createApp, type AppInstance } from '../src/app.js'
import type { AnalysisProvider } from '../src/analysisProvider.js'
import { AutomationDispatcher } from '../src/automations.js'
import { createMemoryDatabase } from '../src/database.js'
import type { ServerEnv } from '../src/config/env.js'

const provider: AnalysisProvider = {
  name: 'stub-gemini', model: 'stub-model', schemaVersion: '1', promptVersion: '1',
  analyze: async () => ({ latencyMs: 5, analysis: {
    normalizedTitle: 'Synthetic review', requestType: 'ai_project', businessProblem: 'Review synthetic records.', desiredOutcome: 'Human review.',
    intendedUsers: ['Reviewers'], currentProcess: 'Manual review', dataSources: ['Synthetic records'], systemsToIntegrate: [], successMetrics: [],
    missingInformation: [], clarificationQuestions: [], riskFlags: [], readinessScore: 100, estimatedValue: 'medium', recommendedDisposition: 'ready_for_discovery',
    reviewerSummary: 'Synthetic text summary.', facts: [{ value: 'Records are synthetic.', source: 'requester', confirmed: true }],
    assumptions: [{ value: 'Record shape is stable.', source: 'model_inference', confirmed: false }], unknowns: [], ruleEvaluation: [],
  } satisfies AIRequestAnalysis }),
}

describe('n8n automation evidence', () => {
  let webhook: Server
  let webhookUrl: string
  let app: AppInstance
  let baseUrl: string
  let calls: Array<{ body: string; headers: Record<string, string | string[] | undefined> }>
  let responses: number[]

  beforeEach(async () => {
    calls = []; responses = []
    webhook = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        calls.push({ body, headers: request.headers })
        const status = responses.shift() ?? 200
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ externalExecutionId: `n8n-exec-${calls.length}` }))
      })
    })
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve))
    webhookUrl = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/webhook`
  })

  afterEach(async () => {
    if (app) {
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
      await app.database.close()
    }
    await new Promise<void>((resolve) => webhook.close(() => resolve()))
  })

  async function startApp(overrides: Partial<ServerEnv> = {}) {
    const env: ServerEnv = {
      nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
      n8nRequestSubmittedWebhook: webhookUrl, n8nDecisionRecordedWebhook: webhookUrl, n8nWebhookSecret: 'synthetic-webhook-secret',
      automationMaxAttempts: 3, automationRetryDelayMs: 0, ...overrides,
    }
    app = await createApp({ database: createMemoryDatabase(), env, analysisProvider: provider })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    return env
  }

  async function createRequest() {
    return (await (await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: 'Synthetic automation request', requestType: 'ai_project', department: 'Operations', requesterName: 'Demo Requester', requesterRole: 'Owner',
      businessProblem: 'A process owner needs governed handling for synthetic operational records.', desiredOutcome: 'Review a synthetic workflow.',
      currentProcess: 'Records are reviewed manually.', intendedUsers: ['Demo reviewers'], dataSources: ['Synthetic records'], syntheticDemoSafe: true,
    }) }))).json()
  }

  it('signs request and decision webhooks and persists real execution identifiers', async () => {
    await startApp()
    const created = await createRequest()
    expect(created.automationAttempt).toMatchObject({ automationName: 'request-submitted', status: 'success', externalExecutionId: 'n8n-exec-1' })
    const firstCall = calls[0]
    expect(firstCall.headers['x-aed-signature']).toBe(`sha256=${createHmac('sha256', 'synthetic-webhook-secret').update(firstCall.body).digest('hex')}`)

    const analyzed = await (await fetch(`${baseUrl}/api/requests/${created.request.id}/analyses`, { method: 'POST' })).json()
    const detail = await (await fetch(`${baseUrl}/api/requests/${created.request.id}`)).json()
    const decided = await (await fetch(`${baseUrl}/api/requests/${created.request.id}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      reviewerName: 'Synthetic Reviewer', decision: 'approve_for_discovery', rationale: 'Synthetic evidence is complete for discovery.', analysisRunId: analyzed.analysisRun.id, expectedVersion: detail.request.version,
    }) })).json()
    expect(decided.automationAttempt).toMatchObject({ automationName: 'request-decision-recorded', status: 'success', externalExecutionId: 'n8n-exec-2' })
    expect(calls).toHaveLength(2)
  })

  it('persists retry evidence and succeeds without duplicate logical delivery', async () => {
    responses.push(500, 200)
    const env = await startApp()
    const created = await createRequest()
    expect(created.automationAttempt).toMatchObject({ status: 'success', attemptNumber: 2, correlationId: expect.any(String) })
    const history = await (await fetch(`${baseUrl}/api/requests/${created.request.id}/automations`)).json()
    expect(history.automationAttempts.map((attempt: { status: string }) => attempt.status)).toEqual(['retrying', 'success'])
    const dispatcher = new AutomationDispatcher(app.database, env)
    await dispatcher.dispatch({ requestId: created.request.id, automationName: 'request-submitted', idempotencyKey: `request-submitted:${created.request.id}`, payload: { requestId: created.request.id, requestType: 'ai_project' } })
    expect(calls).toHaveLength(2)
  })

  it('records disabled and unavailable states without pretending delivery succeeded', async () => {
    await startApp({ n8nRequestSubmittedWebhook: undefined, n8nDecisionRecordedWebhook: undefined })
    const disabled = await createRequest()
    expect(disabled.automationAttempt).toMatchObject({ status: 'disabled', externalExecutionId: null, sanitizedErrorCode: 'webhook_disabled' })
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    await app.database.close()
    app = undefined as never

    await startApp({ n8nWebhookSecret: undefined })
    const unavailable = await createRequest()
    expect(unavailable.automationAttempt).toMatchObject({ status: 'unavailable', externalExecutionId: null, sanitizedErrorCode: 'webhook_secret_missing' })
  })
})
