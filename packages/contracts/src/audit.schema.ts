import { z } from 'zod'

export const auditEventSchema = z.object({
  requestId: z.string().min(1),
  actorType: z.enum(['requester', 'system', 'ai', 'human', 'workflow']),
  actorName: z.string().min(1),
  eventType: z.string().min(1),
  description: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type AuditEvent = z.infer<typeof auditEventSchema>

export const auditEventRecordSchema = auditEventSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
})

export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>
