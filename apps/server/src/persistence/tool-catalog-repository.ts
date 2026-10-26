import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, jsonObject as object, stringList as list, type DatabaseRow as Row } from '../db-values.js'
import type { SkillPackageRecord, ToolPackageExecutionRecord, ToolPackageRecord, ToolRecord, ToolScriptVersionRecord } from '../types.js'
import { assertTransition } from '../state-transitions.js'
import type { BotSceneRepository } from './bot-scene-repository.js'

export type ToolWriteInput = Omit<ToolRecord, 'id' | 'createdAt' | 'updatedAt' | 'rpcConfig' | 'scriptLanguage' | 'scriptContent' | 'scriptVersion'> & Partial<Pick<ToolRecord, 'rpcConfig' | 'scriptLanguage' | 'scriptContent' | 'scriptVersion'>>

export class ToolCatalogRepository {
  constructor(readonly db: DatabaseSync, private readonly botScenes: BotSceneRepository) {}

  private assertWorkspaces(ids: string[]): void { this.botScenes.assertWorkspaces(ids) }

  recoverInterruptedToolExecutions(): number {
    const timestamp = now()
    return Number(this.db.prepare("UPDATE tool_package_executions SET status = 'failed', error = '服务在工具执行期间重启，外部副作用状态未知，请人工核对后再决定是否重试', completed_at = ?, updated_at = ? WHERE status = 'running'").run(timestamp, timestamp).changes)
  }
  listSkillPackages(): SkillPackageRecord[] {
    return (this.db.prepare('SELECT * FROM skill_packages ORDER BY name COLLATE NOCASE').all() as Row[]).map(this.skillPackage)
  }
  createSkillPackage(input: Omit<SkillPackageRecord, 'id' | 'createdAt' | 'updatedAt'>): SkillPackageRecord {
    this.assertWorkspaces([input.workspaceId])
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO skill_packages (id, workspace_id, name, description, prompt, skills_json, fallback_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId, input.name, input.description, input.prompt, JSON.stringify(input.skills), input.fallbackMode, timestamp, timestamp)
    this.setSkillPackageTools(id, input.toolPackageIds ?? [])
    return this.getSkillPackage(id)
  }
  updateSkillPackage(id: string, input: Omit<SkillPackageRecord, 'id' | 'createdAt' | 'updatedAt'>): SkillPackageRecord {
    this.assertWorkspaces([input.workspaceId])
    const incompatible = this.db.prepare(`SELECT COUNT(*) AS count FROM scene_skill_packages ssp JOIN scenes s ON s.id = ssp.scene_id WHERE ssp.skill_package_id = ? AND s.workspace_id <> ?`).get(id, input.workspaceId) as Row
    if (Number(incompatible.count) > 0) throw new Error('Linked Scenes use a different Workspace')
    const result = this.db.prepare(`UPDATE skill_packages SET workspace_id = ?, name = ?, description = ?, prompt = ?, skills_json = ?, fallback_mode = ?, updated_at = ? WHERE id = ?`)
      .run(input.workspaceId, input.name, input.description, input.prompt, JSON.stringify(input.skills), input.fallbackMode, now(), id)
    if (!result.changes) throw new Error('Skill Package not found')
    this.db.prepare('DELETE FROM skill_package_tool_packages WHERE skill_package_id = ?').run(id)
    this.setSkillPackageTools(id, input.toolPackageIds ?? [])
    return this.getSkillPackage(id)
  }
  deleteSkillPackage(id: string): void { if (!this.db.prepare('DELETE FROM skill_packages WHERE id = ?').run(id).changes) throw new Error('Skill Package not found') }
  private getSkillPackage(id: string): SkillPackageRecord {
    const row = this.db.prepare('SELECT * FROM skill_packages WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Skill Package not found')
    return this.skillPackage(row)
  }
  private setSkillPackageTools(id: string, ids: string[]): void {
    const add = this.db.prepare('INSERT INTO skill_package_tool_packages (skill_package_id, tool_package_id, position) VALUES (?, ?, ?)')
    ids.forEach((toolPackageId, index) => add.run(id, toolPackageId, index))
  }
  private skillPackage = (row: Row): SkillPackageRecord => ({
    id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), description: String(row.description), prompt: String(row.prompt), skills: list(row.skills_json),
    toolPackageIds: (this.db.prepare('SELECT tool_package_id FROM skill_package_tool_packages WHERE skill_package_id = ? ORDER BY position').all(String(row.id)) as Row[]).map(item => String(item.tool_package_id)),
    fallbackMode: String(row.fallback_mode) as SkillPackageRecord['fallbackMode'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  listTools(): ToolRecord[] { return (this.db.prepare('SELECT * FROM tools ORDER BY name COLLATE NOCASE').all() as Row[]).map(this.tool) }
  getTool(id: string): ToolRecord {
    const row = this.db.prepare('SELECT * FROM tools WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Tool not found')
    return this.tool(row)
  }
  createTool(input: ToolWriteInput): ToolRecord {
    this.assertWorkspaces([input.workspaceId])
    const id = randomUUID(), timestamp = now()
    const scriptContent = input.scriptContent ?? '', scriptLanguage = scriptContent ? (input.scriptLanguage || 'python') : '', scriptVersion = scriptContent ? 1 : 0
    this.db.prepare('INSERT INTO tools (id, workspace_id, name, description, executor_type, command, arguments_template_json, input_schema_json, rpc_config_json, script_language, script_content, script_version, timeout_seconds, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.workspaceId, input.name, input.description, input.executorType, input.command, JSON.stringify(input.argumentsTemplate), JSON.stringify(input.inputSchema), JSON.stringify(input.rpcConfig ?? {}), scriptLanguage, scriptContent, scriptVersion, input.timeoutSeconds, input.enabled ? 1 : 0, timestamp, timestamp)
    if (scriptContent) this.db.prepare('INSERT INTO tool_script_versions (tool_id, version, language, content, created_at) VALUES (?, 1, ?, ?, ?)').run(id, scriptLanguage, scriptContent, timestamp)
    return this.getTool(id)
  }
  updateTool(id: string, input: ToolWriteInput): ToolRecord {
    this.assertWorkspaces([input.workspaceId])
    const current = this.getTool(id)
    const scriptContent = input.scriptContent ?? '', scriptLanguage = scriptContent ? (input.scriptLanguage || 'python') : ''
    const scriptChanged = scriptContent !== current.scriptContent || scriptLanguage !== current.scriptLanguage
    const latestVersionRow = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM tool_script_versions WHERE tool_id = ?').get(id) as Row
    const latestVersion = Number(latestVersionRow.version ?? 0)
    const scriptVersion = scriptContent ? (scriptChanged ? latestVersion + 1 : current.scriptVersion || latestVersion || 1) : 0
    const timestamp = now()
    const result = this.db.prepare('UPDATE tools SET workspace_id = ?, name = ?, description = ?, executor_type = ?, command = ?, arguments_template_json = ?, input_schema_json = ?, rpc_config_json = ?, script_language = ?, script_content = ?, script_version = ?, timeout_seconds = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(input.workspaceId, input.name, input.description, input.executorType, input.command, JSON.stringify(input.argumentsTemplate), JSON.stringify(input.inputSchema), JSON.stringify(input.rpcConfig ?? {}), scriptLanguage, scriptContent, scriptVersion, input.timeoutSeconds, input.enabled ? 1 : 0, timestamp, id)
    if (!result.changes) throw new Error('Tool not found')
    if (scriptContent && scriptChanged) this.db.prepare('INSERT INTO tool_script_versions (tool_id, version, language, content, created_at) VALUES (?, ?, ?, ?, ?)').run(id, scriptVersion, scriptLanguage, scriptContent, timestamp)
    return this.getTool(id)
  }
  deleteTool(id: string): void { if (!this.db.prepare('DELETE FROM tools WHERE id = ?').run(id).changes) throw new Error('Tool not found') }
  listToolScriptVersions(id: string): ToolScriptVersionRecord[] {
    return (this.db.prepare('SELECT tool_id, version, language, content, created_at FROM tool_script_versions WHERE tool_id = ? ORDER BY version DESC').all(id) as Row[]).map(row => ({ toolId: String(row.tool_id), version: Number(row.version), language: String(row.language) as ToolScriptVersionRecord['language'], content: String(row.content), createdAt: String(row.created_at) }))
  }
  private tool = (row: Row): ToolRecord => ({ id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), description: String(row.description), executorType: String(row.executor_type) as ToolRecord['executorType'], command: String(row.command), argumentsTemplate: list(row.arguments_template_json), inputSchema: object(row.input_schema_json), rpcConfig: object(row.rpc_config_json) as unknown as ToolRecord['rpcConfig'], scriptLanguage: String(row.script_language ?? '') as ToolRecord['scriptLanguage'], scriptContent: String(row.script_content ?? ''), scriptVersion: Number(row.script_version ?? 0), timeoutSeconds: Number(row.timeout_seconds), enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })

  listToolPackages(): ToolPackageRecord[] { return (this.db.prepare('SELECT * FROM tool_packages ORDER BY name COLLATE NOCASE').all() as Row[]).map(this.toolPackage) }
  getToolPackage(id: string): ToolPackageRecord {
    const row = this.db.prepare('SELECT * FROM tool_packages WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Tool Package not found')
    return this.toolPackage(row)
  }
  createToolPackage(input: Omit<ToolPackageRecord, 'id' | 'createdAt' | 'updatedAt'>): ToolPackageRecord {
    this.assertWorkspaces([input.workspaceId]); const id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO tool_packages (id, workspace_id, name, description, prompt, approval_required, approver_ids_json, card_title, card_description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.workspaceId, input.name, input.description, input.prompt, input.approvalRequired ? 1 : 0, JSON.stringify(input.approverIds), input.cardTitle, input.cardDescription, input.enabled ? 1 : 0, timestamp, timestamp)
    this.setToolPackageSteps(id, input.steps)
    return this.getToolPackage(id)
  }
  updateToolPackage(id: string, input: Omit<ToolPackageRecord, 'id' | 'createdAt' | 'updatedAt'>): ToolPackageRecord {
    this.assertWorkspaces([input.workspaceId])
    const result = this.db.prepare('UPDATE tool_packages SET workspace_id = ?, name = ?, description = ?, prompt = ?, approval_required = ?, approver_ids_json = ?, card_title = ?, card_description = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(input.workspaceId, input.name, input.description, input.prompt, input.approvalRequired ? 1 : 0, JSON.stringify(input.approverIds), input.cardTitle, input.cardDescription, input.enabled ? 1 : 0, now(), id)
    if (!result.changes) throw new Error('Tool Package not found')
    this.db.prepare('DELETE FROM tool_package_steps WHERE tool_package_id = ?').run(id); this.setToolPackageSteps(id, input.steps)
    return this.getToolPackage(id)
  }
  deleteToolPackage(id: string): void { if (!this.db.prepare('DELETE FROM tool_packages WHERE id = ?').run(id).changes) throw new Error('Tool Package not found') }
  private setToolPackageSteps(id: string, steps: ToolPackageRecord['steps']): void {
    const add = this.db.prepare('INSERT INTO tool_package_steps (tool_package_id, tool_id, phase, position, arguments_json) VALUES (?, ?, ?, ?, ?)')
    steps.forEach((step, index) => add.run(id, step.toolId, step.phase, index, JSON.stringify(step.arguments)))
  }
  private toolPackage = (row: Row): ToolPackageRecord => ({
    id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), description: String(row.description), prompt: String(row.prompt), approvalRequired: Boolean(row.approval_required), approverIds: list(row.approver_ids_json), cardTitle: String(row.card_title), cardDescription: String(row.card_description), enabled: Boolean(row.enabled),
    steps: (this.db.prepare('SELECT s.*, t.name AS tool_name FROM tool_package_steps s JOIN tools t ON t.id = s.tool_id WHERE s.tool_package_id = ? ORDER BY s.position').all(String(row.id)) as Row[]).map(item => ({ toolId: String(item.tool_id), toolName: String(item.tool_name), phase: String(item.phase) as 'precheck' | 'execute' | 'verify', position: Number(item.position), arguments: object(item.arguments_json) })),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  createToolPackageExecution(input: Pick<ToolPackageExecutionRecord, 'callId' | 'toolPackageId' | 'botId' | 'sceneId' | 'chatId' | 'topicId' | 'threadChannelId' | 'coreThreadId' | 'sourceMessageId' | 'arguments' | 'reason' | 'requestedBy'> & { status: ToolPackageExecutionRecord['status'] }): ToolPackageExecutionRecord {
    const pack = this.getToolPackage(input.toolPackageId), id = randomUUID(), timestamp = now()
    this.db.prepare('INSERT INTO tool_package_executions (id, call_id, tool_package_id, tool_package_name, bot_id, scene_id, chat_id, topic_id, thread_channel_id, core_thread_id, source_message_id, status, arguments_json, reason, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.callId, pack.id, pack.name, input.botId, input.sceneId, input.chatId, input.topicId, input.threadChannelId, input.coreThreadId, input.sourceMessageId, input.status, JSON.stringify(input.arguments), input.reason, input.requestedBy, timestamp, timestamp)
    return this.getToolPackageExecution(id)
  }
  getToolPackageExecution(id: string): ToolPackageExecutionRecord {
    const row = this.db.prepare('SELECT * FROM tool_package_executions WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Tool Package execution not found')
    return this.toolPackageExecution(row)
  }
  findToolPackageExecution(threadChannelId: string, callId: string): ToolPackageExecutionRecord | null {
    const row = this.db.prepare('SELECT * FROM tool_package_executions WHERE thread_channel_id = ? AND call_id = ?').get(threadChannelId, callId) as Row | undefined
    return row ? this.toolPackageExecution(row) : null
  }
  listToolPackageExecutions(limit = 100): ToolPackageExecutionRecord[] { return (this.db.prepare('SELECT * FROM tool_package_executions ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(this.toolPackageExecution) }
  listQueuedToolPackageExecutions(limit = 500): ToolPackageExecutionRecord[] { return (this.db.prepare("SELECT * FROM tool_package_executions WHERE status = 'queued' ORDER BY created_at LIMIT ?").all(Math.min(1_000, Math.max(1, limit))) as Row[]).map(this.toolPackageExecution) }
  updateToolPackageExecution(id: string, patch: Partial<Pick<ToolPackageExecutionRecord, 'status' | 'approvedBy' | 'cardMessageId' | 'result' | 'error' | 'completedAt'>>): ToolPackageExecutionRecord {
    const current = this.getToolPackageExecution(id)
    assertTransition('toolExecution', current.status, patch.status ?? current.status)
    const changed = this.db.prepare('UPDATE tool_package_executions SET status = ?, approved_by = ?, card_message_id = ?, result_json = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(patch.status ?? current.status, patch.approvedBy ?? current.approvedBy, patch.cardMessageId ?? current.cardMessageId, JSON.stringify(patch.result === undefined ? current.result : patch.result), patch.error ?? current.error, patch.completedAt ?? current.completedAt, now(), id, current.status).changes
    if (!changed) throw new Error('Tool Package execution changed concurrently')
    return this.getToolPackageExecution(id)
  }
  transitionToolPackageExecution(id: string, from: ToolPackageExecutionRecord['status'], to: ToolPackageExecutionRecord['status'], approvedBy = '', completedAt = ''): ToolPackageExecutionRecord | null {
    assertTransition('toolExecution', from, to)
    const result = this.db.prepare('UPDATE tool_package_executions SET status = ?, approved_by = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, approvedBy, completedAt, now(), id, from)
    return result.changes ? this.getToolPackageExecution(id) : null
  }
  private toolPackageExecution = (row: Row): ToolPackageExecutionRecord => ({ id: String(row.id), callId: String(row.call_id), toolPackageId: String(row.tool_package_id), toolPackageName: String(row.tool_package_name), botId: String(row.bot_id), sceneId: String(row.scene_id), chatId: String(row.chat_id), topicId: String(row.topic_id), threadChannelId: String(row.thread_channel_id), coreThreadId: String(row.core_thread_id), sourceMessageId: String(row.source_message_id), status: String(row.status) as ToolPackageExecutionRecord['status'], arguments: object(row.arguments_json), reason: String(row.reason), requestedBy: String(row.requested_by), approvedBy: String(row.approved_by), cardMessageId: String(row.card_message_id), result: (() => { try { return JSON.parse(String(row.result_json)) as unknown } catch { return null } })(), error: String(row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: String(row.completed_at) })
}
