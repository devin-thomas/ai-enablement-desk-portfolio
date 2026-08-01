export const nativeFetch = globalThis.fetch.bind(globalThis)

const cookies = new Map<string, string>()

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  const cookie = cookies.get(url.hostname)
  if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
  const response = await nativeFetch(request, { headers })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookies.set(url.hostname, setCookie.split(';')[0])
  return response
}
