import {
  requestCreateResponseSchema,
  requestDetailResponseSchema,
  requestListResponseSchema,
  analysisListResponseSchema,
  analysisRunResponseSchema,
  clarificationAnswerResponseSchema,
  type AnalysisRun,
  type ClarificationAnswerRecord,
  type ClarificationAnswerSubmission,
  decisionListResponseSchema,
  decisionResponseSchema,
  type DecisionRecord,
  type HumanDecision,
  type RequestDetail,
  type RequestRecord,
  type RequestSubmission,
  automationListResponseSchema,
  artifactListResponseSchema,
  artifactResponseSchema,
  automationAttemptResponseSchema,
  type AutomationAttempt,
  type ArtifactRecord,
} from '@ai-enablement/contracts'
import { z } from 'zod'
import { recruiterDemoRequest } from './recruiterDemoApi'

const apiBaseUrl = import.meta.env.DEV ? import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001' : ''
export const isRecruiterDemo = import.meta.env.MODE === 'recruiter'
const healthSchema = z.object({
  ok: z.boolean(),
  providers: z.object({
    gemini: z.enum(['configured', 'unavailable_key', 'approval_required', 'demo_fixture']),
    n8n: z.enum(['configured', 'disabled', 'unavailable_secret', 'demo_evidence']),
    fishAudio: z.enum(['configured', 'disabled', 'unavailable_key', 'approval_required']),
  }),
})

async function apiRequest(path: string, init?: RequestInit): Promise<unknown> {
  if (isRecruiterDemo) return recruiterDemoRequest(path, init)
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...init, credentials: 'include' })
  } catch {
    throw new Error('The request service is unavailable. Check the server and try again.')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${response.status})`
    throw new Error(message)
  }
  return body
}

export async function listRequests(): Promise<RequestRecord[]> {
  return requestListResponseSchema.parse(await apiRequest('/api/requests')).requests
}

export async function getHealth(): Promise<z.infer<typeof healthSchema>> {
  return healthSchema.parse(await apiRequest('/health'))
}

export async function getRequest(id: string): Promise<RequestDetail> {
  return requestDetailResponseSchema.parse(await apiRequest(`/api/requests/${id}`)).request
}

export async function submitRequest(submission: RequestSubmission): Promise<RequestDetail> {
  return requestCreateResponseSchema.parse(await apiRequest('/api/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submission),
  })).request
}

export async function resetDemo(): Promise<RequestRecord[]> {
  return requestListResponseSchema.parse(await apiRequest('/api/demo/reset', { method: 'POST' })).requests
}

export async function listAnalyses(requestId: string): Promise<{ analyses: AnalysisRun[]; clarificationAnswers: ClarificationAnswerRecord[] }> {
  return analysisListResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/analyses`))
}

export async function runAnalysis(requestId: string): Promise<AnalysisRun> {
  return analysisRunResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/analyses`, { method: 'POST' })).analysisRun
}

export async function answerClarification(requestId: string, submission: ClarificationAnswerSubmission): Promise<ClarificationAnswerRecord> {
  return clarificationAnswerResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/clarifications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission),
  })).clarificationAnswer
}

export async function listDecisions(requestId: string): Promise<DecisionRecord[]> {
  return decisionListResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/decisions`)).decisions
}

export async function recordDecision(requestId: string, submission: HumanDecision): Promise<DecisionRecord> {
  return decisionResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission),
  })).decision
}

export async function listAutomations(requestId: string): Promise<AutomationAttempt[]> {
  return automationListResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/automations`)).automationAttempts
}

export async function retryAutomation(requestId: string, attemptId: string): Promise<AutomationAttempt> {
  return automationAttemptResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/automations/${attemptId}/retry`, { method: 'POST' })).automationAttempt
}

export async function listArtifacts(requestId: string): Promise<ArtifactRecord[]> {
  return artifactListResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/artifacts`)).artifacts
}

export async function generateAudioBriefing(requestId: string): Promise<ArtifactRecord> {
  return artifactResponseSchema.parse(await apiRequest(`/api/requests/${requestId}/audio-briefings`, { method: 'POST' })).artifact
}
