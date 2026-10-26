import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, type DatabaseRow as Row } from '../db-values.js'
import type { AdminAccountRecord, AuditLogRecord } from '../types.js'

export class AuditRepository {
  constructor(readonly db: DatabaseSync) {}

  createAuditLog(input: { actor?: AdminAccountRecord | null; action: string; targetType?: string; targetId?: string; summary: string; details?: Record<string, unknown>; ipAddress?: string }): AuditLogRecord {
    const id = randomUUID(), timestamp = now(), actor = input.actor
    this.db.prepare(`INSERT INTO audit_logs (id, actor_account_id, actor_login_name, actor_display_name, action, target_type, target_id, summary, details_json, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, actor?.id ?? '', actor?.loginName ?? '', actor?.displayName ?? '', input.action, input.targetType ?? '', input.targetId ?? '', input.summary, JSON.stringify(input.details ?? {}), input.ipAddress ?? '', timestamp)
    return this.getAuditLog(id)
  }
  listAuditLogs(input: { limit?: number; offset?: number; actorAccountId?: string; action?: string; query?: string } = {}): { items: AuditLogRecord[]; total: number } {
    const filters: string[] = [], params: Array<string | number> = []
    if (input.actorAccountId) { filters.push('actor_account_id = ?'); params.push(input.actorAccountId) }
    if (input.action) { filters.push('action = ?'); params.push(input.action) }
    if (input.query?.trim()) {
      filters.push('(summary LIKE ? ESCAPE \'\\\' OR target_id LIKE ? OR actor_login_name LIKE ? OR actor_display_name LIKE ?)')
      const escaped = input.query.trim().replace(/[\\%_]/gu, value => `\\${value}`), plain = `%${input.query.trim()}%`
      params.push(`%${escaped}%`, plain, plain, plain)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`).get(...params) as Row).count)
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50))), offset = Math.max(0, Math.trunc(input.offset ?? 0))
    return { items: (this.db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[]).map(this.auditLog), total }
  }
  getAuditLog(id: string): AuditLogRecord {
    const row = this.db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Audit log not found')
    return this.auditLog(row)
  }
  private auditLog = (row: Row): AuditLogRecord => ({
    id: String(row.id), actorAccountId: String(row.actor_account_id), actorLoginName: String(row.actor_login_name), actorDisplayName: String(row.actor_display_name),
    action: String(row.action), targetType: String(row.target_type), targetId: String(row.target_id), summary: String(row.summary),
    details: (() => { try { return JSON.parse(String(row.details_json)) as Record<string, unknown> } catch { return {} } })(),
    ipAddress: String(row.ip_address), createdAt: String(row.created_at),
  })
}
