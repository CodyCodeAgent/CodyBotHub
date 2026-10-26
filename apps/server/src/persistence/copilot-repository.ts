import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, jsonObject as object, type DatabaseRow as Row } from '../db-values.js'
import type { CopilotMessageRecord, CopilotProposalRecord, CopilotSessionRecord } from '../types.js'
import type { AdminRepository } from './admin-repository.js'
import type { WorkspaceRepository } from './workspace-repository.js'

export class CopilotRepository {
  constructor(readonly db: DatabaseSync, private readonly accounts: AdminRepository, private readonly workspaces: WorkspaceRepository) {}

  getOrCreateCopilotSession(accountId: string, workspaceId: string): CopilotSessionRecord {
    this.accounts.getAdminAccount(accountId)
    this.workspaces.getWorkspace(workspaceId)
    const existing = this.db.prepare('SELECT s.*, w.name AS workspace_name FROM copilot_sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.account_id = ? AND s.workspace_id = ?').get(accountId, workspaceId) as Row | undefined
    if (existing) return this.copilotSession(existing)
    const id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO copilot_sessions (id, account_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, accountId, workspaceId, timestamp, timestamp)
    return this.getCopilotSession(id, accountId)
  }
  getCopilotSession(id: string, accountId = ''): CopilotSessionRecord {
    const row = this.db.prepare(`SELECT s.*, w.name AS workspace_name FROM copilot_sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?${accountId ? ' AND s.account_id = ?' : ''}`).get(...(accountId ? [id, accountId] : [id])) as Row | undefined
    if (!row) throw new Error('Copilot session not found')
    return this.copilotSession(row)
  }
  resetCopilotSession(id: string, accountId: string): CopilotSessionRecord {
    this.getCopilotSession(id, accountId)
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM copilot_messages WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM copilot_proposals WHERE session_id = ?').run(id)
      this.db.prepare("UPDATE copilot_sessions SET core_thread_id = '', title = '平台 Copilot', updated_at = ? WHERE id = ?").run(timestamp, id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getCopilotSession(id, accountId)
  }
  setCopilotCoreThread(id: string, coreThreadId: string): CopilotSessionRecord {
    if (!this.db.prepare('UPDATE copilot_sessions SET core_thread_id = ?, updated_at = ? WHERE id = ?').run(coreThreadId, now(), id).changes) throw new Error('Copilot session not found')
    return this.getCopilotSession(id)
  }
  setCopilotToolContractVersion(id: string, accountId: string, version: number): CopilotSessionRecord {
    this.getCopilotSession(id, accountId)
    if (!this.db.prepare("UPDATE copilot_sessions SET core_thread_id = '', tool_contract_version = ?, updated_at = ? WHERE id = ?").run(version, now(), id).changes) throw new Error('Copilot session not found')
    return this.getCopilotSession(id, accountId)
  }
  addCopilotMessage(sessionId: string, role: CopilotMessageRecord['role'], content: string): CopilotMessageRecord {
    this.getCopilotSession(sessionId)
    const id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO copilot_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, role, content, timestamp)
    this.db.prepare('UPDATE copilot_sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId)
    return { id, sessionId, role, content, createdAt: timestamp }
  }
  listCopilotMessages(sessionId: string, accountId: string): CopilotMessageRecord[] {
    this.getCopilotSession(sessionId, accountId)
    return (this.db.prepare('SELECT * FROM copilot_messages WHERE session_id = ? ORDER BY created_at, rowid').all(sessionId) as Row[]).map(row => ({ id: String(row.id), sessionId: String(row.session_id), role: String(row.role) as CopilotMessageRecord['role'], content: String(row.content), createdAt: String(row.created_at) }))
  }
  createCopilotProposal(sessionId: string, kind: CopilotProposalRecord['kind'], title: string, payload: Record<string, unknown>): CopilotProposalRecord {
    this.getCopilotSession(sessionId)
    const id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO copilot_proposals (id, session_id, kind, title, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, kind, title, JSON.stringify(payload), timestamp, timestamp)
    return this.getCopilotProposal(id)
  }
  listCopilotProposals(sessionId: string, accountId: string): CopilotProposalRecord[] {
    this.getCopilotSession(sessionId, accountId)
    return (this.db.prepare('SELECT * FROM copilot_proposals WHERE session_id = ? ORDER BY created_at DESC, id DESC').all(sessionId) as Row[]).map(this.copilotProposal)
  }
  getCopilotProposal(id: string, accountId = ''): CopilotProposalRecord {
    const row = this.db.prepare(`SELECT p.* FROM copilot_proposals p JOIN copilot_sessions s ON s.id = p.session_id WHERE p.id = ?${accountId ? ' AND s.account_id = ?' : ''}`).get(...(accountId ? [id, accountId] : [id])) as Row | undefined
    if (!row) throw new Error('Copilot proposal not found')
    return this.copilotProposal(row)
  }
  finishCopilotProposal(id: string, accountId: string, status: 'applied' | 'dismissed', result: Record<string, unknown> = {}): CopilotProposalRecord {
    const current = this.getCopilotProposal(id, accountId)
    if (current.status !== 'draft') throw new Error(`Copilot proposal is already ${current.status}`)
    const timestamp = now()
    this.db.prepare('UPDATE copilot_proposals SET status = ?, result_json = ?, applied_at = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(result), status === 'applied' ? timestamp : '', timestamp, id)
    return this.getCopilotProposal(id, accountId)
  }
  private copilotSession = (row: Row): CopilotSessionRecord => ({ id: String(row.id), accountId: String(row.account_id), workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), coreThreadId: String(row.core_thread_id), toolContractVersion: Number(row.tool_contract_version) || 0, title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })
  private copilotProposal = (row: Row): CopilotProposalRecord => ({ id: String(row.id), sessionId: String(row.session_id), kind: String(row.kind) as CopilotProposalRecord['kind'], title: String(row.title), status: String(row.status) as CopilotProposalRecord['status'], payload: object(row.payload_json), result: object(row.result_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at), appliedAt: String(row.applied_at) })
}
