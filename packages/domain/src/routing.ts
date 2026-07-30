import type { AIRequestAnalysis } from '@ai-enablement/contracts'

export function recommendRoute(input: Pick<AIRequestAnalysis, 'requestType' | 'missingInformation' | 'riskFlags' | 'readinessScore'>): AIRequestAnalysis['recommendedDisposition'] {
  if (input.requestType === 'tool_access') return 'tool_access_review'
  if (input.riskFlags.some((flag) => flag.severity === 'high' && flag.category === 'privacy')) return 'decline'
  if (input.missingInformation.length > 0 || input.readinessScore < 60) return 'needs_clarification'
  if (input.riskFlags.some((flag) => flag.severity === 'high')) return 'defer'
  return 'ready_for_discovery'
}
