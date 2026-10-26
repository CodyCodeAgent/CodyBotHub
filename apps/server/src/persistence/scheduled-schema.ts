import { DatabaseSync } from 'node:sqlite'

export const migrateScheduledSchema = (database: DatabaseSync): void => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, config_json TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT NOT NULL DEFAULT '', core_thread_id TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS scheduled_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id), task_name TEXT NOT NULL, workspace_id TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_at TEXT NOT NULL, trigger_key TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '', completed_at TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '', core_thread_id TEXT NOT NULL DEFAULT '', report TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', delivery_status TEXT NOT NULL DEFAULT 'none', delivery_error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS scheduled_runs_queue ON scheduled_runs(status, created_at);
      CREATE INDEX IF NOT EXISTS scheduled_runs_task ON scheduled_runs(task_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS scheduled_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES scheduled_runs(id), at TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT 'null');
      CREATE TABLE IF NOT EXISTS scheduled_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES scheduled_runs(id), request_key TEXT NOT NULL, status TEXT NOT NULL, body_json TEXT NOT NULL, UNIQUE(run_id,request_key));
      CREATE TABLE IF NOT EXISTS scheduled_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `)
}
