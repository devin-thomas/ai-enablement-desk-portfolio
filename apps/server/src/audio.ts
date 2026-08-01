import { randomUUID } from 'node:crypto'
import type { ArtifactRecord } from '@ai-enablement/contracts'
import type { ServerEnv } from './config/env.js'
import type { Database } from './database.js'
import { insertAutomationAttempt } from './automations.js'

export type AudioProviderResult = { bytes: Uint8Array; mimeType: string; externalArtifactId: string | null }

export interface AudioProvider {
  readonly name: string
  readonly model: string
  generate(text: string): Promise<AudioProviderResult>
}

export class AudioProviderError extends Error {
  constructor(readonly code: 'unavailable_key' | 'rate_limited' | 'payment_required' | 'invalid_audio' | 'provider_error', message: string) { super(message) }
}

export class FishAudioProvider implements AudioProvider {
  readonly name = 'fish-audio'
  readonly model: string
  constructor(private readonly env: ServerEnv) { this.model = env.fishAudioModel ?? 's2-pro' }

  async generate(text: string): Promise<AudioProviderResult> {
    if (!this.env.fishAudioApiKey) throw new AudioProviderError('unavailable_key', 'Fish Audio is not configured.')
    let response: Response
    try {
      response = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.env.fishAudioApiKey}`, 'content-type': 'application/json', model: this.model },
        body: JSON.stringify({ text, format: 'mp3', normalize: true }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new AudioProviderError('provider_error', 'Fish Audio request failed.')
    }
    if (response.status === 429) throw new AudioProviderError('rate_limited', 'Fish Audio rate limit reached.')
    if (response.status === 402) throw new AudioProviderError('payment_required', 'Fish Audio billing is required.')
    if (!response.ok) throw new AudioProviderError('provider_error', `Fish Audio returned HTTP ${response.status}.`)
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? ''
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!mimeType.startsWith('audio/') || bytes.byteLength === 0) throw new AudioProviderError('invalid_audio', 'Fish Audio returned no valid audio bytes.')
    return { bytes, mimeType, externalArtifactId: response.headers.get('x-request-id') }
  }
}

type ArtifactRow = {
  id: string
  request_id: string
  artifact_type: 'audio_briefing'
  provider: string
  status: 'success'
  mime_type: string
  byte_length: number
  external_artifact_id: string | null
  source_analysis_run_id: string
  created_at: Date | string
  artifact_data?: Uint8Array
}

export class AudioRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message) }
}

export async function generateAudioBriefing(database: Database, env: ServerEnv, provider: AudioProvider, workspaceId: string, requestId: string): Promise<ArtifactRecord> {
  const requestResult = await database.query<{ id: string; synthetic_demo_safe: boolean }>('select id, synthetic_demo_safe from ai_requests where id = $1 and workspace_id = $2', [requestId, workspaceId])
  if (requestResult.rows.length === 0) throw new AudioRequestError(404, 'Request not found', 'request_not_found')
  if (!requestResult.rows[0].synthetic_demo_safe) throw new AudioRequestError(403, 'Audio is restricted to explicitly synthetic demo-safe requests.', 'request_not_demo_safe')
  const analysisResult = await database.query<{ id: string; summary: string }>("select id, summary from analysis_runs where request_id = $1 and outcome = 'success' order by created_at desc, id desc limit 1", [requestId])
  if (analysisResult.rows.length === 0) throw new AudioRequestError(409, 'A successful written reviewer summary is required.', 'analysis_required')
  const analysis = analysisResult.rows[0]
  const correlationId = randomUUID()
  const idempotencyKey = `audio:${analysis.id}`

  const existing = await database.query<ArtifactRow>('select * from artifacts where request_id = $1 and source_analysis_run_id = $2 and status = $3 limit 1', [requestId, analysis.id, 'success'])
  if (existing.rows[0]) return mapArtifact(existing.rows[0])
  if (!env.audioBriefingsEnabled) {
    await recordAudioFailure(database, requestId, correlationId, idempotencyKey, provider, 'disabled', 'audio_disabled')
    throw new AudioRequestError(409, 'Audio briefings are disabled; the written summary remains authoritative.', 'audio_disabled')
  }

  let generated: AudioProviderResult
  try { generated = await provider.generate(analysis.summary) }
  catch (error) {
    const providerError = error instanceof AudioProviderError ? error : new AudioProviderError('provider_error', 'Audio provider failed.')
    const status = providerError.code === 'unavailable_key' ? 'unavailable' : 'failed'
    await recordAudioFailure(database, requestId, correlationId, idempotencyKey, provider, status, providerError.code)
    throw new AudioRequestError(status === 'unavailable' ? 503 : 502, providerError.message, providerError.code)
  }
  if (!generated.mimeType.startsWith('audio/') || generated.bytes.byteLength === 0) {
    await recordAudioFailure(database, requestId, correlationId, idempotencyKey, provider, 'failed', 'invalid_audio')
    throw new AudioRequestError(502, 'No valid audio was produced.', 'invalid_audio')
  }

  return database.transaction(async (transaction) => {
    const result = await transaction.query<ArtifactRow>(`insert into artifacts (
      request_id, artifact_type, provider, status, artifact_data, mime_type, byte_length, external_artifact_id, source_analysis_run_id
    ) values ($1,'audio_briefing',$2,'success',$3,$4,$5,$6,$7) returning *`, [requestId, `${provider.name}/${provider.model}`, Buffer.from(generated.bytes), generated.mimeType, generated.bytes.byteLength, generated.externalArtifactId, analysis.id])
    const artifact = mapArtifact(result.rows[0])
    await insertAutomationAttempt(transaction, { requestId, automationName: 'generate-audio-briefing', workflowVersion: 'trusted-server-v1', correlationId, idempotencyKey, status: 'success', externalExecutionId: generated.externalArtifactId, payload: { analysisRunId: analysis.id, artifactId: artifact.id } })
    await transaction.query(`insert into audit_events (request_id, actor_type, actor_name, event_type, description, metadata)
      values ($1,'workflow',$2,'audio_briefing_generated','A real audio briefing artifact was persisted.',$3::jsonb)`, [requestId, provider.name, JSON.stringify({ artifactId: artifact.id, byteLength: artifact.byteLength, mimeType: artifact.mimeType, analysisRunId: analysis.id })])
    return artifact
  })
}

async function recordAudioFailure(database: Database, requestId: string, correlationId: string, idempotencyKey: string, provider: AudioProvider, status: 'disabled' | 'unavailable' | 'failed', code: string): Promise<void> {
  await database.transaction(async (transaction) => {
    await insertAutomationAttempt(transaction, { requestId, automationName: 'generate-audio-briefing', workflowVersion: 'trusted-server-v1', correlationId, idempotencyKey: `${idempotencyKey}:${randomUUID()}`, status, errorCode: code })
    await transaction.query(`insert into audit_events (request_id, actor_type, actor_name, event_type, description, metadata)
      values ($1,'workflow',$2,'audio_briefing_unavailable','Written summary retained; no audio artifact was produced.',$3::jsonb)`, [requestId, provider.name, JSON.stringify({ status, errorCode: code })])
  })
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id, requestId: row.request_id, artifactType: row.artifact_type, provider: row.provider, status: row.status,
    mimeType: row.mime_type, byteLength: Number(row.byte_length), externalArtifactId: row.external_artifact_id,
    sourceAnalysisRunId: row.source_analysis_run_id, createdAt: new Date(row.created_at).toISOString(), contentUrl: `/api/artifacts/${row.id}/content`,
  }
}

export async function listArtifacts(database: Database, workspaceId: string, requestId: string): Promise<ArtifactRecord[]> {
  const result = await database.query<ArtifactRow>("select artifacts.* from artifacts join ai_requests on ai_requests.id = artifacts.request_id where artifacts.request_id = $1 and ai_requests.workspace_id = $2 and artifacts.status = 'success' and artifacts.artifact_data is not null order by artifacts.created_at", [requestId, workspaceId])
  return result.rows.map(mapArtifact)
}

export async function getArtifactContent(database: Database, workspaceId: string, artifactId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const result = await database.query<ArtifactRow>('select artifacts.* from artifacts join ai_requests on ai_requests.id = artifacts.request_id where artifacts.id = $1 and ai_requests.workspace_id = $2 and artifacts.status = $3 and artifacts.artifact_data is not null', [artifactId, workspaceId, 'success'])
  const row = result.rows[0]
  if (!row?.artifact_data || !row.mime_type) return null
  return { bytes: row.artifact_data, mimeType: row.mime_type }
}
