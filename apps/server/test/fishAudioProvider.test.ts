import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioProviderError, FishAudioProvider } from '../src/audio.js'
import type { ServerEnv } from '../src/config/env.js'

const env: ServerEnv = {
  nodeEnv: 'test', port: 3001, demoMode: true, demoDatabasePath: 'unused', geminiModel: 'stub', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 1000,
  fishAudioApiKey: 'synthetic-test-key', fishAudioModel: 's2.1-pro-free', fishAudioTimeoutMs: 1000, fishVoicePreflightApproved: true,
}

function validMp3Frame(): Uint8Array {
  const bytes = new Uint8Array(417)
  bytes.set([0xff, 0xfb, 0x90, 0x64])
  return bytes
}

describe('Fish Audio provider contract validation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses only the fixed free model and requested public voice, then normalizes validated MP3 output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(validMp3Frame(), { headers: { 'content-type': 'application/octet-stream', 'x-request-id': 'fish-request' } }))
    const provider = new FishAudioProvider(env)
    await expect(provider.generate('Synthetic demo-safe briefing.')).resolves.toMatchObject({ mimeType: 'audio/mpeg', externalArtifactId: 'fish-request' })
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(options.headers).toMatchObject({ model: 's2.1-pro-free' })
    expect(JSON.parse(String(options.body))).toEqual({ text: 'Synthetic demo-safe briefing.', reference_id: '670480b2d7cd40f299c68789a4a77c4c', format: 'mp3', normalize: true })
  })

  it.each([[new Response(new Uint8Array([0x49, 0x44, 0x33, 4])), 'invalid_audio'], [new Response(new Uint8Array([0xff, 0xe0, 0, 0])), 'invalid_audio'], [new Response(null, { status: 422 }), 'provider_error'], [new Response(null, { status: 429 }), 'rate_limited'], [new Response(null, { status: 503 }), 'provider_unavailable']] as const)('does not accept unsafe Fish output', async (response, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(new FishAudioProvider(env).generate('Synthetic demo-safe briefing.')).rejects.toMatchObject<Partial<AudioProviderError>>({ code })
  })

  it('rejects a configuration that would change the fixed free model', () => {
    expect(() => new FishAudioProvider({ ...env, fishAudioModel: 's2.1-pro' })).toThrow('FISH_AUDIO_MODEL must be s2.1-pro-free')
  })

  it('does not call Fish until the exact voice preflight gate is approved', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(new FishAudioProvider({ ...env, fishVoicePreflightApproved: false }).generate('Synthetic demo-safe briefing.')).rejects.toMatchObject<Partial<AudioProviderError>>({ code: 'approval_required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds text and response bytes before accepting provider output', async () => {
    const provider = new FishAudioProvider(env)
    await expect(provider.generate('x'.repeat(4_001))).rejects.toMatchObject<Partial<AudioProviderError>>({ code: 'provider_error' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(validMp3Frame(), { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } }))
    await expect(provider.generate('Synthetic demo-safe briefing.')).rejects.toMatchObject<Partial<AudioProviderError>>({ code: 'invalid_audio' })
  })

  it('classifies a provider timeout without leaking the provider error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('synthetic timeout', 'TimeoutError'))
    await expect(new FishAudioProvider(env).generate('Synthetic demo-safe briefing.')).rejects.toMatchObject<Partial<AudioProviderError>>({ code: 'provider_unavailable' })
  })

  it('holds no more than five permits until each streaming body is validated', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controllers.push(controller) },
    })))
    const provider = new FishAudioProvider(env)
    const generation = Array.from({ length: 6 }, (_, index) => provider.generate(`Synthetic briefing ${index}`))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    expect(controllers).toHaveLength(5)
    for (const controller of controllers.splice(0)) {
      controller.enqueue(validMp3Frame())
      controller.close()
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    const finalController = controllers[0]
    finalController.enqueue(validMp3Frame())
    finalController.close()
    await expect(Promise.all(generation)).resolves.toHaveLength(6)
  })
})
