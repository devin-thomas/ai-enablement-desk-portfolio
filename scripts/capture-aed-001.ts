import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { createApp } from '../apps/server/src/app.js'
import type { ServerEnv } from '../apps/server/src/config/env.js'

const root = process.cwd()
const apiPort = 3001
const webPort = 4173
const screenshot = resolve(root, 'docs/evidence/aed-001-persisted-queue.png')
await mkdir(resolve(root, 'docs/evidence'), { recursive: true })

const env: ServerEnv = { nodeEnv: 'development', port: apiPort, demoMode: true, demoDatabasePath: 'tmp/aed-001-capture/database', geminiModel: 'gemini-3.5-flash-lite', geminiSchemaVersion: '1', geminiPromptVersion: '1', geminiTimeoutMs: 20_000 }
const app = await createApp({ env })
await new Promise<void>((resolveListen) => app.server.listen(apiPort, '127.0.0.1', resolveListen))
await fetch(`http://127.0.0.1:${apiPort}/api/demo/reset`, { method: 'POST' })
const vite = await createViteServer({ root, server: { host: '127.0.0.1', port: webPort } })
await vite.listen()

try {
  await new Promise<void>((resolveCapture, rejectCapture) => {
    const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=5000', '--window-size=1440,1000',
      `--screenshot=${screenshot}`, `http://127.0.0.1:${webPort}`,
    ], { stdio: 'inherit' })
    chrome.on('error', rejectCapture)
    chrome.on('exit', (code) => code === 0 ? resolveCapture() : rejectCapture(new Error(`Chrome exited with code ${code}`)))
  })
  console.log(screenshot)
} finally {
  await vite.close()
  await new Promise<void>((resolveClose) => app.server.close(() => resolveClose()))
  await app.database.close()
}
