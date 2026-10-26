import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, stringList as list, type DatabaseRow as Row } from '../db-values.js'
import type { SkillSourceRecord, SkillInstallationRecord } from '../types.js'
import type { WorkspaceRepository } from './workspace-repository.js'

export class SkillSourceRepository {
  constructor(readonly db: DatabaseSync, private readonly workspaces: WorkspaceRepository) {}

  listSkillSources(): SkillSourceRecord[] {
    return (this.db.prepare(`SELECT s.*, w.name AS workspace_name FROM skill_sources s JOIN workspaces w ON w.id = s.workspace_id ORDER BY s.name COLLATE NOCASE`).all() as Row[]).map(this.skillSource)
  }
  getSkillSource(id: string): SkillSourceRecord {
    const row = this.db.prepare(`SELECT s.*, w.name AS workspace_name FROM skill_sources s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`).get(id) as Row | undefined
    if (!row) throw new Error('Skill source not found')
    return this.skillSource(row)
  }
  createSkillSource(input: { name: string; repositoryUrl: string; branch: string; workspaceId: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean }): SkillSourceRecord {
    this.workspaces.getWorkspace(input.workspaceId)
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO skill_sources (id, name, repository_url, branch, workspace_id, skill_roots_json, knowledge_roots_json, auto_install, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.repositoryUrl, input.branch, input.workspaceId, JSON.stringify(input.skillRoots), JSON.stringify(input.knowledgeRoots), input.autoInstall ? 1 : 0, timestamp, timestamp)
    return this.getSkillSource(id)
  }
  updateSkillSource(id: string, input: { name: string; repositoryUrl: string; branch: string; workspaceId: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean }): SkillSourceRecord {
    this.workspaces.getWorkspace(input.workspaceId)
    const current = this.getSkillSource(id)
    const identityChanged = current.repositoryUrl !== input.repositoryUrl || current.branch !== input.branch || current.workspaceId !== input.workspaceId || JSON.stringify(current.skillRoots) !== JSON.stringify(input.skillRoots)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (identityChanged) this.db.prepare('DELETE FROM skill_installations WHERE source_id = ?').run(id)
      const result = this.db.prepare(`UPDATE skill_sources SET name = ?, repository_url = ?, branch = ?, workspace_id = ?, skill_roots_json = ?, knowledge_roots_json = ?, auto_install = ?, last_synced_at = ?, last_commit = ?, updated_at = ? WHERE id = ?`)
        .run(input.name, input.repositoryUrl, input.branch, input.workspaceId, JSON.stringify(input.skillRoots), JSON.stringify(input.knowledgeRoots), input.autoInstall ? 1 : 0, identityChanged ? '' : current.lastSyncedAt, identityChanged ? '' : current.lastCommit, now(), id)
      if (!result.changes) throw new Error('Skill source not found')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getSkillSource(id)
  }
  deleteSkillSource(id: string): void {
    if (!this.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(id).changes) throw new Error('Skill source not found')
  }
  updateSkillSourceSync(id: string, input: { lastSyncedAt?: string; lastCommit?: string; lastError?: string }): SkillSourceRecord {
    const current = this.getSkillSource(id)
    this.db.prepare('UPDATE skill_sources SET last_synced_at = ?, last_commit = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(input.lastSyncedAt ?? current.lastSyncedAt, input.lastCommit ?? current.lastCommit, input.lastError ?? current.lastError, now(), id)
    return this.getSkillSource(id)
  }
  listSkillInstallations(input: { sourceId?: string; workspaceId?: string } = {}): SkillInstallationRecord[] {
    const filters: string[] = [], params: string[] = []
    if (input.sourceId) { filters.push('source_id = ?'); params.push(input.sourceId) }
    if (input.workspaceId) { filters.push('workspace_id = ?'); params.push(input.workspaceId) }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    return (this.db.prepare(`SELECT * FROM skill_installations ${where} ORDER BY target_name COLLATE NOCASE`).all(...params) as Row[]).map(this.skillInstallation)
  }
  upsertSkillInstallation(input: Omit<SkillInstallationRecord, 'installedAt' | 'updatedAt'>): SkillInstallationRecord {
    const timestamp = now()
    this.db.prepare(`INSERT INTO skill_installations (source_id, workspace_id, skill_key, target_name, source_path, target_path, installed_commit, source_checksum, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, workspace_id, skill_key) DO UPDATE SET target_name = excluded.target_name, source_path = excluded.source_path, target_path = excluded.target_path, installed_commit = excluded.installed_commit, source_checksum = excluded.source_checksum, updated_at = excluded.updated_at`)
      .run(input.sourceId, input.workspaceId, input.skillKey, input.targetName, input.sourcePath, input.targetPath, input.installedCommit, input.sourceChecksum, timestamp, timestamp)
    return this.listSkillInstallations({ sourceId: input.sourceId, workspaceId: input.workspaceId }).find(item => item.skillKey === input.skillKey)!
  }
  private skillSource = (row: Row): SkillSourceRecord => ({
    id: String(row.id), name: String(row.name), repositoryUrl: String(row.repository_url), branch: String(row.branch), workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name),
    skillRoots: list(row.skill_roots_json), knowledgeRoots: list(row.knowledge_roots_json), autoInstall: Boolean(row.auto_install), lastSyncedAt: String(row.last_synced_at), lastCommit: String(row.last_commit), lastError: String(row.last_error), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })
  private skillInstallation = (row: Row): SkillInstallationRecord => ({
    sourceId: String(row.source_id), workspaceId: String(row.workspace_id), skillKey: String(row.skill_key), targetName: String(row.target_name), sourcePath: String(row.source_path), targetPath: String(row.target_path), installedCommit: String(row.installed_commit), sourceChecksum: String(row.source_checksum), installedAt: String(row.installed_at), updatedAt: String(row.updated_at),
  })
}
