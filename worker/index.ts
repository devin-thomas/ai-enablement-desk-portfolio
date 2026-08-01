type ProxyBindings = Pick<Env, 'ASSETS'> & {
  AZURE_API_BASE_URL?: string
  AZURE_ORIGIN_CREDENTIAL?: string
}

const MAX_REQUEST_BYTES = 1_000_000
const ORIGIN_TIMEOUT_MS = 20_000
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'range', 'x-aed-correlation-id'] as const

function isProxyNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/health'
}

function allowedMethods(pathname: string): readonly string[] | null {
  if (pathname === '/health') return ['GET', 'OPTIONS']
  if (pathname === '/api/requests') return ['GET', 'POST', 'OPTIONS']
  if (pathname === '/api/demo/reset') return ['POST', 'OPTIONS']
  if (/^\/api\/requests\/[0-9a-f-]+$/i.test(pathname)) return ['GET', 'OPTIONS']
  if (/^\/api\/requests\/[0-9a-f-]+\/(analyses|decisions)$/i.test(pathname)) return ['GET', 'POST', 'OPTIONS']
  if (/^\/api\/requests\/[0-9a-f-]+\/(audit-events|automations|artifacts)$/i.test(pathname)) return ['GET', 'OPTIONS']
  if (/^\/api\/requests\/[0-9a-f-]+\/(clarifications|audio-briefings)$/i.test(pathname)) return ['POST', 'OPTIONS']
  if (/^\/api\/requests\/[0-9a-f-]+\/automations\/[0-9a-f-]+\/retry$/i.test(pathname)) return ['POST', 'OPTIONS']
  if (/^\/api\/artifacts\/[0-9a-f-]+\/content$/i.test(pathname)) return ['GET', 'OPTIONS']
  return null
}

function originConfiguration(env: ProxyBindings): URL | null {
  const rawUrl = env.AZURE_API_BASE_URL?.trim()
  if (!rawUrl || !env.AZURE_ORIGIN_CREDENTIAL?.trim()) return null

  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && url.hostname ? url : null
  } catch {
    return null
  }
}

function failure(status: number, code: string, additionalHeaders?: HeadersInit): Response {
  const headers = new Headers(additionalHeaders)
  headers.set('cache-control', 'no-store')
  return Response.json({ error: code }, { status, headers })
}

function declaredRequestTooLarge(request: Request): boolean {
  const contentLength = request.headers.get('content-length')
  if (!contentLength) return false
  const parsedLength = Number(contentLength)
  return !Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_REQUEST_BYTES
}

async function readBoundedBody(request: Request): Promise<ArrayBuffer | Response | undefined> {
  if (!request.body) return undefined

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel('request body exceeds proxy limit')
        return failure(413, 'request_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new ArrayBuffer(totalBytes)
  const bodyBytes = new Uint8Array(body)
  let offset = 0
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function workspaceCookie(request: Request): string | null {
  for (const segment of request.headers.get('cookie')?.split(';') ?? []) {
    const cookie = segment.trim()
    const separator = cookie.indexOf('=')
    if (separator > 0 && cookie.slice(0, separator).trim() === 'aed_workspace') return cookie
  }
  return null
}

function upstreamHeaders(request: Request, credential: string): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const cookie = workspaceCookie(request)
  if (cookie) headers.set('cookie', cookie)
  headers.set('x-aed-origin-credential', credential)
  if (!headers.has('x-aed-correlation-id')) headers.set('x-aed-correlation-id', crypto.randomUUID())
  return headers
}

function upstreamUrl(origin: URL, requestUrl: URL): URL {
  const target = new URL(origin)
  target.pathname = `${origin.pathname.replace(/\/$/, '')}${requestUrl.pathname}`
  target.search = requestUrl.search
  return target
}

async function proxyRequest(request: Request, env: ProxyBindings, requestUrl: URL): Promise<Response> {
  const methods = allowedMethods(requestUrl.pathname)
  if (!methods) return failure(404, 'proxy_route_not_allowed')
  if (!methods.includes(request.method)) return failure(405, 'proxy_method_not_allowed', { allow: methods.join(', ') })

  const origin = originConfiguration(env)
  if (!origin) return failure(503, 'origin_not_configured')
  if (declaredRequestTooLarge(request)) return failure(413, 'request_too_large')

  const body = await readBoundedBody(request)
  if (body instanceof Response) return body

  const init: RequestInit = {
    method: request.method,
    headers: upstreamHeaders(request, env.AZURE_ORIGIN_CREDENTIAL!.trim()),
    redirect: 'manual',
    signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
  }
  if (body) init.body = body

  try {
    const upstream = await fetch(new Request(upstreamUrl(origin, requestUrl), init))
    if (upstream.status >= 300 && upstream.status < 400) return failure(502, 'origin_redirect_not_allowed')
    return upstream
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') return failure(504, 'origin_timeout')
    return failure(502, 'origin_unavailable')
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!isProxyNamespace(url.pathname)) return env.ASSETS.fetch(request)
    return proxyRequest(request, env, url)
  },
} satisfies ExportedHandler<ProxyBindings>
