import { DatabaseSync } from 'node:sqlite'
import { createTaskSnapshot, transitionTask, type TaskEvent } from '@codycodeagent/cody-web-core/task'
import { jsonValue, type DatabaseRow as Row } from '../db-values.js'
import type { HubTaskProgress, HubTaskRecord, HubTaskResult } from '../types.js'

export class HubTaskRepository {
  constructor(readonly db: DatabaseSync) {}

  createHubTask(input: {
    id?: string
    kind: string
    origin: string
    principal: string
    idempotencyKey: string
    taskInput: Record<string, unknown>
    botId?: string
    sceneId?: string
    threadChannelId?: string
    sourceKind?: string
    sourceId?: string
  }): HubTaskRecord {
    const task = createTaskSnapshot({
      ...(input.id ? { id: input.id } : {}),
      kind: input.kind,
      origin: input.origin,
      principal: input.principal,
      idempotencyKey: input.idempotencyKey,
      input: input.taskInput,
    })
    this.db.prepare(`INSERT INTO hub_tasks (
      id, kind, origin, principal, idempotency_key, status, input_json, progress_json, result_json, error, revision,
      bot_id, scene_id, thread_channel_id, source_kind, source_id, created_at, updated_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'null', 'null', NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(task.id, task.kind, task.origin, task.principal, task.idempotencyKey, task.status, JSON.stringify(task.input).slice(0, 1_000_000), task.revision,
        input.botId ?? '', input.sceneId ?? '', input.threadChannelId ?? '', input.sourceKind ?? '', input.sourceId ?? '', task.createdAtIso, task.updatedAtIso)
    return this.getHubTask(task.id)
  }

  getHubTask(id: string): HubTaskRecord {
    const row = this.db.prepare('SELECT * FROM hub_tasks WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Task not found')
    return this.hubTask(row)
  }

  findHubTask(origin: string, idempotencyKey: string): HubTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_tasks WHERE origin = ? AND idempotency_key = ?').get(origin, idempotencyKey) as Row | undefined
    return row ? this.hubTask(row) : null
  }

  listHubTasks(input: { status?: HubTaskRecord['status']; origin?: string; limit?: number } = {}): HubTaskRecord[] {
    const filters: string[] = [], params: Array<string | number> = []
    if (input.status) { filters.push('status = ?'); params.push(input.status) }
    if (input.origin) { filters.push('origin = ?'); params.push(input.origin) }
    params.push(Math.min(500, Math.max(1, input.limit ?? 100)))
    return (this.db.prepare(`SELECT * FROM hub_tasks ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...params) as Row[]).map(this.hubTask)
  }

  latestHubTaskForSource(sourceKind: string, sourceId: string): HubTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_tasks WHERE source_kind = ? AND source_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sourceKind, sourceId) as Row | undefined
    return row ? this.hubTask(row) : null
  }

  transitionHubTask(id: string, event: TaskEvent<HubTaskProgress, HubTaskResult>): HubTaskRecord {
    const current = this.getHubTask(id)
    const next = transitionTask(current, event)
    const changed = this.db.prepare(`UPDATE hub_tasks SET status = ?, progress_json = ?, result_json = ?, error = ?, revision = ?, updated_at = ?, started_at = ?, completed_at = ?
      WHERE id = ? AND revision = ?`).run(
        next.status, JSON.stringify(next.progress), JSON.stringify(next.result), next.error, next.revision, next.updatedAtIso,
        next.startedAtIso ?? null, next.completedAtIso ?? null, id, current.revision,
      ).changes
    if (!changed) throw new Error('Task was updated concurrently')
    return this.getHubTask(id)
  }

  updateHubTaskProgressForSource(sourceKind: string, sourceId: string, progress: HubTaskProgress): HubTaskRecord | null {
    const task = this.latestHubTaskForSource(sourceKind, sourceId)
    if (!task || (task.status !== 'running' && task.status !== 'awaiting_approval')) return task
    return this.transitionHubTask(task.id, { type: 'progress', progress })
  }

  private hubTask = (row: Row): HubTaskRecord => ({
    id: String(row.id), kind: String(row.kind), origin: String(row.origin), principal: String(row.principal), idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as HubTaskRecord['status'], input: jsonValue<Record<string, unknown>>(row.input_json, {}),
    progress: jsonValue<HubTaskProgress | null>(row.progress_json, null), result: jsonValue<HubTaskResult | null>(row.result_json, null),
    error: row.error === null || row.error === undefined ? null : String(row.error), revision: Number(row.revision),
    botId: String(row.bot_id), sceneId: String(row.scene_id), threadChannelId: String(row.thread_channel_id), sourceKind: String(row.source_kind), sourceId: String(row.source_id),
    createdAtIso: String(row.created_at), updatedAtIso: String(row.updated_at),
    ...(row.started_at ? { startedAtIso: String(row.started_at) } : {}), ...(row.completed_at ? { completedAtIso: String(row.completed_at) } : {}),
  })
}
