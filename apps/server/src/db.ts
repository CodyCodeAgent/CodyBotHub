import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AdminAccountRecord, AuditLogRecord, BotRecord, MessageLogRecord, ProvisioningJobRecord, ResolvedRoute, SceneRecord, SkillPackageRecord, WorkspaceRecord } from './types.js'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'

type Row = Record<string, unknown>
const now = () => new Date().toISOString()
const list = (value: unknown): string[] => {
  try { return JSON.parse(String(value)) as string[] } catch { return [] }
}

export class HubStore {
  readonly db: DatabaseSync

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close(): void { this.db.close() }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_accounts (
        id TEXT PRIMARY KEY,
        login_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        last_login_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        base_prompt TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_account_id TEXT NOT NULL DEFAULT '',
        actor_login_name TEXT NOT NULL DEFAULT '',
        actor_display_name TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        app_id TEXT NOT NULL DEFAULT '',
        app_secret_encrypted TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        permissions_json TEXT NOT NULL DEFAULT '[]',
        reply_mode TEXT NOT NULL DEFAULT 'reply' CHECK (reply_mode IN ('reply', 'topic')),
        default_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_workspaces (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        PRIMARY KEY (bot_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 100,
        reply_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (reply_mode IN ('inherit', 'reply', 'topic')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        matcher_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, name)
      );
      CREATE TABLE IF NOT EXISTS skill_packages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        skills_json TEXT NOT NULL DEFAULT '[]',
        fallback_mode TEXT NOT NULL DEFAULT 'package_first' CHECK (fallback_mode IN ('package_first', 'mixed', 'package_only')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS scene_skill_packages (
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        skill_package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scene_id, skill_package_id)
      );
      CREATE TABLE IF NOT EXISTS bot_operators (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        feishu_open_id TEXT NOT NULL,
        PRIMARY KEY (bot_id, feishu_open_id)
      );
      CREATE TABLE IF NOT EXISTS group_scene_bindings (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        bound_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_routes (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        core_thread_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, scene_id, chat_id, topic_id)
      );
      CREATE TABLE IF NOT EXISTS inbound_events (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS provisioning_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('starting', 'waiting_scan', 'creating', 'completed', 'failed', 'cancelled')),
        request_json TEXT NOT NULL,
        qr_url TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_logs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        sender_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL,
        inbound_content TEXT NOT NULL,
        response_content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        error TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        scene_id TEXT NOT NULL DEFAULT '',
        scene_name TEXT NOT NULL DEFAULT '',
        skill_packages_json TEXT NOT NULL DEFAULT '[]',
        received_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        UNIQUE (bot_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_scenes_bot ON scenes(bot_id, enabled, priority);
      CREATE INDEX IF NOT EXISTS idx_routes_chat ON conversation_routes(bot_id, chat_id, topic_id);
      DELETE FROM inbound_events WHERE rowid NOT IN (SELECT MIN(rowid) FROM inbound_events GROUP BY bot_id, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_message ON inbound_events(bot_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_events(received_at);
      CREATE INDEX IF NOT EXISTS idx_message_logs_received ON message_logs(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_logs_bot ON message_logs(bot_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_logs_scene ON message_logs(scene_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_account_id, created_at DESC);
    `)
    const sessionColumns = this.db.prepare('PRAGMA table_info(auth_sessions)').all() as Row[]
    if (!sessionColumns.some(column => String(column.name) === 'account_id')) this.db.exec("ALTER TABLE auth_sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT ''")
    const legacy = this.db.prepare('SELECT password_hash, created_at, updated_at FROM admin_credentials WHERE id = 1').get() as Row | undefined
    if (legacy && !(this.db.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get())) {
      this.db.prepare('INSERT INTO admin_accounts (id, login_name, display_name, password_hash, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run('legacy-admin', 'admin', '管理员', String(legacy.password_hash), String(legacy.created_at), String(legacy.updated_at))
    }
    const firstAccount = this.db.prepare('SELECT id FROM admin_accounts ORDER BY created_at LIMIT 1').get() as Row | undefined
    if (firstAccount) this.db.prepare("UPDATE auth_sessions SET account_id = ? WHERE account_id = ''").run(String(firstAccount.id))
  }

  hasAdmin(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM admin_accounts WHERE enabled = 1 LIMIT 1').get())
  }
  listAdminAccounts(): AdminAccountRecord[] {
    return (this.db.prepare('SELECT * FROM admin_accounts ORDER BY login_name COLLATE NOCASE').all() as Row[]).map(this.adminAccount)
  }
  getAdminAccount(id: string): AdminAccountRecord {
    const row = this.db.prepare('SELECT * FROM admin_accounts WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Account not found')
    return this.adminAccount(row)
  }
  findAdminAccountByLogin(loginName: string): (AdminAccountRecord & { passwordHash: string }) | null {
    const row = this.db.prepare('SELECT * FROM admin_accounts WHERE login_name = ? COLLATE NOCASE').get(loginName) as Row | undefined
    return row ? { ...this.adminAccount(row), passwordHash: String(row.password_hash) } : null
  }
  createAdminAccount(input: { loginName: string; displayName: string; passwordHash: string }): AdminAccountRecord {
    const id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO admin_accounts (id, login_name, display_name, password_hash, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, input.loginName, input.displayName, input.passwordHash, timestamp, timestamp)
    return this.getAdminAccount(id)
  }
  updateAdminAccount(id: string, input: { loginName: string; displayName: string; passwordHash?: string }): AdminAccountRecord {
    this.getAdminAccount(id)
    const result = input.passwordHash
      ? this.db.prepare('UPDATE admin_accounts SET login_name = ?, display_name = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(input.loginName, input.displayName, input.passwordHash, now(), id)
      : this.db.prepare('UPDATE admin_accounts SET login_name = ?, display_name = ?, updated_at = ? WHERE id = ?').run(input.loginName, input.displayName, now(), id)
    if (!result.changes) throw new Error('Account not found')
    return this.getAdminAccount(id)
  }
  deleteAdminAccount(id: string): void {
    if (this.listAdminAccounts().filter(item => item.enabled).length <= 1) throw new Error('Cannot delete the last administrator account')
    this.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(id)
    if (!this.db.prepare('DELETE FROM admin_accounts WHERE id = ?').run(id).changes) throw new Error('Account not found')
  }
  touchAdminLogin(id: string): void { this.db.prepare('UPDATE admin_accounts SET last_login_at = ? WHERE id = ?').run(now(), id) }
  private adminAccount = (row: Row): AdminAccountRecord => ({
    id: String(row.id), loginName: String(row.login_name), displayName: String(row.display_name), enabled: Boolean(row.enabled),
    lastLoginAt: String(row.last_login_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  createSession(tokenHash: string, accountId: string, expiresAt: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now())
    this.db.prepare('INSERT INTO auth_sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(tokenHash, accountId, expiresAt, now())
  }
  hasSession(tokenHash: string): boolean {
    return Boolean(this.getSessionAccount(tokenHash))
  }
  getSessionAccount(tokenHash: string): AdminAccountRecord | null {
    const row = this.db.prepare(`SELECT a.* FROM auth_sessions s JOIN admin_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND a.enabled = 1`).get(tokenHash, now()) as Row | undefined
    return row ? this.adminAccount(row) : null
  }
  deleteSession(tokenHash: string): void { this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash) }

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

  getPlatformPrompt(): string {
    const row = this.db.prepare('SELECT base_prompt FROM platform_settings WHERE id = 1').get() as Row | undefined
    return row ? String(row.base_prompt) : ''
  }
  setPlatformPrompt(value: string): string {
    this.db.prepare(`INSERT INTO platform_settings (id, base_prompt, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET base_prompt = excluded.base_prompt, updated_at = excluded.updated_at`).run(value, now())
    return value
  }

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
  private getWorkspace(id: string): WorkspaceRecord {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Workspace not found')
    return this.workspace(row)
  }
  private workspace = (row: Row): WorkspaceRecord => ({
    id: String(row.id), name: String(row.name), path: String(row.path), prompt: String(row.prompt),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  listBots(): BotRecord[] {
    return (this.db.prepare('SELECT * FROM bots ORDER BY name COLLATE NOCASE').all() as Row[]).map(row => this.bot(row))
  }
  createBot(input: { name: string; description?: string; appId?: string; appSecretEncrypted?: string; prompt?: string; permissions?: string[]; operatorIds?: string[]; replyMode?: 'reply' | 'topic'; defaultWorkspaceId: string; workspaceIds?: string[] }): BotRecord {
    const workspaceIds = [...new Set([input.defaultWorkspaceId, ...(input.workspaceIds ?? [])])]
    this.assertWorkspaces(workspaceIds)
    const id = randomUUID(), timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO bots (id, name, description, app_id, app_secret_encrypted, prompt, permissions_json, reply_mode, default_workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.description ?? '', input.appId ?? '', input.appSecretEncrypted ?? '', input.prompt ?? '', JSON.stringify(input.permissions ?? []), input.replyMode ?? 'reply', input.defaultWorkspaceId, timestamp, timestamp)
      const add = this.db.prepare('INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)')
      for (const workspaceId of workspaceIds) add.run(id, workspaceId)
      this.setBotOperators(id, input.operatorIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBot(id)
  }
  updateBot(id: string, input: { name: string; description?: string; appId?: string; appSecretEncrypted?: string | null; prompt?: string; permissions?: string[]; operatorIds?: string[]; replyMode?: 'reply' | 'topic'; defaultWorkspaceId: string; workspaceIds?: string[] }): BotRecord {
    const workspaceIds = [...new Set([input.defaultWorkspaceId, ...(input.workspaceIds ?? [])])]
    this.assertWorkspaces(workspaceIds)
    const current = this.db.prepare('SELECT app_secret_encrypted FROM bots WHERE id = ?').get(id) as Row | undefined
    if (!current) throw new Error('Bot not found')
    const removed = this.db.prepare(`SELECT COUNT(*) AS count FROM scenes WHERE bot_id = ? AND workspace_id NOT IN (${workspaceIds.map(() => '?').join(',')})`).get(id, ...workspaceIds) as Row
    if (Number(removed.count) > 0) throw new Error('A Scene still uses a Workspace removed from this Bot')
    const secret = input.appSecretEncrypted === null || input.appSecretEncrypted === undefined ? String(current.app_secret_encrypted) : input.appSecretEncrypted
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE bots SET name = ?, description = ?, app_id = ?, app_secret_encrypted = ?, prompt = ?, permissions_json = ?, reply_mode = ?, default_workspace_id = ?, updated_at = ? WHERE id = ?`)
        .run(input.name, input.description ?? '', input.appId ?? '', secret, input.prompt ?? '', JSON.stringify(input.permissions ?? []), input.replyMode ?? 'reply', input.defaultWorkspaceId, now(), id)
      this.db.prepare('DELETE FROM bot_workspaces WHERE bot_id = ?').run(id)
      const add = this.db.prepare('INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)')
      for (const workspaceId of workspaceIds) add.run(id, workspaceId)
      this.db.prepare('DELETE FROM bot_operators WHERE bot_id = ?').run(id)
      this.setBotOperators(id, input.operatorIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBot(id)
  }
  deleteBot(id: string): void {
    if (!this.db.prepare('DELETE FROM bots WHERE id = ?').run(id).changes) throw new Error('Bot not found')
  }
  private getBot(id: string): BotRecord {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Bot not found')
    return this.bot(row)
  }
  private bot(row: Row): BotRecord {
    const workspaceIds = (this.db.prepare('SELECT workspace_id FROM bot_workspaces WHERE bot_id = ? ORDER BY workspace_id').all(String(row.id)) as Row[]).map(item => String(item.workspace_id))
    const operatorIds = (this.db.prepare('SELECT feishu_open_id FROM bot_operators WHERE bot_id = ? ORDER BY feishu_open_id').all(String(row.id)) as Row[]).map(item => String(item.feishu_open_id))
    return { id: String(row.id), name: String(row.name), description: String(row.description), appId: String(row.app_id), hasAppSecret: Boolean(row.app_secret_encrypted), prompt: String(row.prompt), permissions: list(row.permissions_json), operatorIds, replyMode: String(row.reply_mode) as BotRecord['replyMode'], defaultWorkspaceId: String(row.default_workspace_id), workspaceIds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }
  private setBotOperators(botId: string, ids: string[]): void {
    const add = this.db.prepare('INSERT OR IGNORE INTO bot_operators (bot_id, feishu_open_id) VALUES (?, ?)')
    for (const id of [...new Set(ids.map(value => value.trim()).filter(Boolean))]) add.run(botId, id)
  }
  private assertWorkspaces(ids: string[]): void {
    if (!ids.length) throw new Error('At least one Workspace is required')
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as Row
    if (Number(count.count) !== ids.length) throw new Error('Workspace not found')
  }

  listScenes(): Array<SceneRecord & { skillPackageIds: string[] }> {
    return (this.db.prepare('SELECT * FROM scenes ORDER BY priority ASC, name COLLATE NOCASE').all() as Row[]).map(row => this.scene(row))
  }
  createScene(input: Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt'> & { skillPackageIds?: string[] }): SceneRecord & { skillPackageIds: string[] } {
    this.assertBotWorkspace(input.botId, input.workspaceId)
    this.assertScenePackages(input.workspaceId, input.skillPackageIds ?? [])
    const id = randomUUID(), timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO scenes (id, bot_id, workspace_id, name, prompt, priority, reply_mode, enabled, matcher_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.botId, input.workspaceId, input.name, input.prompt, input.priority, input.replyMode, input.enabled ? 1 : 0, JSON.stringify(input.matcher), timestamp, timestamp)
      this.setScenePackages(id, input.skillPackageIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getScene(id)
  }
  updateScene(id: string, input: Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt'> & { skillPackageIds?: string[] }): SceneRecord & { skillPackageIds: string[] } {
    this.assertBotWorkspace(input.botId, input.workspaceId)
    this.assertScenePackages(input.workspaceId, input.skillPackageIds ?? [])
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`UPDATE scenes SET bot_id = ?, workspace_id = ?, name = ?, prompt = ?, priority = ?, reply_mode = ?, enabled = ?, matcher_json = ?, updated_at = ? WHERE id = ?`)
        .run(input.botId, input.workspaceId, input.name, input.prompt, input.priority, input.replyMode, input.enabled ? 1 : 0, JSON.stringify(input.matcher), now(), id)
      if (!result.changes) throw new Error('Scene not found')
      this.db.prepare('DELETE FROM scene_skill_packages WHERE scene_id = ?').run(id)
      this.setScenePackages(id, input.skillPackageIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getScene(id)
  }
  deleteScene(id: string): void { if (!this.db.prepare('DELETE FROM scenes WHERE id = ?').run(id).changes) throw new Error('Scene not found') }
  private getScene(id: string): SceneRecord & { skillPackageIds: string[] } {
    const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Scene not found')
    return this.scene(row)
  }
  private scene(row: Row): SceneRecord & { skillPackageIds: string[] } {
    const raw = JSON.parse(String(row.matcher_json)) as Partial<SceneRecord['matcher']>
    const skillPackageIds = (this.db.prepare('SELECT skill_package_id FROM scene_skill_packages WHERE scene_id = ? ORDER BY position').all(String(row.id)) as Row[]).map(item => String(item.skill_package_id))
    return { id: String(row.id), botId: String(row.bot_id), workspaceId: String(row.workspace_id), name: String(row.name), prompt: String(row.prompt), priority: Number(row.priority), replyMode: String(row.reply_mode) as SceneRecord['replyMode'], enabled: Boolean(row.enabled), matcher: { chatIds: raw.chatIds ?? [], messageTypes: raw.messageTypes ?? [], textIncludes: raw.textIncludes ?? [], cardTitleIncludes: raw.cardTitleIncludes ?? [] }, skillPackageIds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }
  private assertBotWorkspace(botId: string, workspaceId: string): void {
    if (!this.db.prepare('SELECT 1 FROM bot_workspaces WHERE bot_id = ? AND workspace_id = ?').get(botId, workspaceId)) throw new Error('Scene Workspace must be attached to its Bot')
  }
  private assertScenePackages(workspaceId: string, ids: string[]): void {
    if (!ids.length) return
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM skill_packages WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`).get(workspaceId, ...ids) as Row
    if (Number(count.count) !== ids.length) throw new Error('Scene and Skill Package must use the same Workspace')
  }
  private setScenePackages(sceneId: string, ids: string[]): void {
    const add = this.db.prepare('INSERT INTO scene_skill_packages (scene_id, skill_package_id, position) VALUES (?, ?, ?)')
    ids.forEach((id, index) => add.run(sceneId, id, index))
  }

  listSkillPackages(): SkillPackageRecord[] {
    return (this.db.prepare('SELECT * FROM skill_packages ORDER BY name COLLATE NOCASE').all() as Row[]).map(this.skillPackage)
  }
  createSkillPackage(input: Omit<SkillPackageRecord, 'id' | 'createdAt' | 'updatedAt'>): SkillPackageRecord {
    this.assertWorkspaces([input.workspaceId])
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO skill_packages (id, workspace_id, name, description, prompt, skills_json, fallback_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId, input.name, input.description, input.prompt, JSON.stringify(input.skills), input.fallbackMode, timestamp, timestamp)
    return this.getSkillPackage(id)
  }
  updateSkillPackage(id: string, input: Omit<SkillPackageRecord, 'id' | 'createdAt' | 'updatedAt'>): SkillPackageRecord {
    this.assertWorkspaces([input.workspaceId])
    const incompatible = this.db.prepare(`SELECT COUNT(*) AS count FROM scene_skill_packages ssp JOIN scenes s ON s.id = ssp.scene_id WHERE ssp.skill_package_id = ? AND s.workspace_id <> ?`).get(id, input.workspaceId) as Row
    if (Number(incompatible.count) > 0) throw new Error('Linked Scenes use a different Workspace')
    const result = this.db.prepare(`UPDATE skill_packages SET workspace_id = ?, name = ?, description = ?, prompt = ?, skills_json = ?, fallback_mode = ?, updated_at = ? WHERE id = ?`)
      .run(input.workspaceId, input.name, input.description, input.prompt, JSON.stringify(input.skills), input.fallbackMode, now(), id)
    if (!result.changes) throw new Error('Skill Package not found')
    return this.getSkillPackage(id)
  }
  deleteSkillPackage(id: string): void { if (!this.db.prepare('DELETE FROM skill_packages WHERE id = ?').run(id).changes) throw new Error('Skill Package not found') }
  private getSkillPackage(id: string): SkillPackageRecord {
    const row = this.db.prepare('SELECT * FROM skill_packages WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Skill Package not found')
    return this.skillPackage(row)
  }
  private skillPackage = (row: Row): SkillPackageRecord => ({ id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), description: String(row.description), prompt: String(row.prompt), skills: list(row.skills_json), fallbackMode: String(row.fallback_mode) as SkillPackageRecord['fallbackMode'], createdAt: String(row.created_at), updatedAt: String(row.updated_at) })

  stats(): { workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number } {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count)
    const enabledScenes = Number((this.db.prepare('SELECT COUNT(*) AS count FROM scenes WHERE enabled = 1').get() as Row).count)
    return { workspaces: count('workspaces'), bots: count('bots'), scenes: enabledScenes, skillPackages: count('skill_packages'), messageLogs: count('message_logs') }
  }

  createMessageLog(botId: string, route: ResolvedRoute, message: ChannelInboundMessage): MessageLogRecord {
    const id = randomUUID()
    const startedAt = now()
    this.db.prepare(`INSERT INTO message_logs (
      id, event_id, message_id, bot_id, bot_name, chat_id, topic_id, sender_id,
      message_type, inbound_content, status, workspace_id, workspace_name,
      scene_id, scene_name, skill_packages_json, received_at, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, message.eventId, message.messageId, botId, route.bot.name,
        message.conversation.id, message.conversation.rootId ?? '', message.sender.id,
        message.content?.type ?? 'unknown', message.text.slice(0, 200_000),
        route.workspace.id, route.workspace.name, route.scene?.id ?? '', route.scene?.name ?? '',
        JSON.stringify(route.skillPackages.map(item => ({ id: item.id, name: item.name }))),
        message.createdAtIso, startedAt,
      )
    return this.getMessageLog(id)
  }

  finishMessageLog(id: string, update: { responseContent?: string; error?: string }): MessageLogRecord {
    const current = this.getMessageLog(id)
    const completedAt = now()
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(current.startedAt))
    const error = update.error?.slice(0, 20_000) ?? ''
    this.db.prepare(`UPDATE message_logs SET response_content = ?, status = ?, error = ?, completed_at = ?, duration_ms = ? WHERE id = ?`)
      .run((update.responseContent ?? '').slice(0, 500_000), error ? 'failed' : 'completed', error, completedAt, durationMs, id)
    return this.getMessageLog(id)
  }

  listMessageLogs(input: { limit?: number; offset?: number; botId?: string; sceneId?: string; status?: string; query?: string } = {}): { items: MessageLogRecord[]; total: number } {
    const filters: string[] = []
    const params: Array<string | number> = []
    if (input.botId) { filters.push('bot_id = ?'); params.push(input.botId) }
    if (input.sceneId) { filters.push('scene_id = ?'); params.push(input.sceneId) }
    if (input.status && ['processing', 'completed', 'failed'].includes(input.status)) { filters.push('status = ?'); params.push(input.status) }
    if (input.query?.trim()) {
      filters.push('(inbound_content LIKE ? ESCAPE \'\\\' OR response_content LIKE ? ESCAPE \'\\\' OR message_id LIKE ? OR id LIKE ?)')
      const escaped = input.query.trim().replace(/[\\%_]/gu, value => `\\${value}`)
      params.push(`%${escaped}%`, `%${escaped}%`, `%${input.query.trim()}%`, `%${input.query.trim()}%`)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM message_logs ${where}`).get(...params) as Row).count)
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50)))
    const offset = Math.max(0, Math.trunc(input.offset ?? 0))
    const rows = this.db.prepare(`SELECT * FROM message_logs ${where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[]
    return { items: rows.map(this.messageLog), total }
  }

  getMessageLog(id: string): MessageLogRecord {
    const row = this.db.prepare('SELECT * FROM message_logs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Message log not found')
    return this.messageLog(row)
  }

  private messageLog = (row: Row): MessageLogRecord => ({
    id: String(row.id), eventId: String(row.event_id), messageId: String(row.message_id),
    botId: String(row.bot_id), botName: String(row.bot_name), chatId: String(row.chat_id), topicId: String(row.topic_id), senderId: String(row.sender_id),
    messageType: String(row.message_type), inboundContent: String(row.inbound_content), responseContent: String(row.response_content),
    status: String(row.status) as MessageLogRecord['status'], error: String(row.error),
    workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), sceneId: String(row.scene_id), sceneName: String(row.scene_name),
    skillPackages: (() => { try { return JSON.parse(String(row.skill_packages_json)) as Array<{ id: string; name: string }> } catch { return [] } })(),
    receivedAt: String(row.received_at), startedAt: String(row.started_at), completedAt: String(row.completed_at),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  })

  getBotSecret(botId: string): string {
    const row = this.db.prepare('SELECT app_secret_encrypted FROM bots WHERE id = ?').get(botId) as Row | undefined
    if (!row) throw new Error('Bot not found')
    return String(row.app_secret_encrypted)
  }

  bindGroupScene(botId: string, chatId: string, sceneId: string, actorId: string): void {
    const scene = this.getScene(sceneId)
    if (scene.botId !== botId) throw new Error('Scene does not belong to this Bot')
    const timestamp = now()
    this.db.prepare(`INSERT INTO group_scene_bindings (bot_id, chat_id, scene_id, bound_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id) DO UPDATE SET scene_id = excluded.scene_id, bound_by = excluded.bound_by, updated_at = excluded.updated_at`)
      .run(botId, chatId, sceneId, actorId, timestamp, timestamp)
    this.createAuditLog({ action: 'scene.bind_group', targetType: 'scene', targetId: sceneId, summary: `通过飞书将群 ${chatId} 绑定到场景 ${scene.name}`, details: { botId, chatId, feishuActorId: actorId } })
  }

  resolveRoute(botId: string, message: ChannelInboundMessage): ResolvedRoute {
    const bot = this.getBot(botId)
    const binding = this.db.prepare('SELECT scene_id FROM group_scene_bindings WHERE bot_id = ? AND chat_id = ?').get(botId, message.conversation.id) as Row | undefined
    const candidates = this.listScenes().filter(scene => scene.botId === botId && scene.enabled)
    const bound = binding ? candidates.find(scene => scene.id === String(binding.scene_id)) ?? null : null
    const scene = bound ?? candidates.find(candidate => this.sceneMatches(candidate, message)) ?? null
    const workspace = this.getWorkspace(scene?.workspaceId ?? bot.defaultWorkspaceId)
    const packages = scene ? this.listSkillPackages().filter(item => scene.skillPackageIds.includes(item.id)) : []
    const replyMode = scene?.replyMode && scene.replyMode !== 'inherit' ? scene.replyMode : bot.replyMode
    const topic = replyMode === 'topic' ? (message.conversation.rootId || message.messageId) : ''
    const conversationKey = scene ? `scene:${bot.id}:${scene.id}:${message.conversation.id}` : topic ? `chat:${bot.id}:${message.conversation.id}:topic:${topic}` : `chat:${bot.id}:${message.conversation.id}`
    const layers = [this.getPlatformPrompt(), workspace.prompt, bot.prompt, scene?.prompt ?? '', ...packages.map(item => item.prompt)]
      .map(value => value.trim()).filter(Boolean)
    return { bot, workspace, scene, skillPackages: packages, replyMode, conversationKey, systemPrompt: layers.join('\n\n') }
  }

  messageMatchesScene(sceneId: string, message: ChannelInboundMessage): boolean {
    return this.sceneMatches(this.getScene(sceneId), message)
  }

  getOrCreateConversation(route: ResolvedRoute, chatId: string, topicId: string): { id: string; threadId: string } {
    const existing = this.db.prepare('SELECT id, core_thread_id FROM conversation_routes WHERE id = ?').get(route.conversationKey) as Row | undefined
    if (existing) return { id: String(existing.id), threadId: String(existing.core_thread_id) }
    const timestamp = now()
    this.db.prepare(`INSERT INTO conversation_routes (id, bot_id, scene_id, workspace_id, chat_id, topic_id, core_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`)
      .run(route.conversationKey, route.bot.id, route.scene?.id ?? null, route.workspace.id, chatId, topicId, timestamp, timestamp)
    return { id: route.conversationKey, threadId: '' }
  }

  setConversationThread(id: string, threadId: string): void {
    this.db.prepare('UPDATE conversation_routes SET core_thread_id = ?, updated_at = ? WHERE id = ?').run(threadId, now(), id)
  }

  claimInboundEvent(botId: string, eventId: string, messageId: string): boolean {
    this.db.prepare('DELETE FROM inbound_events WHERE received_at < ?').run(new Date(Date.now() - 8 * 60 * 60_000).toISOString())
    const result = this.db.prepare('INSERT OR IGNORE INTO inbound_events (bot_id, event_id, message_id, received_at) VALUES (?, ?, ?, ?)').run(botId, eventId, messageId, now())
    return result.changes > 0
  }

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

  private sceneMatches(scene: SceneRecord, message: ChannelInboundMessage): boolean {
    const matcher = scene.matcher
    const includes = (values: string[], target: string) => values.length === 0 || values.some(value => target.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
    if (matcher.chatIds.length && !matcher.chatIds.includes(message.conversation.id)) return false
    if (matcher.messageTypes.length && !matcher.messageTypes.includes(message.content?.type ?? '')) return false
    if (!includes(matcher.textIncludes, message.text)) return false
    if (!includes(matcher.cardTitleIncludes, message.content?.title ?? '')) return false
    return true
  }
}
