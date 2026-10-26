import { randomUUID } from 'node:crypto'
import { assertTransition } from './state-transitions.js'
import type { HubStore } from './db.js'
import type {
  ScheduledAction,
  ScheduledEvent,
  ScheduledRun,
  ScheduledRunStatus,
  ScheduledRunSummary,
  ScheduledTask,
  ScheduledTaskInput
} from './scheduled-types.js'
const timestamp = () => new Date().toISOString()
type Row = Record<string, unknown>
export class ScheduledStore {
  readonly db: HubStore['db']
  constructor(readonly hub: HubStore) {
    this.db = hub.db
  }
  private task(row: Row): ScheduledTask {
    return {
      ...JSON.parse(String(row.config_json)),
      id: String(row.id),
      revision: Number(row.revision),
      nextRunAt: String(row.next_run_at),
      coreThreadId: String(row.core_thread_id),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastRun: this.latest(String(row.id))
    }
  }
  private run(row: Row): ScheduledRunSummary {
    const value: Record<string, unknown> = {}
    for (const key of ['id', 'status', 'trigger', 'model', 'report', 'error']) value[key] = String(row[key])
    for (const [a, b] of [
      ['taskId', 'task_id'],
      ['taskName', 'task_name'],
      ['workspaceId', 'workspace_id'],
      ['scheduledAt', 'scheduled_at'],
      ['createdAt', 'created_at'],
      ['startedAt', 'started_at'],
      ['completedAt', 'completed_at'],
      ['reasoningEffort', 'reasoning_effort'],
      ['coreThreadId', 'core_thread_id'],
      ['deliveryStatus', 'delivery_status'],
      ['deliveryError', 'delivery_error']
    ])
      value[a!] = String(row[b!])
    return value as ScheduledRunSummary
  }
  getTask(id: string): ScheduledTask {
    const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id=? AND archived=0').get(id) as Row | undefined
    if (!row) throw new Error('定时任务不存在')
    return this.task(row)
  }
  listTasks(
    filters: { query?: string; workspaceId?: string; enabled?: string; limit?: number; offset?: number } = {}
  ): { items: ScheduledTask[]; total: number } {
    const where =
        "archived=0 AND (?='' OR workspace_id=?) AND (?='' OR name LIKE ? ESCAPE '\\') AND (?='' OR enabled=?)",
      q = filters.query?.trim() || '',
      w = filters.workspaceId || '',
      en = filters.enabled ?? ''
    const values = [w, w, q, `%${q.replace(/[\\%_]/gu, '\\$&')}%`, en, en === '1' ? 1 : 0]
    const total = Number(
      (this.db.prepare(`SELECT count(*) n FROM scheduled_tasks WHERE ${where}`).get(...values) as Row).n
    )
    const items = (
      this.db
        .prepare(`SELECT * FROM scheduled_tasks WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
        .all(...values, filters.limit ?? 20, filters.offset ?? 0) as Row[]
    ).map((r) => this.task(r))
    return { items, total }
  }
  save(input: ScheduledTaskInput, actor: string, next: string, id?: string): ScheduledTask {
    const at = timestamp()
    if (id) {
      const previous = this.getTask(id)
      this.db
        .prepare(
          'UPDATE scheduled_tasks SET workspace_id=?,name=?,config_json=?,revision=revision+1,enabled=?,next_run_at=?,updated_at=?,core_thread_id=? WHERE id=?'
        )
        .run(
          input.workspaceId,
          input.name,
          JSON.stringify(input),
          +input.enabled,
          next,
          at,
          previous.workspaceId === input.workspaceId && previous.runtimeKind === input.runtimeKind
            ? previous.coreThreadId
            : '',
          id
        )
    } else {
      id = randomUUID()
      this.db
        .prepare(
          'INSERT INTO scheduled_tasks(id,workspace_id,name,config_json,revision,enabled,next_run_at,created_by,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?)'
        )
        .run(id, input.workspaceId, input.name, JSON.stringify(input), +input.enabled, next, actor, at, at)
    }
    return this.getTask(id)
  }
  archive(id: string): void {
    this.getTask(id)
    if (this.active(id)) throw new Error('任务有未结束的执行，请先处理后再归档')
    this.db.prepare('UPDATE scheduled_tasks SET archived=1,enabled=0,next_run_at=? WHERE id=?').run('', id)
  }
  latest(taskId: string, success = false): ScheduledRunSummary | null {
    const row = this.db
      .prepare(
        `SELECT * FROM scheduled_runs WHERE task_id=? ${success ? "AND status IN ('completed','warning','no_change')" : ''} ORDER BY created_at DESC,rowid DESC LIMIT 1`
      )
      .get(taskId) as Row | undefined
    return row ? this.run(row) : null
  }
  active(taskId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM scheduled_runs WHERE task_id=? AND status IN ('queued','running','awaiting_approval') LIMIT 1"
        )
        .get(taskId)
    )
  }
  enqueue(
    task: ScheduledTask,
    trigger: string,
    key: string,
    scheduledAt: string,
    status: ScheduledRunStatus = 'queued',
    error = ''
  ): ScheduledRun {
    const workspace = this.hub.getWorkspace(task.workspaceId),
      id = randomUUID(),
      at = timestamp()
    const snapshot = { ...task, workspacePath: workspace.path, workspacePrompt: workspace.prompt }
    delete (snapshot as Record<string, unknown>).lastRun
    this.db
      .prepare(
        'INSERT OR IGNORE INTO scheduled_runs(id,task_id,task_name,workspace_id,status,trigger,scheduled_at,trigger_key,snapshot_json,created_at,completed_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        task.id,
        task.name,
        task.workspaceId,
        status,
        trigger,
        scheduledAt,
        key,
        JSON.stringify(snapshot),
        at,
        status === 'skipped' ? at : '',
        error
      )
    const row = this.db.prepare('SELECT id FROM scheduled_runs WHERE trigger_key=?').get(key) as Row
    return this.getRun(String(row.id))
  }
  getRun(id: string): ScheduledRun {
    const row = this.db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('执行记录不存在')
    const events = (
      this.db.prepare('SELECT * FROM scheduled_events WHERE run_id=? ORDER BY id DESC LIMIT 500').all(id) as Row[]
    )
      .reverse()
      .map((r) => ({
        id: Number(r.id),
        at: String(r.at),
        phase: String(r.phase),
        message: String(r.message),
        data: JSON.parse(String(r.data_json))
      }))
    return { ...this.run(row), snapshot: JSON.parse(String(row.snapshot_json)), events, actions: this.actions(id) }
  }
  listRuns(
    filters: {
      taskId?: string
      workspaceId?: string
      status?: string
      from?: string
      to?: string
      limit?: number
      offset?: number
    } = {}
  ): { items: ScheduledRunSummary[]; total: number } {
    const { taskId = '', workspaceId = '', status = '', from = '', to = '' } = filters,
      where =
        "(?='' OR task_id=?) AND (?='' OR workspace_id=?) AND (?='' OR status=?) AND (?='' OR created_at>=?) AND (?='' OR created_at<?)",
      values = [taskId, taskId, workspaceId, workspaceId, status, status, from, from, to, to]
    return {
      total: Number((this.db.prepare(`SELECT count(*) n FROM scheduled_runs WHERE ${where}`).get(...values) as Row).n),
      items: (
        this.db
          .prepare(`SELECT * FROM scheduled_runs WHERE ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`)
          .all(...values, filters.limit ?? 20, filters.offset ?? 0) as Row[]
      ).map((r) => this.run(r))
    }
  }
  updateRun(
    id: string,
    patch: Partial<
      Pick<
        ScheduledRunSummary,
        | 'status'
        | 'startedAt'
        | 'completedAt'
        | 'model'
        | 'reasoningEffort'
        | 'coreThreadId'
        | 'report'
        | 'error'
        | 'deliveryStatus'
        | 'deliveryError'
      >
    >
  ): void {
    const columns: Record<string, string> = {
      status: 'status',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      model: 'model',
      reasoningEffort: 'reasoning_effort',
      coreThreadId: 'core_thread_id',
      report: 'report',
      error: 'error',
      deliveryStatus: 'delivery_status',
      deliveryError: 'delivery_error'
    }
    const entries = Object.entries(patch)
    if (!entries.length) return
    const current = patch.status ? this.getRun(id).status : undefined
    if (current && patch.status) assertTransition('scheduledRun', current, patch.status)
    const changed = this.db
      .prepare(`UPDATE scheduled_runs SET ${entries.map(([k]) => `${columns[k]}=?`).join(',')} WHERE id=?${current ? ' AND status=?' : ''}`)
      .run(...entries.map(([, v]) => v ?? ''), id, ...(current ? [current] : [])).changes
    if (!changed) throw new Error('Scheduled run changed concurrently or no longer exists')
  }
  event(runId: string, phase: string, message: string, data: unknown = null): void {
    this.db
      .prepare('INSERT INTO scheduled_events(run_id,at,phase,message,data_json) VALUES(?,?,?,?,?)')
      .run(runId, timestamp(), phase, message.slice(0, 10000), JSON.stringify(data))
  }
  actions(runId: string): ScheduledAction[] {
    return (
      this.db
        .prepare('SELECT body_json,status FROM scheduled_actions WHERE run_id=? ORDER BY rowid')
        .all(runId) as Row[]
    ).map((r) => ({ ...JSON.parse(String(r.body_json)), status: String(r.status) }))
  }
  action(id: string): ScheduledAction {
    const row = this.db.prepare('SELECT body_json,status FROM scheduled_actions WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('工具执行请求不存在')
    return { ...JSON.parse(String(row.body_json)), status: String(row.status) }
  }
  createAction(action: ScheduledAction, key: string): ScheduledAction {
    this.db
      .prepare('INSERT OR IGNORE INTO scheduled_actions(id,run_id,request_key,status,body_json) VALUES(?,?,?,?,?)')
      .run(action.id, action.runId, key, action.status, JSON.stringify(action))
    const row = this.db
      .prepare('SELECT id FROM scheduled_actions WHERE run_id=? AND request_key=?')
      .get(action.runId, key) as Row
    return this.action(String(row.id))
  }
  updateAction(id: string, patch: Partial<ScheduledAction>, expected?: string): boolean {
    const old = this.action(id),
      next = { ...old, ...patch }
    if (expected && old.status !== expected) return false
    assertTransition('scheduledAction', old.status, next.status)
    return (
      Number(
        this.db
          .prepare('UPDATE scheduled_actions SET status=?,body_json=? WHERE id=? AND status=?')
          .run(next.status, JSON.stringify(next), id, old.status).changes
      ) > 0
    )
  }
  claim(id: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE scheduled_runs SET status='running',started_at=CASE WHEN started_at='' THEN ? ELSE started_at END WHERE id=? AND status='queued'"
          )
          .run(timestamp(), id).changes
      ) > 0
    )
  }
  lease(owner: string): boolean {
    const at = Date.now()
    this.db
      .prepare(
        "INSERT INTO scheduled_leases(name,owner,expires_at) VALUES('scheduler',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE owner=excluded.owner OR expires_at<?"
      )
      .run(owner, at + 30000, at)
    return (this.db.prepare("SELECT owner FROM scheduled_leases WHERE name='scheduler'").get() as Row)?.owner === owner
  }
  releaseLease(owner: string): void {
    this.db.prepare("DELETE FROM scheduled_leases WHERE name='scheduler' AND owner=?").run(owner)
  }
  recover(): void {
    const at = timestamp()
    this.db
      .prepare(
        "UPDATE scheduled_runs SET status='interrupted',completed_at=?,error='服务在执行期间中断；可能已有文件或外部操作，请核实后再手动重试' WHERE status='running'"
      )
      .run(at)
    this.db.prepare("UPDATE scheduled_actions SET status='failed' WHERE status='running'").run()
    this.db
      .prepare(
        "UPDATE scheduled_runs SET delivery_status='failed',delivery_error='服务在投递期间中断，可单独重试投递' WHERE delivery_status='pending'"
      )
      .run()
    // Do not replay missed slots or old plans after a restart. Queued work is already durable.
  }
}
