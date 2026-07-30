import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const findings = []
const forbiddenPaths = [/(^|\/)\.env(?:\.|$)/i, /(^|\/)(?:service[-_]?account|credentials?)[^/]*\.json$/i, /\.(?:pem|p12|pfx|key|log|sqlite3?|dump)$/i]
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Google API key', /AIza[0-9A-Za-z_-]{20,}/],
  ['generic bearer token', /Bearer\s+[0-9A-Za-z._-]{20,}/],
  ['assigned secret', /(?:API_KEY|SECRET|TOKEN)\s*=\s*[^\s#][^\r\n]*/],
]
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.sql', '.ts', '.tsx', '.txt', '.yml', '.yaml'])

for (const path of tracked) {
  if (!existsSync(path)) continue
  if (path !== '.env.example' && forbiddenPaths.some((pattern) => pattern.test(path))) findings.push(`${path}: forbidden public path`)
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : ''
  if (!textExtensions.has(extension)) continue
  const text = readFileSync(path, 'utf8')
  for (const [label, pattern] of secretPatterns) if (pattern.test(text)) findings.push(`${path}: possible ${label}`)
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  for (const email of emails) if (!email.endsWith('@example.com')) findings.push(`${path}: review email address ${email}`)
  if (/\bIEM\b/.test(text)) findings.push(`${path}: internal company identifier`)
}

if (findings.length) {
  console.error(`Public-safety scan failed:\n${findings.map((item) => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`Public-safety scan passed for ${tracked.length} tracked files. Binary media still requires the documented manual review.`)
