import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHealth, listRequests } from './api'

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
})
