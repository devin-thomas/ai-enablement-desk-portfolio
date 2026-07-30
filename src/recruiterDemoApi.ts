import {
  clarificationAnswerSubmissionSchema,
  decisionSchema,
  requestSubmissionSchema,
  type AIRequestAnalysis,
  type AnalysisRun,
  type ArtifactRecord,
  type AutomationAttempt,
  type ClarificationAnswerRecord,
  type DecisionRecord,
  type RequestDetail,
} from '@ai-enablement/contracts'

type RequestStatus = RequestDetail['status']

type DemoState = {
  requests: RequestDetail[]
  analyses: Record<string, AnalysisRun[]>
  clarificationAnswers: Record<string, ClarificationAnswerRecord[]>
  decisions: Record<string, DecisionRecord[]>
  automations: Record<string, AutomationAttempt[]>
  artifacts: Record<string, ArtifactRecord[]>
}

const storageKey = 'ai-enablement-desk:recruiter-sandbox:v1'
const maintenanceId = '10000000-0000-4000-8000-000000000001'
const toolAccessId = '10000000-0000-4000-8000-000000000002'
const highRiskId = '10000000-0000-4000-8000-000000000003'

const seedSubmissions = [
  {
    id: maintenanceId,
    title: 'Maintenance field report triage',
    requestType: 'ai_project' as const,
    department: 'Operations Excellence',
    requesterName: 'Synthetic Maintenance Requester',
    requesterRole: 'Maintenance Manager',
    businessProblem: 'Maintenance managers receive long field reports each morning and need to identify urgent issues quickly.',
    desiredOutcome: 'Summarize important issues and highlight which ones need immediate attention.',
    currentProcess: 'Managers read reports manually and escalate issues from memory.',
    intendedUsers: ['Maintenance managers', 'Reliability engineers'],
    dataSources: ['Synthetic field reports'],
    syntheticDemoSafe: true,
  },
  {
    id: toolAccessId,
    title: 'Approved AI writing tool access',
    requestType: 'tool_access' as const,
    department: 'Marketing',
    requesterName: 'Synthetic Marketing Requester',
    requesterRole: 'Marketing Specialist',
    businessProblem: 'The marketing team needs an approved AI writing tool for first drafts and campaign variations.',
    desiredOutcome: 'Provide access to an approved tool with the right license and usage guidance.',
    currentProcess: 'Drafts are created manually and reviewed by the marketing lead.',
    intendedUsers: ['Marketing team'],
    dataSources: ['Synthetic campaign copy'],
    syntheticDemoSafe: true,
  },
  {
    id: highRiskId,
    title: 'Employee records summarization',
    requestType: 'ai_project' as const,
    department: 'People Operations',
    requesterName: 'Synthetic People Ops Requester',
    requesterRole: 'Department Manager',
    businessProblem: 'A manager wants to upload employee medical and performance data to a public AI service for summaries.',
    desiredOutcome: 'Automatically summarize employee records for manager review.',
    currentProcess: 'Records are reviewed by authorized People Operations staff.',
    intendedUsers: ['Department managers'],
    dataSources: ['Employee medical records', 'Employee performance records', 'Public AI service'],
    syntheticDemoSafe: false,
  },
]

function now(): string {
  return new Date().toISOString()
}

function audit(requestId: string, actorType: RequestDetail['auditEvents'][number]['actorType'], actorName: string, eventType: string, description: string) {
  return { id: crypto.randomUUID(), requestId, actorType, actorName, eventType, description, metadata: {}, createdAt: now() }
}

function freshState(): DemoState {
  const createdAt = now()
  const requests = seedSubmissions.map(({ id, ...submission }) => ({
    ...submission,
    id,
    status: 'submitted' as const,
    version: 1,
    submittedAt: createdAt,
    updatedAt: createdAt,
    auditEvents: [audit(id, 'requester', submission.requesterName, 'request_submitted', 'Synthetic request submitted in the isolated recruiter sandbox.')],
  }))
  return {
    requests,
    analyses: Object.fromEntries(requests.map((request) => [request.id, []])),
    clarificationAnswers: Object.fromEntries(requests.map((request) => [request.id, []])),
    decisions: Object.fromEntries(requests.map((request) => [request.id, []])),
    automations: Object.fromEntries(requests.map((request) => [request.id, [automation(request.id, 'request-submitted')]])),
    artifacts: Object.fromEntries(requests.map((request) => [request.id, []])),
  }
}

function loadState(): DemoState {
  const saved = localStorage.getItem(storageKey)
  if (!saved) {
    const state = freshState()
    saveState(state)
    return state
  }
  try {
    return JSON.parse(saved) as DemoState
  } catch {
    const state = freshState()
    saveState(state)
    return state
  }
}

function saveState(state: DemoState): void {
  localStorage.setItem(storageKey, JSON.stringify(state))
}

function automation(requestId: string, automationName: AutomationAttempt['automationName']): AutomationAttempt {
  const timestamp = now()
  return {
    id: crypto.randomUUID(), requestId, automationName, workflowVersion: 'recruiter-sandbox-v1', correlationId: crypto.randomUUID(),
    idempotencyKey: `${automationName}:${requestId}`, attemptNumber: 1, status: 'success', startedAt: timestamp, completedAt: timestamp,
    externalExecutionId: `sandbox-${crypto.randomUUID().slice(0, 8)}`, sanitizedErrorCode: null,
  }
}

function findRequest(state: DemoState, requestId: string): RequestDetail {
  const request = state.requests.find((candidate) => candidate.id === requestId)
  if (!request) throw new Error('Request not found')
  return request
}

function analysisFor(request: RequestDetail, hasClarification: boolean): { analysis: AIRequestAnalysis; modelRecommendation: AIRequestAnalysis['recommendedDisposition']; systemRecommendation: AIRequestAnalysis['recommendedDisposition']; status: RequestStatus } {
  const base = {
    normalizedTitle: request.title,
    requestType: request.requestType,
    businessProblem: request.businessProblem,
    desiredOutcome: request.desiredOutcome,
    intendedUsers: request.intendedUsers,
    currentProcess: request.currentProcess,
    dataSources: request.dataSources,
    systemsToIntegrate: [],
    successMetrics: ['Human reviewer confirms useful routing before downstream action'],
    estimatedValue: 'medium' as const,
    facts: [
      { value: request.businessProblem, source: 'requester' as const, confirmed: true },
      { value: request.desiredOutcome, source: 'requester' as const, confirmed: true },
    ],
    assumptions: [{ value: 'The synthetic workflow represents a bounded discovery request.', source: 'model_inference' as const, confirmed: false }],
  }

  if (request.id === highRiskId || request.dataSources.some((source) => /medical|performance|employee/i.test(source))) {
    const ruleEvaluation = [{ rule: 'privacy_high_risk_gate', result: 'failed' as const, explanation: 'Sensitive employee data must not be sent to a public AI service.' }]
    return {
      analysis: {
        ...base, missingInformation: [], clarificationQuestions: [], unknowns: [], readinessScore: 70,
        riskFlags: [{ category: 'privacy', severity: 'high', explanation: 'The request includes medical and performance information about employees.' }],
        recommendedDisposition: 'ready_for_discovery', reviewerSummary: 'The model sees a defined use case, but deterministic privacy policy blocks approval and routes it for decline.', ruleEvaluation,
      },
      modelRecommendation: 'ready_for_discovery', systemRecommendation: 'decline', status: 'ready_for_review',
    }
  }

  if (request.requestType === 'tool_access') {
    const ruleEvaluation = [{ rule: 'tool_access_route', result: 'needs_review' as const, explanation: 'Tool access requires a named human license and policy review.' }]
    return {
      analysis: {
        ...base, missingInformation: [], clarificationQuestions: [], unknowns: ['Available license capacity'], readinessScore: 75,
        riskFlags: [{ category: 'cost', severity: 'medium', explanation: 'License availability and cost require human confirmation.' }],
        recommendedDisposition: 'tool_access_review', reviewerSummary: 'The request is suitable for a human tool-access review; no automated license assignment occurs.', ruleEvaluation,
      },
      modelRecommendation: 'tool_access_review', systemRecommendation: 'tool_access_review', status: 'access_request',
    }
  }

  if (!hasClarification) {
    const questions = [{ id: 'CQ-HUMAN_VALIDATOR', question: 'Who will validate summaries before operational use?', targetField: 'humanValidator', reason: 'A named validator is required before discovery approval.', priority: 1, blocking: true }]
    const ruleEvaluation = [{ rule: 'human_validation_required', result: 'failed' as const, explanation: 'A human validator has not yet been named.' }]
    return {
      analysis: {
        ...base, missingInformation: ['Named human validator'], clarificationQuestions: questions, unknowns: ['Named human validator'], readinessScore: 55,
        riskFlags: [{ category: 'accuracy', severity: 'medium', explanation: 'Operational summaries require human validation.' }],
        recommendedDisposition: 'needs_clarification', reviewerSummary: 'The use case is promising, but a named human validator is required before discovery review.', ruleEvaluation,
      },
      modelRecommendation: 'needs_clarification', systemRecommendation: 'needs_clarification', status: 'needs_clarification',
    }
  }

  const ruleEvaluation = [
    { rule: 'human_validation_required', result: 'passed' as const, explanation: 'Clarification evidence names a human validator.' },
    { rule: 'privacy_high_risk_gate', result: 'passed' as const, explanation: 'Only synthetic field reports are in scope.' },
  ]
  return {
    analysis: {
      ...base, missingInformation: [], clarificationQuestions: [], unknowns: [], readinessScore: 85, riskFlags: [],
      recommendedDisposition: 'ready_for_discovery', reviewerSummary: 'The bounded synthetic use case has a named human validator and is ready for a human discovery decision.', ruleEvaluation,
    },
    modelRecommendation: 'ready_for_discovery', systemRecommendation: 'ready_for_discovery', status: 'ready_for_review',
  }
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('A JSON request body is required')
  return JSON.parse(init.body)
}

export async function recruiterDemoRequest(path: string, init?: RequestInit): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 180))
  const method = init?.method ?? 'GET'
  if (path === '/health') return { ok: true, providers: { gemini: 'demo_fixture', n8n: 'demo_evidence', fishAudio: 'disabled' } }
  if (path === '/api/demo/reset' && method === 'POST') {
    const state = freshState()
    saveState(state)
    return { requests: state.requests }
  }

  const state = loadState()
  if (path === '/api/requests' && method === 'GET') return { requests: state.requests }
  if (path === '/api/requests' && method === 'POST') {
    const submission = requestSubmissionSchema.parse(parseBody(init))
    const timestamp = now()
    const request: RequestDetail = { ...submission, id: crypto.randomUUID(), status: 'submitted', version: 1, submittedAt: timestamp, updatedAt: timestamp, auditEvents: [] }
    request.auditEvents.push(audit(request.id, 'requester', request.requesterName, 'request_submitted', 'Request validated and stored in this browser sandbox.'))
    state.requests.unshift(request)
    state.analyses[request.id] = []
    state.clarificationAnswers[request.id] = []
    state.decisions[request.id] = []
    state.automations[request.id] = [automation(request.id, 'request-submitted')]
    state.artifacts[request.id] = []
    saveState(state)
    return { request }
  }

  const match = path.match(/^\/api\/requests\/([0-9a-f-]+)(?:\/(analyses|clarifications|decisions|automations|artifacts|audio-briefings))?(?:\/([0-9a-f-]+)\/retry)?$/i)
  if (!match) throw new Error('Recruiter sandbox route not found')
  const [, requestId, resource, attemptId] = match
  const request = findRequest(state, requestId)
  if (!resource && method === 'GET') return { request }
  if (resource === 'analyses' && method === 'GET') return { analyses: state.analyses[requestId] ?? [], clarificationAnswers: state.clarificationAnswers[requestId] ?? [] }
  if (resource === 'analyses' && method === 'POST') {
    const result = analysisFor(request, (state.clarificationAnswers[requestId]?.length ?? 0) > 0)
    const run: AnalysisRun = {
      id: crypto.randomUUID(), requestId, provider: 'validated-demo-fixture', model: 'recruiter-sandbox-v1', schemaVersion: '1.0.0', promptVersion: 'portfolio-demo-v1',
      latencyMs: 180, outcome: 'success', sanitizedErrorCode: null, modelAnalysis: result.analysis,
      modelRecommendation: result.modelRecommendation, systemRecommendation: result.systemRecommendation, ruleEvaluation: result.analysis.ruleEvaluation, createdAt: now(),
    }
    state.analyses[requestId] = [run, ...(state.analyses[requestId] ?? [])]
    request.status = result.status
    request.version += 1
    request.updatedAt = now()
    request.auditEvents.push(audit(requestId, 'ai', 'Validated demo fixture', 'analysis_recorded', 'Schema-valid advisory analysis was recorded.'))
    request.auditEvents.push(audit(requestId, 'system', 'Deterministic router', 'route_evaluated', `Deterministic route: ${result.systemRecommendation}.`))
    saveState(state)
    return { analysisRun: run }
  }
  if (resource === 'clarifications' && method === 'POST') {
    const submission = clarificationAnswerSubmissionSchema.parse(parseBody(init))
    const latest = state.analyses[requestId]?.[0]
    const question = latest?.modelAnalysis?.clarificationQuestions.find((candidate) => candidate.id === submission.questionId)
    if (!question) throw new Error('Clarification question not found')
    const answer: ClarificationAnswerRecord = { ...submission, id: crypto.randomUUID(), requestId, question: question.question, createdAt: now() }
    state.clarificationAnswers[requestId] = [answer, ...(state.clarificationAnswers[requestId] ?? [])]
    request.version += 1
    request.updatedAt = now()
    request.auditEvents.push(audit(requestId, submission.actorType, submission.actorName, 'clarification_answered', `Clarification ${submission.questionId} answered.`))
    saveState(state)
    return { clarificationAnswer: answer }
  }
  if (resource === 'decisions' && method === 'GET') return { decisions: state.decisions[requestId] ?? [] }
  if (resource === 'decisions' && method === 'POST') {
    const submission = decisionSchema.parse(parseBody(init))
    const latest = state.analyses[requestId]?.[0]
    if (!latest || latest.id !== submission.analysisRunId) throw new Error('Decision must reference the latest analysis')
    if (request.version !== submission.expectedVersion) throw new Error('Request changed; reload before deciding')
    const privacyBlocked = latest.ruleEvaluation.some((rule) => rule.rule === 'privacy_high_risk_gate' && rule.result === 'failed')
    if (submission.decision === 'approve_for_discovery' && (request.status !== 'ready_for_review' || latest.systemRecommendation !== 'ready_for_discovery' || privacyBlocked)) {
      throw new Error('Deterministic governance rules prohibit approval')
    }
    const nextStatus: RequestStatus = submission.decision === 'approve_for_discovery' ? 'approved_for_discovery' : submission.decision === 'defer' ? 'deferred' : submission.decision === 'decline' ? 'declined' : 'needs_clarification'
    const previousStatus = request.status
    request.status = nextStatus
    request.version += 1
    request.updatedAt = now()
    const decision: DecisionRecord = { ...submission, id: crypto.randomUUID(), requestId, previousStatus, nextStatus, resultingVersion: request.version, createdAt: now() }
    state.decisions[requestId] = [decision, ...(state.decisions[requestId] ?? [])]
    state.automations[requestId] = [...(state.automations[requestId] ?? []), automation(requestId, 'request-decision-recorded')]
    request.auditEvents.push(audit(requestId, 'human', submission.reviewerName, 'human_decision_recorded', `${submission.decision.replaceAll('_', ' ')} recorded with rationale.`))
    request.auditEvents.push(audit(requestId, 'workflow', 'Recruiter sandbox automation', 'automation_attempt_recorded', 'Synthetic execution evidence recorded locally.'))
    saveState(state)
    return { decision }
  }
  if (resource === 'automations' && method === 'GET') return { automationAttempts: state.automations[requestId] ?? [] }
  if (resource === 'automations' && attemptId && method === 'POST') {
    const existing = state.automations[requestId]?.find((attempt) => attempt.id === attemptId)
    if (!existing) throw new Error('Automation attempt not found')
    const retried = { ...automation(requestId, existing.automationName), attemptNumber: existing.attemptNumber + 1 }
    state.automations[requestId].push(retried)
    saveState(state)
    return { automationAttempt: retried }
  }
  if (resource === 'artifacts' && method === 'GET') return { artifacts: state.artifacts[requestId] ?? [] }
  if (resource === 'audio-briefings' && method === 'POST') throw new Error('Audio is intentionally disabled in the anonymous recruiter sandbox; verified live-provider evidence is linked in the repository.')
  throw new Error('Recruiter sandbox operation not supported')
}
