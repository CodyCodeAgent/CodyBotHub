import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, type DatabaseRow as Row } from '../db-values.js'
import type { WorkspaceRecord } from '../types.js'

export class WorkspaceRepository {
  constructor(readonly db: DatabaseSync) {}

  listWorkspaces(): WorkspaceRecord[] {
    return (this.db.prepare('SELECT * FROM workspaces ORDER BY name COLLATE NOCASE').all() as Row[]).map(this.workspace)
  }
  createWorkspace(input: { name: string; path: string; prompt?: string }): WorkspaceRecord {
    const id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO workspaces (id, name, path, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.path, input.prompt ?? '', timestamp, timestamp)
    return this.getWorkspace(id)
  }
  updateWorkspace(id: string, input: { name: string; path: string; prompt?: string }): WorkspaceRecord {
    const result = this.db.prepare('UPDATE workspaces SET name = ?, path = ?, prompt = ?, updated_at = ? WHERE id = ?')
      .run(input.name, input.path, input.prompt ?? '', now(), id)
    if (!result.changes) throw new Error('Workspace not found')
    return this.getWorkspace(id)
  }
  deleteWorkspace(id: string): void {
    const used = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM bot_workspaces WHERE workspace_id = ?) +
      (SELECT COUNT(*) FROM scenes WHERE workspace_id = ?) +
      (SELECT COUNT(*) FROM skill_packages WHERE workspace_id = ?) AS count`).get(id, id, id) as Row
    if (Number(used.count) > 0) throw new Error('Workspace is still used by a Bot, Scene, or Skill Package')
    if (!this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes) throw new Error('Workspace not found')
  }
  getWorkspace(id: string): WorkspaceRecord {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Workspace not found')
    return this.workspace(row)
  }
  private workspace = (row: Row): WorkspaceRecord => ({
    id: String(row.id), name: String(row.name), path: String(row.path), prompt: String(row.prompt),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })
}
