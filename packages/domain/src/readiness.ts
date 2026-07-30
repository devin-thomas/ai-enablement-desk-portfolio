export function calculateReadiness(input: { hasOutcome: boolean; hasDataSource: boolean; hasOwner: boolean; hasMetric: boolean; hasHumanValidator: boolean }): number {
  return [input.hasOutcome, input.hasDataSource, input.hasOwner, input.hasMetric, input.hasHumanValidator].filter(Boolean).length * 20
}
