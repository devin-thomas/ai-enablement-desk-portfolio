import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

const originUrl = 'https://api.azure.example/base'
const credential = 'worker-only-test-credential'

function environment(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('portfolio asset')) },
    AZURE_API_BASE_URL: originUrl,
    AZURE_ORIGIN_CREDENTIAL: credential,
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Azure origin proxy Worker', () => {
  it('forwards JSON methods, query strings, workspace cookies, and correlation information', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => new Response(JSON.stringify({ saved: true }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', upstreamFetch)
    const request = new Request('https://portfolio.example/api/requests?view=active', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'aed_workspace=session-42', 'x-aed-correlation-id': 'corr-42' },
      body: JSON.stringify({ title: 'Proxy request' }),
    })

    const response = await worker.fetch(request, environment(), {} as ExecutionContext)
    const upstream = upstreamFetch.mock.calls[0]?.[0] as Request

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ saved: true })
    expect(upstream.url).toBe('https://api.azure.example/base/api/requests?view=active')
    expect(upstream.method).toBe('POST')
    expect(upstream.headers.get('cookie')).toBe('aed_workspace=session-42')
    expect(upstream.headers.get('x-aed-correlation-id')).toBe('corr-42')
    expect(upstream.headers.get('x-aed-origin-credential')).toBe(credential)
    await expect(upstream.json()).resolves.toEqual({ title: 'Proxy request' })
  })

  it('does not leak unrelated cookies or arbitrary browser headers to the origin', async () => {
    const upstreamFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', upstreamFetch)
    const request = new Request('https://portfolio.example/api/requests', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer browser-token',
        cookie: 'analytics=visitor-1; aed_workspace=signed-workspace; preferences=compact',
        'x-untrusted-browser-header': 'must-not-leak',
      },
    })

    await worker.fetch(request, environment(), {} as ExecutionContext)
    const upstream = upstreamFetch.mock.calls[0]?.[0] as Request

    expect(upstream.headers.get('accept')).toBe('application/json')
    expect(upstream.headers.get('cookie')).toBe('aed_workspace=signed-workspace')
    expect(upstream.headers.has('authorization')).toBe(false)
    expect(upstream.headers.has('x-untrusted-browser-header')).toBe(false)
  })

  it('passes binary audio, Set-Cookie, content type, and upstream status through unchanged', async () => {
    const audio = new Uint8Array([0, 255, 17, 42])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(audio, { status: 206, headers: { 'content-type': 'audio/mpeg', 'set-cookie': 'workspace=renewed; HttpOnly' } })))

    const response = await worker.fetch(new Request('https://portfolio.example/api/artifacts/1/content'), environment(), {} as ExecutionContext)

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('set-cookie')).toBe('workspace=renewed; HttpOnly')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...audio])
  })

  it('returns upstream error responses unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422, headers: { 'content-type': 'application/json' } })))

    const response = await worker.fetch(new Request('https://portfolio.example/health'), environment(), {} as ExecutionContext)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'validation_failed' })
  })

  it('allows the dedicated original request narration action', async () => {
    const upstreamFetch = vi.fn(async () => Response.json({ artifact: { id: 'created' } }, { status: 201 }))
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await worker.fetch(new Request('https://portfolio.example/api/requests/11111111-1111-4111-8111-111111111111/original-request-narrations', { method: 'POST' }), environment(), {} as ExecutionContext)

    expect(response.status).toBe(201)
    expect((upstreamFetch.mock.calls[0]?.[0] as Request).method).toBe('POST')
  })

  it('does not follow or expose origin redirects carrying protected headers', async () => {
    const upstreamFetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.example/collect' } }))
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await worker.fetch(new Request('https://portfolio.example/api/requests', { headers: { cookie: 'aed_workspace=signed-workspace' } }), environment(), {} as ExecutionContext)
    const upstream = upstreamFetch.mock.calls[0]?.[0] as Request

    expect(upstream.redirect).toBe('manual')
    expect(upstream.headers.get('x-aed-origin-credential')).toBe(credential)
    expect(upstream.headers.get('cookie')).toBe('aed_workspace=signed-workspace')
    expect(response.status).toBe(502)
    expect(response.headers.has('location')).toBe(false)
    await expect(response.json()).resolves.toEqual({ error: 'origin_redirect_not_allowed' })
  })

  it('leaves disallowed routes to the existing asset and SPA handler', async () => {
    const assets = { fetch: vi.fn(async () => new Response('portfolio asset')) }
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await worker.fetch(new Request('https://portfolio.example/api'), environment({ ASSETS: assets }), {} as ExecutionContext)

    expect(await response.text()).toBe('portfolio asset')
    expect(assets.fetch).toHaveBeenCalledOnce()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('fails closed when origin configuration is missing or invalid', async () => {
    const request = new Request('https://portfolio.example/api/requests')

    for (const env of [environment({ AZURE_API_BASE_URL: undefined }), environment({ AZURE_API_BASE_URL: 'http://azure.example' }), environment({ AZURE_ORIGIN_CREDENTIAL: undefined })]) {
      const response = await worker.fetch(request, env, {} as ExecutionContext)
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({ error: 'origin_not_configured' })
    }
  })

  it('rejects an oversized streamed body when Content-Length is absent', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000))
        controller.enqueue(new Uint8Array(600_000))
        controller.close()
      },
    })
    const request = new Request('https://portfolio.example/api/requests', { method: 'POST', body: oversizedBody, duplex: 'half' })

    const response = await worker.fetch(request, environment(), {} as ExecutionContext)

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'request_too_large' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects unsupported API paths and methods before they reach Azure', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const routeResponse = await worker.fetch(new Request('https://portfolio.example/api/internal/debug'), environment(), {} as ExecutionContext)
    const methodResponse = await worker.fetch(new Request('https://portfolio.example/api/requests', { method: 'DELETE' }), environment(), {} as ExecutionContext)

    expect(routeResponse.status).toBe(404)
    expect(methodResponse.status).toBe(405)
    expect(methodResponse.headers.get('allow')).toBe('GET, POST, OPTIONS')
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
