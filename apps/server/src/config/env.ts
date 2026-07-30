export type ServerEnv = {
  nodeEnv: string
  port: number
  demoMode: boolean
  geminiApiKey?: string
  geminiModel: string
  geminiSchemaVersion: string
  geminiPromptVersion: string
  geminiTimeoutMs: number
  n8nBaseUrl?: string
  n8nRequestSubmittedWebhook?: string
  n8nDecisionRecordedWebhook?: string
  n8nWebhookSecret?: string
  n8nRequestWorkflowVersion?: string
  n8nDecisionWorkflowVersion?: string
  automationMaxAttempts?: number
  automationRetryDelayMs?: number
  fishAudioApiKey?: string
  fishAudioModel?: string
  audioBriefingsEnabled?: boolean
  databaseUrl?: string
  demoDatabasePath: string
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() ? value : undefined
}

export function loadEnv(): ServerEnv {
  const portValue = Number(process.env.PORT ?? 3001)
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) throw new Error('PORT must be a valid TCP port')
  const geminiTimeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 20_000)
  if (!Number.isInteger(geminiTimeoutMs) || geminiTimeoutMs < 100 || geminiTimeoutMs > 120_000) throw new Error('GEMINI_TIMEOUT_MS must be between 100 and 120000')
  const automationMaxAttempts = Number(process.env.AUTOMATION_MAX_ATTEMPTS ?? 3)
  const automationRetryDelayMs = Number(process.env.AUTOMATION_RETRY_DELAY_MS ?? 250)
  if (!Number.isInteger(automationMaxAttempts) || automationMaxAttempts < 1 || automationMaxAttempts > 5) throw new Error('AUTOMATION_MAX_ATTEMPTS must be between 1 and 5')
  if (!Number.isInteger(automationRetryDelayMs) || automationRetryDelayMs < 0 || automationRetryDelayMs > 10_000) throw new Error('AUTOMATION_RETRY_DELAY_MS must be between 0 and 10000')
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: portValue,
    demoMode: process.env.DEMO_MODE !== 'false',
    geminiApiKey: optional('GEMINI_API_KEY'),
    geminiModel: optional('GEMINI_MODEL') ?? 'gemini-2.5-flash-lite',
    geminiSchemaVersion: optional('GEMINI_SCHEMA_VERSION') ?? '1',
    geminiPromptVersion: optional('GEMINI_PROMPT_VERSION') ?? '1',
    geminiTimeoutMs,
    n8nBaseUrl: optional('N8N_BASE_URL'),
    n8nRequestSubmittedWebhook: optional('N8N_REQUEST_SUBMITTED_WEBHOOK'),
    n8nDecisionRecordedWebhook: optional('N8N_DECISION_RECORDED_WEBHOOK') ?? optional('N8N_REQUEST_APPROVED_WEBHOOK'),
    n8nWebhookSecret: optional('N8N_WEBHOOK_SECRET'),
    n8nRequestWorkflowVersion: optional('N8N_REQUEST_WORKFLOW_VERSION') ?? '1.0.0',
    n8nDecisionWorkflowVersion: optional('N8N_DECISION_WORKFLOW_VERSION') ?? '1.0.0',
    automationMaxAttempts,
    automationRetryDelayMs,
    fishAudioApiKey: optional('FISH_AUDIO_API_KEY'),
    fishAudioModel: optional('FISH_AUDIO_MODEL') ?? 's2.1-pro-free',
    audioBriefingsEnabled: process.env.AUDIO_BRIEFINGS_ENABLED === 'true',
    databaseUrl: optional('DATABASE_URL'),
    demoDatabasePath: process.env.DEMO_DATABASE_PATH?.trim() || 'data/ai-enablement-demo',
  }
}
