import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, type DatabaseRow as Row } from '../db-values.js'
import type { ProvisioningJobRecord } from '../types.js'

export class ProvisioningRepository {
  constructor(readonly db: DatabaseSync) {}

  createProvisioningJob(request: Record<string, unknown>): ProvisioningJobRecord {
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO provisioning_jobs (id, status, request_json, created_at, updated_at) VALUES (?, 'starting', ?, ?, ?)`)
      .run(id, JSON.stringify(request), timestamp, timestamp)
    return this.getProvisioningJob(id)
  }

  getProvisioningJob(id: string): ProvisioningJobRecord {
    const row = this.db.prepare('SELECT * FROM provisioning_jobs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Provisioning job not found')
    return this.provisioningJob(row)
  }

  getProvisioningRequest(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT request_json FROM provisioning_jobs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Provisioning job not found')
    return JSON.parse(String(row.request_json)) as Record<string, unknown>
  }

  listProvisioningJobs(): ProvisioningJobRecord[] {
    return (this.db.prepare('SELECT * FROM provisioning_jobs ORDER BY created_at DESC LIMIT 50').all() as Row[]).map(this.provisioningJob)
  }

  updateProvisioningJob(id: string, update: Partial<{ status: ProvisioningJobRecord['status']; qrUrl: string; expiresAt: string; error: string; botId: string }>): ProvisioningJobRecord {
    const current = this.getProvisioningJob(id)
    this.db.prepare('UPDATE provisioning_jobs SET status = ?, qr_url = ?, expires_at = ?, error = ?, bot_id = ?, updated_at = ? WHERE id = ?')
      .run(update.status ?? current.status, update.qrUrl ?? current.qrUrl, update.expiresAt ?? current.expiresAt, update.error ?? current.error, (update.botId ?? current.botId) || null, now(), id)
    return this.getProvisioningJob(id)
  }

  failInterruptedProvisioningJobs(): void {
    this.db.prepare(`UPDATE provisioning_jobs SET status = 'failed', qr_url = '', error = '服务重启中断了扫码注册，请重新发起', updated_at = ? WHERE status IN ('starting', 'waiting_scan', 'creating')`).run(now())
  }

  private provisioningJob = (row: Row): ProvisioningJobRecord => ({
    id: String(row.id), status: String(row.status) as ProvisioningJobRecord['status'], qrUrl: String(row.qr_url), expiresAt: String(row.expires_at), error: String(row.error), botId: String(row.bot_id ?? ''), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })
}
