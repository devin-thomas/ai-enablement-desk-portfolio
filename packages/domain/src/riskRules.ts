import type { RequestSubmission } from '@ai-enablement/contracts'

export type RiskFlag = { category: 'privacy' | 'accuracy' | 'ownership' | 'security'; severity: 'low' | 'medium' | 'high'; explanation: string }

export function assessRisk(request: RequestSubmission): RiskFlag[] {
  const text = `${request.businessProblem} ${request.dataSources}`.toLowerCase()
  const flags: RiskFlag[] = []
  if (/medical|health|performance|employee|personnel|customer/.test(text)) flags.push({ category: 'privacy', severity: 'high', explanation: 'Request may involve sensitive personal or workforce information.' })
  if (/urgent|approve|automatically|decision|safety|critical/.test(text)) flags.push({ category: 'accuracy', severity: 'high', explanation: 'Output may influence an operational decision and requires human validation.' })
  if (request.dataSources.some((source) => /public|unknown|external/.test(source.toLowerCase()))) flags.push({ category: 'security', severity: 'medium', explanation: 'Data source ownership and access controls need confirmation.' })
  if (!request.currentProcess) flags.push({ category: 'ownership', severity: 'medium', explanation: 'Current process and accountable process owner are not yet documented.' })
  return flags
}

export function isHumanEscalationRequired(flags: RiskFlag[]): boolean {
  return flags.some((flag) => flag.severity === 'high' && (flag.category === 'privacy' || flag.category === 'accuracy'))
}
