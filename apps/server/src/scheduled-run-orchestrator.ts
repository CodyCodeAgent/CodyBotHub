import { realpathSync } from 'node:fs'
import type { ScheduledStore } from './scheduled-store.js'
import type { ScheduledRun } from './scheduled-types.js'
import { workspacePathsOverlap } from './workspace-access.js'

export type ActiveScheduledRun = { controller: AbortController; workspace: string }

/** Claims queued runs and enforces both task and workspace concurrency before
 * invoking the execution workflow. Scheduling of future slots lives elsewhere. */
export class ScheduledRunOrchestrator {
  constructor(
    private readonly records: ScheduledStore,
    readonly active: Map<string, ActiveScheduledRun>,
    private readonly execute: (run: ScheduledRun, controller: AbortController) => Promise<void>,
  ) {}

  dispatch(): void {
    for (const item of this.records.listRuns({ status: 'queued', limit: 100 }).items.reverse()) {
      if (this.active.size >= 2) break
      if (this.active.has(item.id)) continue
      if (this.records.db.prepare("SELECT 1 FROM scheduled_runs WHERE task_id=? AND id<>? AND status IN ('running','awaiting_approval') LIMIT 1").get(item.taskId, item.id)) continue
      const run = this.records.getRun(item.id)
      const root = realpathSync.native(run.snapshot.workspacePath)
      if ([...this.active.values()].some(entry => workspacePathsOverlap(entry.workspace, root))) continue
      if (!this.records.claim(run.id)) continue
      const controller = new AbortController()
      this.active.set(run.id, { controller, workspace: root })
      void this.execute(this.records.getRun(run.id), controller)
        .catch(error => console.error('[scheduler] execute failed', error))
        .finally(() => this.active.delete(run.id))
    }
  }
}
