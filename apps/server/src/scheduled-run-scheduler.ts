import { randomUUID } from 'node:crypto'
import { nextScheduleDates } from './schedule.js'
import type { ScheduledStore } from './scheduled-store.js'
import type { WorkspaceSyncService } from './workspace-sync.js'
import type { WorkspaceAccess } from './workspace-access.js'

/** Owns the durable scheduling lease and turns due slots into immutable runs.
 * It never executes a run: that is the run orchestrator's responsibility. */
export class ScheduledRunScheduler {
  private readonly owner = randomUUID()
  private initialized = false

  constructor(
    private readonly records: ScheduledStore,
    private readonly sync: WorkspaceSyncService,
    private readonly workspaceAccess: WorkspaceAccess,
    private readonly isActive: (runId: string) => boolean,
  ) {}

  get ready(): boolean { return this.initialized }
  stop(): void { this.records.releaseLease(this.owner) }

  tick(now: Date, draining: boolean): boolean {
    if (!this.records.lease(this.owner)) return false
    if (!this.initialized) {
      this.records.recover()
      for (const pending of this.sync.pendingRecovery()) this.workspaceAccess.pause(pending.root, pending.reason)
      this.initialized = true
    }
    if (draining) return false
    this.enqueueDue(now)
    this.expireApprovals(now)
    return true
  }

  private enqueueDue(now: Date): void {
    for (const row of this.records.db
      .prepare('SELECT id,next_run_at FROM scheduled_tasks WHERE enabled=1 AND archived=0 AND next_run_at<=? ORDER BY next_run_at LIMIT 100')
      .all(now.toISOString()) as Array<{ id: string; next_run_at: string }>) {
      const task = this.records.getTask(row.id)
      const key = `schedule:${task.id}:${row.next_run_at}`
      this.records.db.exec('BEGIN IMMEDIATE')
      try {
        const missed = now.getTime() - Date.parse(row.next_run_at) > 30000
        const busy = this.records.active(task.id)
        const pending = this.records.listRuns({ taskId: task.id, status: 'queued', limit: 1 }).total > 0
        this.records.enqueue(
          task, '定时触发', key, row.next_run_at,
          missed || (busy && (task.overlap === 'skip' || pending)) ? 'skipped' : 'queued',
          missed ? '触发窗口已错过，已记录并从下一周期继续' : busy ? '上次尚未结束，按重叠策略处理' : '',
        )
        this.records.db.prepare('UPDATE scheduled_tasks SET next_run_at=? WHERE id=? AND next_run_at=?')
          .run(nextScheduleDates(task.schedule, now)[0]!, task.id, row.next_run_at)
        this.records.db.exec('COMMIT')
      } catch (error) {
        this.records.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  private expireApprovals(now: Date): void {
    for (const row of this.records.db
      .prepare("SELECT id,run_id FROM scheduled_actions WHERE status='awaiting_approval'")
      .all() as Array<{ id: string; run_id: string }>) {
      const action = this.records.action(row.id)
      if (action.expiresAt <= now.toISOString()
        && this.records.updateAction(action.id, { status: 'expired', error: '审批已过期' }, 'awaiting_approval')
        && !this.isActive(action.runId)) this.records.updateRun(action.runId, { status: 'queued' })
    }
  }
}
