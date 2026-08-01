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
  constructor(readonly code: 'unavailable_key' | 'approval_required' | 'rate_limited' | 'payment_required' | 'invalid_audio' | 'provider_unavailable' | 'provider_error', message: string) { super(message) }
}

const FISH_MODEL = 's2.1-pro-free'
const FISH_REFERENCE_ID = '670480b2d7cd40f299c68789a4a77c4c'
const FISH_MAX_CONCURRENT_REQUESTS = 5
const FISH_MAX_QUEUED_REQUESTS = 10
const FISH_MAX_TEXT_CHARACTERS = 4_000
const FISH_MAX_AUDIO_BYTES = 5 * 1024 * 1024
const FISH_MIME_TYPE = 'audio/mpeg'

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  async acquire(): Promise<() => void> {
    if (this.active >= FISH_MAX_CONCURRENT_REQUESTS) {
      if (this.waiters.length >= FISH_MAX_QUEUED_REQUESTS) throw new AudioProviderError('provider_unavailable', 'Fish Audio is at capacity.')
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active += 1
    return () => {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

const fishSemaphore = new Semaphore()

export class FishAudioProvider implements AudioProvider {
  readonly name = 'fish-audio'
  readonly model = FISH_MODEL
  constructor(private readonly env: ServerEnv) {
    if (env.fishAudioModel && env.fishAudioModel !== FISH_MODEL) throw new Error(`FISH_AUDIO_MODEL must be ${FISH_MODEL}`)
  }

  async generate(text: string): Promise<AudioProviderResult> {
    if (!this.env.fishAudioApiKey) throw new AudioProviderError('unavailable_key', 'Fish Audio is not configured.')
    if (!this.env.fishVoicePreflightApproved) throw new AudioProviderError('approval_required', 'Fish Audio voice preflight approval is required.')
    if (text.length > FISH_MAX_TEXT_CHARACTERS) throw new AudioProviderError('provider_error', 'Fish Audio briefing text exceeds the configured limit.')
    const release = await fishSemaphore.acquire()
    try {
      try {
        const response = await fetch('https://api.fish.audio/v1/tts', {
          method: 'POST',
          headers: { authorization: `Bearer ${this.env.fishAudioApiKey}`, 'content-type': 'application/json', model: FISH_MODEL },
          body: JSON.stringify({ text, reference_id: FISH_REFERENCE_ID, format: 'mp3', normalize: true }),
          signal: AbortSignal.timeout(this.env.fishAudioTimeoutMs ?? 30_000),
        })
        if (response.status === 429) throw new AudioProviderError('rate_limited', 'Fish Audio rate limit reached.')
        if (response.status === 402) throw new AudioProviderError('payment_required', 'Fish Audio billing is required.')
        if ([401, 403, 404, 422].includes(response.status)) throw new AudioProviderError('provider_error', 'Fish Audio rejected the configured request.')
        if (!response.ok) throw new AudioProviderError('provider_unavailable', 'Fish Audio is unavailable.')
        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > FISH_MAX_AUDIO_BYTES) throw new AudioProviderError('invalid_audio', 'Fish Audio response exceeded the configured limit.')
        const bytes = await readBoundedBody(response, FISH_MAX_AUDIO_BYTES)
        if (!isMp3(bytes)) throw new AudioProviderError('invalid_audio', 'Fish Audio returned invalid audio bytes.')
        return { bytes, mimeType: FISH_MIME_TYPE, externalArtifactId: response.headers.get('x-request-id') }
      } catch (error) {
        if (error instanceof AudioProviderError) throw error
        if (isAbortError(error)) throw new AudioProviderError('provider_unavailable', 'Fish Audio timed out.')
        throw new AudioProviderError('provider_unavailable', 'Fish Audio is unavailable.')
      }
    } finally {
      release()
    }
  }
}

function isMp3(bytes: Uint8Array): boolean {
  let frameOffset = 0
  if (bytes.byteLength >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => (value & 0x80) !== 0)) return false
    const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]
    frameOffset = 10 + tagSize
  }
  if (bytes.byteLength < frameOffset + 4) return false
  const first = bytes[frameOffset]
  const second = bytes[frameOffset + 1]
  const third = bytes[frameOffset + 2]
  const version = (second >> 3) & 0x03
  const layer = (second >> 1) & 0x03
  const bitrate = (third >> 4) & 0x0f
  const sampleRate = (third >> 2) & 0x03
  if (first !== 0xff || (second & 0xe0) !== 0xe0 || version !== 3 || layer !== 1 || bitrate === 0 || bitrate === 15 || sampleRate === 3) return false
  const bitrateKbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrate]
  const sampleRateHz = [44_100, 48_000, 32_000][sampleRate]
  const padding = (third >> 1) & 0x01
  const frameLength = Math.floor((144_000 * bitrateKbps) / sampleRateHz) + padding
  return bytes.byteLength >= frameOffset + frameLength
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new AudioProviderError('invalid_audio', 'Fish Audio returned no audio body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      throw new AudioProviderError('invalid_audio', 'Fish Audio response exceeded the configured limit.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
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
    const status = providerError.code === 'unavailable_key' || providerError.code === 'approval_required' || providerError.code === 'provider_unavailable' ? 'unavailable' : 'failed'
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
