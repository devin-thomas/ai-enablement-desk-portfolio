import { afterEach, describe, expect, it, vi } from 'vitest'
import { listRequests } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('browser API requests', () => {
  it('includes workspace cookies on the local development API', async () => {
    const request = vi.fn(async () => Response.json({ requests: [] }))
    vi.stubGlobal('fetch', request)

    await expect(listRequests()).resolves.toEqual([])
    expect(request).toHaveBeenCalledWith('http://localhost:3001/api/requests', { credentials: 'include' })
  })
})
