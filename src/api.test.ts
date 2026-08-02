import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateOriginalRequestNarration, getHealth, listRequests } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('browser API requests', () => {
  it('includes workspace cookies on the local development API', async () => {
    const request = vi.fn(async () => Response.json({ requests: [] }))
    vi.stubGlobal('fetch', request)

    await expect(listRequests()).resolves.toEqual([])
    expect(request).toHaveBeenCalledWith('http://localhost:3001/api/requests', { credentials: 'include' })
  })

  it('parses the server-reported demo reset availability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: true,
      providers: { gemini: 'configured', n8n: 'disabled', fishAudio: 'disabled' },
      features: { demoReset: false },
    })))

    await expect(getHealth()).resolves.toMatchObject({ features: { demoReset: false } })
  })

  it('uses the dedicated original request narration action', async () => {
    const artifact = { id: 'a4f8527e-aefd-481c-a266-7bf629f42095', requestId: 'e4d59cd2-aa47-4ee3-b793-364d47a2658c', artifactType: 'original_request_narration', provider: 'fish/stub', status: 'success', mimeType: 'audio/mpeg', byteLength: 12, externalArtifactId: null, sourceAnalysisRunId: null, createdAt: '2026-08-01T00:00:00.000Z', contentUrl: '/api/artifacts/a4f8527e-aefd-481c-a266-7bf629f42095/content' }
    const request = vi.fn(async () => Response.json({ artifact }))
    vi.stubGlobal('fetch', request)

    await expect(generateOriginalRequestNarration(artifact.requestId)).resolves.toEqual(artifact)
    expect(request).toHaveBeenCalledWith(`http://localhost:3001/api/requests/${artifact.requestId}/original-request-narrations`, { method: 'POST', credentials: 'include' })
  })
})
