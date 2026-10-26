import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, stringList as list, validateSceneTimeout, type DatabaseRow as Row } from '../db-values.js'
import type { AgentRuntimeKind, BotRecord, SceneRecord } from '../types.js'

type SceneWriteInput = Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt' | 'model' | 'reasoningEffort' | 'retrieval' | 'completionStatisticsEnabled' | 'requireMention' | 'turnTimeoutMinutes'> & {
  turnTimeoutMinutes?: number
  requireMention?: boolean
  completionStatisticsEnabled?: boolean
  model?: string
  reasoningEffort?: string
  retrieval?: SceneRecord['retrieval']
  skillPackageIds?: string[]
}

export class BotSceneRepository {
  constructor(readonly db: DatabaseSync) {}

  listBots(): BotRecord[] {
    return (this.db.prepare('SELECT * FROM bots ORDER BY name COLLATE NOCASE').all() as Row[]).map(row => this.bot(row))
  }
  createBot(input: { name: string; description?: string; appId?: string; appSecretEncrypted?: string; prompt?: string; permissions?: string[]; operatorIds?: string[]; conversationMode?: 'chat' | 'topic'; botMessagePolicy?: BotRecord['botMessagePolicy']; mentionSourceBot?: boolean; botSourceAllowlist?: string[]; maxBotReplyDepth?: number; runtimeKind?: AgentRuntimeKind; model?: string; reasoningEffort?: string; defaultWorkspaceId: string; workspaceIds?: string[] }): BotRecord {
    const workspaceIds = [...new Set([input.defaultWorkspaceId, ...(input.workspaceIds ?? [])])]
    this.assertWorkspaces(workspaceIds)
    const id = randomUUID(), timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO bots (id, name, description, app_id, app_secret_encrypted, prompt, permissions_json, conversation_mode, bot_message_policy, mention_source_bot, bot_source_allowlist_json, max_bot_reply_depth, runtime_kind, model, reasoning_effort, default_workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.description ?? '', input.appId ?? '', input.appSecretEncrypted ?? '', input.prompt ?? '', JSON.stringify(input.permissions ?? []), input.conversationMode ?? 'chat', input.botMessagePolicy ?? 'mentioned_or_scene', input.mentionSourceBot === false ? 0 : 1, JSON.stringify(input.botSourceAllowlist ?? []), Math.max(0, Math.min(10, Math.trunc(input.maxBotReplyDepth ?? 1))), input.runtimeKind ?? 'codex', input.model ?? '', input.reasoningEffort ?? '', input.defaultWorkspaceId, timestamp, timestamp)
      const add = this.db.prepare('INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)')
      for (const workspaceId of workspaceIds) add.run(id, workspaceId)
      this.setBotOperators(id, input.operatorIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBot(id)
  }
  updateBot(id: string, input: { name: string; description?: string; appId?: string; appSecretEncrypted?: string | null; prompt?: string; permissions?: string[]; operatorIds?: string[]; conversationMode?: 'chat' | 'topic'; botMessagePolicy?: BotRecord['botMessagePolicy']; mentionSourceBot?: boolean; botSourceAllowlist?: string[]; maxBotReplyDepth?: number; runtimeKind?: AgentRuntimeKind; model?: string; reasoningEffort?: string; defaultWorkspaceId: string; workspaceIds?: string[] }): BotRecord {
    const workspaceIds = [...new Set([input.defaultWorkspaceId, ...(input.workspaceIds ?? [])])]
    this.assertWorkspaces(workspaceIds)
    const current = this.db.prepare('SELECT app_secret_encrypted FROM bots WHERE id = ?').get(id) as Row | undefined
    if (!current) throw new Error('Bot not found')
    const removed = this.db.prepare(`SELECT COUNT(*) AS count FROM scenes WHERE bot_id = ? AND workspace_id NOT IN (${workspaceIds.map(() => '?').join(',')})`).get(id, ...workspaceIds) as Row
    if (Number(removed.count) > 0) throw new Error('A Scene still uses a Workspace removed from this Bot')
    const secret = input.appSecretEncrypted === null || input.appSecretEncrypted === undefined ? String(current.app_secret_encrypted) : input.appSecretEncrypted
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE bots SET name = ?, description = ?, app_id = ?, app_secret_encrypted = ?, prompt = ?, permissions_json = ?, conversation_mode = ?, bot_message_policy = ?, mention_source_bot = ?, bot_source_allowlist_json = ?, max_bot_reply_depth = ?, runtime_kind = ?, model = ?, reasoning_effort = ?, default_workspace_id = ?, updated_at = ? WHERE id = ?`)
        .run(input.name, input.description ?? '', input.appId ?? '', secret, input.prompt ?? '', JSON.stringify(input.permissions ?? []), input.conversationMode ?? 'chat', input.botMessagePolicy ?? 'mentioned_or_scene', input.mentionSourceBot === false ? 0 : 1, JSON.stringify(input.botSourceAllowlist ?? []), Math.max(0, Math.min(10, Math.trunc(input.maxBotReplyDepth ?? 1))), input.runtimeKind ?? 'codex', input.model ?? '', input.reasoningEffort ?? '', input.defaultWorkspaceId, now(), id)
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
  getBot(id: string): BotRecord {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Bot not found')
    return this.bot(row)
  }
  private bot(row: Row): BotRecord {
    const workspaceIds = (this.db.prepare('SELECT workspace_id FROM bot_workspaces WHERE bot_id = ? ORDER BY workspace_id').all(String(row.id)) as Row[]).map(item => String(item.workspace_id))
    const operatorIds = (this.db.prepare('SELECT feishu_open_id FROM bot_operators WHERE bot_id = ? ORDER BY feishu_open_id').all(String(row.id)) as Row[]).map(item => String(item.feishu_open_id))
    return { id: String(row.id), name: String(row.name), description: String(row.description), appId: String(row.app_id), hasAppSecret: Boolean(row.app_secret_encrypted), prompt: String(row.prompt), permissions: list(row.permissions_json), operatorIds, conversationMode: String(row.conversation_mode) as BotRecord['conversationMode'], botMessagePolicy: String(row.bot_message_policy || 'mentioned_or_scene') as BotRecord['botMessagePolicy'], mentionSourceBot: Boolean(row.mention_source_bot), botSourceAllowlist: list(row.bot_source_allowlist_json), maxBotReplyDepth: Math.max(0, Number(row.max_bot_reply_depth ?? 1)), runtimeKind: String(row.runtime_kind || 'codex') as AgentRuntimeKind, model: String(row.model), reasoningEffort: String(row.reasoning_effort), defaultWorkspaceId: String(row.default_workspace_id), workspaceIds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }
  private setBotOperators(botId: string, ids: string[]): void {
    const add = this.db.prepare('INSERT OR IGNORE INTO bot_operators (bot_id, feishu_open_id) VALUES (?, ?)')
    for (const id of [...new Set(ids.map(value => value.trim()).filter(Boolean))]) add.run(botId, id)
  }
  assertWorkspaces(ids: string[]): void {
    if (!ids.length) throw new Error('At least one Workspace is required')
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as Row
    if (Number(count.count) !== ids.length) throw new Error('Workspace not found')
  }

  listScenes(): Array<SceneRecord & { skillPackageIds: string[] }> {
    return (this.db.prepare('SELECT * FROM scenes ORDER BY priority ASC, name COLLATE NOCASE').all() as Row[]).map(row => this.scene(row))
  }
  createScene(input: SceneWriteInput): SceneRecord & { skillPackageIds: string[] } {
    validateSceneTimeout(input.turnTimeoutMinutes)
    this.assertBotWorkspace(input.botId, input.workspaceId)
    this.assertScenePackages(input.workspaceId, input.skillPackageIds ?? [])
    const id = randomUUID(), timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO scenes (id, bot_id, workspace_id, name, prompt, priority, enabled, model, reasoning_effort, retrieval_config_json, matcher_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.botId, input.workspaceId, input.name, input.prompt, input.priority, input.enabled ? 1 : 0, input.model ?? '', input.reasoningEffort ?? '', JSON.stringify(this.normalizeRetrieval(input.retrieval)), JSON.stringify(input.matcher), timestamp, timestamp)
      this.setScenePackages(id, input.skillPackageIds ?? [])
      this.db.prepare('UPDATE scenes SET completion_statistics_enabled = ? WHERE id = ?').run(input.completionStatisticsEnabled ? 1 : 0, id)
      this.db.prepare('UPDATE scenes SET require_mention = ? WHERE id = ?').run(input.requireMention === false ? 0 : 1, id)
      this.db.prepare('UPDATE scenes SET turn_timeout_minutes = ? WHERE id = ?').run(input.turnTimeoutMinutes ?? 15, id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getScene(id)
  }
  updateScene(id: string, input: SceneWriteInput): SceneRecord & { skillPackageIds: string[] } {
    validateSceneTimeout(input.turnTimeoutMinutes)
    this.assertBotWorkspace(input.botId, input.workspaceId)
    this.assertScenePackages(input.workspaceId, input.skillPackageIds ?? [])
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`UPDATE scenes SET bot_id = ?, workspace_id = ?, name = ?, prompt = ?, priority = ?, enabled = ?, model = ?, reasoning_effort = ?, retrieval_config_json = ?, matcher_json = ?, updated_at = ? WHERE id = ?`)
        .run(input.botId, input.workspaceId, input.name, input.prompt, input.priority, input.enabled ? 1 : 0, input.model ?? '', input.reasoningEffort ?? '', JSON.stringify(this.normalizeRetrieval(input.retrieval)), JSON.stringify(input.matcher), now(), id)
      if (!result.changes) throw new Error('Scene not found')
      this.db.prepare('DELETE FROM scene_skill_packages WHERE scene_id = ?').run(id)
      this.setScenePackages(id, input.skillPackageIds ?? [])
      this.db.prepare('UPDATE scenes SET completion_statistics_enabled = ? WHERE id = ?').run(input.completionStatisticsEnabled === undefined ? (this.getScene(id).completionStatisticsEnabled ? 1 : 0) : input.completionStatisticsEnabled ? 1 : 0, id)
      if (input.requireMention !== undefined) this.db.prepare('UPDATE scenes SET require_mention = ? WHERE id = ?').run(input.requireMention ? 1 : 0, id)
      if (input.turnTimeoutMinutes !== undefined) this.db.prepare('UPDATE scenes SET turn_timeout_minutes = ? WHERE id = ?').run(input.turnTimeoutMinutes, id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getScene(id)
  }
  deleteScene(id: string): void { if (!this.db.prepare('DELETE FROM scenes WHERE id = ?').run(id).changes) throw new Error('Scene not found') }
  getScene(id: string): SceneRecord & { skillPackageIds: string[] } {
    const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Scene not found')
    return this.scene(row)
  }
  private scene(row: Row): SceneRecord & { skillPackageIds: string[] } {
    const raw = JSON.parse(String(row.matcher_json)) as Partial<SceneRecord['matcher']>
    let retrieval: Partial<SceneRecord['retrieval']> = {}
    try { retrieval = JSON.parse(String(row.retrieval_config_json)) as Partial<SceneRecord['retrieval']> } catch { /* use defaults */ }
    const skillPackageIds = (this.db.prepare('SELECT skill_package_id FROM scene_skill_packages WHERE scene_id = ? ORDER BY position').all(String(row.id)) as Row[]).map(item => String(item.skill_package_id))
    return { turnTimeoutMinutes: Number(row.turn_timeout_minutes), requireMention: Boolean(row.require_mention), completionStatisticsEnabled: Boolean(row.completion_statistics_enabled), id: String(row.id), botId: String(row.bot_id), workspaceId: String(row.workspace_id), name: String(row.name), prompt: String(row.prompt), priority: Number(row.priority), enabled: Boolean(row.enabled), model: String(row.model), reasoningEffort: String(row.reasoning_effort), retrieval: this.normalizeRetrieval(retrieval), matcher: { chatIds: raw.chatIds ?? [], messageTypes: raw.messageTypes ?? [], textIncludes: raw.textIncludes ?? [], cardTitleIncludes: raw.cardTitleIncludes ?? [] }, skillPackageIds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }
  private normalizeRetrieval(value?: Partial<SceneRecord['retrieval']>): SceneRecord['retrieval'] {
    const skillBoosts = Array.isArray(value?.skillBoosts) ? value.skillBoosts
      .map(item => ({ keyword: String(item?.keyword ?? '').trim(), weight: Math.min(100, Math.max(0, Number(item?.weight) || 0)) }))
      .filter(item => item.keyword && item.weight > 0)
      .slice(0, 50) : []
    return {
      skillBoosts,
      skillCandidateLimit: Math.min(30, Math.max(1, Math.trunc(Number(value?.skillCandidateLimit) || 12))),
      knowledgeCandidateLimit: Math.min(30, Math.max(1, Math.trunc(Number(value?.knowledgeCandidateLimit) || 12))),
      minimumScore: Math.min(100, Math.max(0, Number(value?.minimumScore) || 1)),
    }
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
}
