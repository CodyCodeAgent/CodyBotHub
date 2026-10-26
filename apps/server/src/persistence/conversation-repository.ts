import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { databaseNow as now, jsonObject as object, jsonValue, stringList as list, type DatabaseRow as Row } from '../db-values.js'
import { hasSceneMatcher, sceneMatches } from '../scene-matching.js'
import { extractThreadFeatures, scoreThreadSimilarity } from '../thread-routing.js'
import { assertTransition } from '../state-transitions.js'
import type { AdminAccountRecord, AgentRuntimeKind, BotRecord, ChatMetadataRecord, ConversationThreadRecord, InvestigationTraceRecord, MessageAttemptRecord, MessageLogRecord, ModelConfigSource, ResolvedRoute, SceneRecord, SkillPackageRecord, ThreadChannelRecord, ThreadJobRecord, ThreadProfileRecord, ThreadRoutingDecision, ThreadRoutingRuleRecord } from '../types.js'
import type { BotSceneRepository } from './bot-scene-repository.js'
import type { WorkspaceRepository } from './workspace-repository.js'
import type { ToolCatalogRepository } from './tool-catalog-repository.js'
import type { PlatformSettingsRepository } from './platform-settings-repository.js'
import type { AuditRepository } from './audit-repository.js'
import type { HubTaskRepository } from './hub-task-repository.js'

type ConversationDependencies = {
  botScenes: BotSceneRepository
  workspaces: WorkspaceRepository
  toolCatalog: ToolCatalogRepository
  settings: PlatformSettingsRepository
  audit: AuditRepository
  hubTasks: HubTaskRepository
}

export class ConversationRepository {
  constructor(readonly db: DatabaseSync, private readonly deps: ConversationDependencies) {}

  createMessageLog(botId: string, route: ResolvedRoute, message: ChannelInboundMessage, botReplyDepth = 0): MessageLogRecord {
    const id = randomUUID()
    const startedAt = now()
    const channel = this.db.prepare('SELECT core_thread_id FROM thread_channels WHERE id = ?').get(route.threadChannelId) as Row | undefined
    const coreThreadId = String(channel?.core_thread_id ?? '')
    this.db.prepare(`INSERT INTO message_logs (
      id, event_id, message_id, bot_id, bot_name, runtime_kind, chat_id, topic_id, sender_id,
      message_type, inbound_content, inbound_raw_json, status, workspace_id, workspace_name,
      scene_id, scene_name, skill_packages_json, investigation_json, model, reasoning_effort, model_source,
      reasoning_effort_source, model_fallback, core_thread_id, thread_route_type, matched_thread_id,
      thread_match_score, thread_match_reason, thread_channel_id, received_at, started_at, bot_reply_depth
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, message.eventId, message.messageId, botId, route.bot.name, route.bot.runtimeKind,
        message.conversation.id, route.topicId, message.sender.id,
        message.content?.type ?? 'unknown', message.text.slice(0, 200_000), JSON.stringify(message.content?.raw ?? null).slice(0, 500_000),
        route.workspace.id, route.workspace.name, route.scene?.id ?? '', route.scene?.name ?? '',
        JSON.stringify(route.skillPackages.map(item => ({ id: item.id, name: item.name }))),
        route.modelConfig.model, route.modelConfig.reasoningEffort, route.modelConfig.modelSource, route.modelConfig.reasoningEffortSource, coreThreadId,
        route.threadRouting.type, route.threadRouting.matchedThreadId, route.threadRouting.score, route.threadRouting.reason,
        route.threadChannelId, message.createdAtIso, startedAt, botReplyDepth,
      )
    return this.getMessageLog(id)
  }

  acceptInboundMessage(botId: string, route: ResolvedRoute, message: ChannelInboundMessage, botReplyDepth = 0): { log: MessageLogRecord; job: ThreadJobRecord } | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM inbound_events WHERE received_at < ?').run(new Date(Date.now() - 8 * 60 * 60_000).toISOString())
      const duplicate = this.db.prepare('SELECT 1 FROM message_logs WHERE bot_id = ? AND message_id = ?').get(botId, message.messageId)
      if (duplicate) { this.db.exec('ROLLBACK'); return null }
      const claim = this.db.prepare('INSERT OR IGNORE INTO inbound_events (bot_id, event_id, message_id, received_at) VALUES (?, ?, ?, ?)').run(botId, message.eventId, message.messageId, now())
      if (!claim.changes) { this.db.exec('ROLLBACK'); return null }
      const log = this.createMessageLog(botId, route, message, botReplyDepth)
      const job = this.enqueueThreadJob(botId, route.threadChannelId, message, log.id)
      this.deps.hubTasks.createHubTask({
        kind: 'agent_turn', origin: 'feishu', principal: message.sender.id || 'unknown', idempotencyKey: `${botId}:${message.messageId}:attempt:1`,
        taskInput: { text: message.text, messageId: message.messageId, conversationId: message.conversation.id },
        botId, sceneId: route.scene?.id ?? '', threadChannelId: route.threadChannelId, sourceKind: 'thread_job', sourceId: job.id,
      })
      this.db.exec('COMMIT')
      return { log, job }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  botReplyDepthFor(botId: string, message: ChannelInboundMessage): number {
    if (message.sender.type === 'user') return 0
    if (message.replyTo) {
      const parent = this.db.prepare('SELECT bot_reply_depth FROM outbound_messages WHERE message_id = ?').get(message.replyTo) as Row | undefined
      if (parent) return Number(parent.bot_reply_depth || 0) + 1
    }
    // Topic replies often point only at the topic root instead of the exact
    // message they answer. In that shape Core intentionally omits replyTo, so
    // recover the collaboration lineage from this Bot's latest outbound in the
    // same visible conversation. The short window bounds false correlation
    // while still covering a normal Bot handoff.
    const atMs = Date.parse(message.createdAtIso)
    const cutoff = new Date((Number.isFinite(atMs) ? atMs : Date.now()) - 2 * 60_000).toISOString()
    const topicId = message.conversation.rootId ?? ''
    const prior = this.db.prepare(`SELECT outbound.bot_reply_depth
      FROM outbound_messages outbound
      JOIN message_logs log ON log.id = outbound.message_log_id
      WHERE outbound.bot_id = ? AND log.chat_id = ? AND outbound.created_at >= ?
        AND (log.topic_id = ? OR log.topic_id = '')
      ORDER BY CASE WHEN log.topic_id = ? THEN 0 ELSE 1 END,
        outbound.created_at DESC, outbound.rowid DESC LIMIT 1`).get(botId, message.conversation.id, cutoff, topicId, topicId) as Row | undefined
    return prior ? Number(prior.bot_reply_depth || 0) + 1 : 1
  }

  recordOutboundMessage(logId: string, botId: string, messageId: string, botReplyDepth: number): void {
    if (!messageId) return
    this.db.prepare(`INSERT OR IGNORE INTO outbound_messages (message_id, message_log_id, bot_id, bot_reply_depth, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(messageId, logId, botId, Math.max(0, Math.trunc(botReplyDepth)), now())
  }

  finishMessageLog(id: string, update: { responseContent?: string; error?: string }): MessageLogRecord {
    const current = this.getMessageLog(id)
    const nextStatus = update.error ? 'failed' : 'completed'
    if (current.status !== 'processing') throw new Error(`Invalid messageLog transition: ${current.status} -> ${nextStatus}`)
    assertTransition('messageLog', current.status, nextStatus)
    const completedAt = now()
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(current.startedAt))
    const error = update.error?.slice(0, 20_000) ?? ''
    const changed = this.db.prepare(`UPDATE message_logs SET response_content = ?, status = ?, error = ?, completed_at = ?, duration_ms = ? WHERE id = ? AND status = ?`)
      .run((update.responseContent ?? '').slice(0, 500_000), nextStatus, error, completedAt, durationMs, id, current.status).changes
    if (!changed) throw new Error('Message log changed concurrently')
    this.db.prepare(`UPDATE message_attempts SET status = ?, response_content = ?, error = ?, model = (SELECT model FROM message_logs WHERE id = ?),
      reasoning_effort = (SELECT reasoning_effort FROM message_logs WHERE id = ?), completed_at = ?, duration_ms = ?, updated_at = ?
      WHERE log_id = ? AND attempt_number = (SELECT attempts FROM thread_jobs WHERE log_id = ?)`)
      .run(error ? 'failed' : 'completed', (update.responseContent ?? '').slice(0, 500_000), error, id, id, completedAt, durationMs, completedAt, id, id)
    if (!error) this.db.prepare(`INSERT INTO thread_profile_jobs (log_id, created_at, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(log_id) DO UPDATE SET error = '', updated_at = excluded.updated_at`).run(id, completedAt, completedAt)
    return this.getMessageLog(id)
  }

  setMessageLogModel(id: string, update: { model: string; reasoningEffort: string; modelSource: ModelConfigSource; reasoningEffortSource: ModelConfigSource; fallback: boolean }): MessageLogRecord {
    this.db.prepare('UPDATE message_logs SET model = ?, reasoning_effort = ?, model_source = ?, reasoning_effort_source = ?, model_fallback = ? WHERE id = ?')
      .run(update.model, update.reasoningEffort, update.modelSource, update.reasoningEffortSource, update.fallback ? 1 : 0, id)
    return this.getMessageLog(id)
  }

  setMessageLogInvestigation(id: string, trace: InvestigationTraceRecord): MessageLogRecord {
    this.db.prepare('UPDATE message_logs SET investigation_json = ? WHERE id = ?').run(JSON.stringify(trace).slice(0, 500_000), id)
    return this.getMessageLog(id)
  }

  setMessageLogThread(id: string, coreThreadId: string): MessageLogRecord {
    this.db.prepare('UPDATE message_logs SET core_thread_id = ? WHERE id = ?').run(coreThreadId, id)
    return this.getMessageLog(id)
  }

  getThreadChannel(id: string): { id: string; threadId: string; runtimeKind: AgentRuntimeKind; toolContractVersion: number } {
    const row = this.db.prepare('SELECT id, core_thread_id, runtime_kind, tool_contract_version FROM thread_channels WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Thread Channel not found')
    return { id: String(row.id), threadId: String(row.core_thread_id), runtimeKind: String(row.runtime_kind || 'codex') as AgentRuntimeKind, toolContractVersion: Number(row.tool_contract_version || 0) }
  }

  setThreadChannelCoreThread(id: string, coreThreadId: string, toolContractVersion?: number): void {
    const result = toolContractVersion === undefined
      ? this.db.prepare('UPDATE thread_channels SET core_thread_id = ?, updated_at = ? WHERE id = ?').run(coreThreadId, now(), id)
      : this.db.prepare('UPDATE thread_channels SET core_thread_id = ?, tool_contract_version = ?, updated_at = ? WHERE id = ?').run(coreThreadId, toolContractVersion, now(), id)
    if (!result.changes) throw new Error('Thread Channel not found')
  }

  threadChannelMigrationContext(threadChannelId: string, excludeLogId = '', limit = 4): string {
    const rows = this.db.prepare(`SELECT inbound_content, response_content, received_at
      FROM message_logs
      WHERE thread_channel_id = ? AND id <> ? AND status = 'completed' AND response_content <> ''
      ORDER BY received_at DESC, id DESC LIMIT ?`).all(threadChannelId, excludeLogId, Math.min(8, Math.max(1, limit))) as Row[]
    return rows.reverse().map(row => [
      `时间：${String(row.received_at)}`,
      `用户消息：\n${String(row.inbound_content).slice(0, 20_000)}`,
      `助手回复：\n${String(row.response_content).slice(0, 20_000)}`,
    ].join('\n')).join('\n\n---\n\n').slice(-80_000)
  }

  enqueueThreadJob(botId: string, threadChannelId: string, message: ChannelInboundMessage, logId: string, receiptReactionId = ''): ThreadJobRecord {
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO thread_jobs (id, bot_id, thread_channel_id, event_id, message_id, message_json, status, log_id, receipt_reaction_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(id, botId, threadChannelId, message.eventId, message.messageId, JSON.stringify(message).slice(0, 1_000_000), logId, receiptReactionId, timestamp, timestamp)
    return this.getThreadJob(id)
  }

  recoverInterruptedWork(error = '服务在任务完成前重启，执行已中断'): { jobs: number; messages: number; tasks: number } {
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const jobs = Number(this.db.prepare(`UPDATE thread_jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE status = 'processing'`)
        .run(error, timestamp, timestamp).changes)
      const tasks = Number(this.db.prepare(`UPDATE hub_tasks SET status = 'failed', error = ?, completed_at = ?, updated_at = ?, revision = revision + 1
        WHERE status IN ('running', 'awaiting_approval')`).run(error, timestamp, timestamp).changes)
      const pending = this.db.prepare(`SELECT m.id, m.started_at FROM message_logs m WHERE m.status = 'processing' AND NOT EXISTS (
        SELECT 1 FROM thread_jobs tj WHERE tj.log_id = m.id AND tj.status IN ('queued', 'processing')
      )`).all() as Row[]
      const updateLog = this.db.prepare("UPDATE message_logs SET status = 'failed', error = ?, completed_at = ?, duration_ms = ? WHERE id = ? AND status = 'processing'")
      const updateAttempt = this.db.prepare(`UPDATE message_attempts SET status = 'failed', error = ?, completed_at = ?, duration_ms = ?, updated_at = ?
        WHERE log_id = ? AND attempt_number = (SELECT attempts FROM thread_jobs WHERE log_id = ?)`)
      let messages = 0
      for (const row of pending) {
        const id = String(row.id), durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(String(row.started_at)))
        messages += Number(updateLog.run(error, timestamp, durationMs, id).changes)
        updateAttempt.run(error, timestamp, durationMs, timestamp, id, id)
      }
      this.db.exec('COMMIT')
      return { jobs, messages, tasks }
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause }
  }

  listQueuedThreadJobs(limit = 200): Array<{ job: ThreadJobRecord; message: ChannelInboundMessage }> {
    const rows = this.db.prepare("SELECT * FROM thread_jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?").all(Math.min(1_000, Math.max(1, limit))) as Row[]
    return rows.flatMap(row => {
      try { return [{ job: this.threadJob(row), message: JSON.parse(String(row.message_json)) as ChannelInboundMessage }] }
      catch { this.finishThreadJob(String(row.id), 'failed', '队列中的消息数据损坏'); return [] }
    })
  }

  startThreadJob(id: string): boolean {
    assertTransition('threadJob', 'queued', 'processing')
    const timestamp = now()
    const changed = this.db.prepare("UPDATE thread_jobs SET status = 'processing', attempts = attempts + 1, started_at = ?, completed_at = '', error = '', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(timestamp, timestamp, id).changes > 0
    if (changed) this.db.prepare(`UPDATE message_attempts SET status = 'processing', started_at = ?, updated_at = ?
      WHERE log_id = (SELECT log_id FROM thread_jobs WHERE id = ?) AND attempt_number = (SELECT attempts FROM thread_jobs WHERE id = ?)`)
      .run(timestamp, timestamp, id, id)
    if (changed) {
      const task = this.deps.hubTasks.latestHubTaskForSource('thread_job', id)
      if (task?.status === 'queued') this.deps.hubTasks.transitionHubTask(task.id, { type: 'start' })
    }
    return changed
  }

  finishThreadJob(id: string, status: 'completed' | 'failed', error = ''): void {
    const timestamp = now()
    const current = this.getThreadJob(id)
    assertTransition('threadJob', current.status, status)
    const changed = this.db.prepare('UPDATE thread_jobs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(status, error.slice(0, 20_000), timestamp, timestamp, id, current.status).changes
    if (!changed) throw new Error('Thread job changed concurrently')
    const task = this.deps.hubTasks.latestHubTaskForSource('thread_job', id)
    if (task && !['completed', 'failed', 'cancelled'].includes(task.status)) {
      if (status === 'failed') this.deps.hubTasks.transitionHubTask(task.id, { type: 'fail', error: error || 'Task failed' })
      else {
        const job = this.getThreadJob(id), log = this.getMessageLog(job.logId)
        this.deps.hubTasks.transitionHubTask(task.id, { type: 'complete', result: { text: log.responseContent } })
      }
    }
  }

  failThreadJob(id: string, error: string): void {
    const job = this.getThreadJob(id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.finishThreadJob(id, 'failed', error)
      if (this.getMessageLog(job.logId).status === 'processing') this.finishMessageLog(job.logId, { error })
      this.db.exec('COMMIT')
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause }
  }

  setThreadJobReceiptReaction(id: string, receiptReactionId: string): void {
    const result = this.db.prepare('UPDATE thread_jobs SET receipt_reaction_id = ?, updated_at = ? WHERE id = ?').run(receiptReactionId, now(), id)
    if (!result.changes) throw new Error('Thread Job not found')
  }

  getThreadJob(id: string): ThreadJobRecord {
    const row = this.db.prepare('SELECT * FROM thread_jobs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Thread Job not found')
    return this.threadJob(row)
  }

  listThreadJobs(limit = 100): ThreadJobRecord[] {
    return (this.db.prepare('SELECT * FROM thread_jobs ORDER BY created_at DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as Row[]).map(this.threadJob)
  }

  private threadJob = (row: Row): ThreadJobRecord => ({
    id: String(row.id), botId: String(row.bot_id), threadChannelId: String(row.thread_channel_id), eventId: String(row.event_id), messageId: String(row.message_id),
    status: String(row.status) as ThreadJobRecord['status'], attempts: Number(row.attempts), logId: String(row.log_id), receiptReactionId: String(row.receipt_reaction_id), error: String(row.error),
    createdAt: String(row.created_at), startedAt: String(row.started_at), completedAt: String(row.completed_at), updatedAt: String(row.updated_at),
  })

  retryMessageLog(id: string, actor: Pick<AdminAccountRecord, 'id' | 'loginName' | 'displayName'>): { log: MessageLogRecord; job: ThreadJobRecord; attempts: MessageAttemptRecord[] } {
    const logRow = this.db.prepare('SELECT * FROM message_logs WHERE id = ?').get(id) as Row | undefined
    if (!logRow) throw new Error('Message log not found')
    if (String(logRow.status) !== 'failed') throw new Error('Only failed messages can be retried')
    const jobRow = this.db.prepare('SELECT * FROM thread_jobs WHERE log_id = ?').get(id) as Row | undefined
    if (!jobRow) throw new Error('Thread Job not found')
    if (String(jobRow.status) !== 'failed') throw new Error('Only failed Thread Jobs can be retried')
    let message: ChannelInboundMessage
    try { message = JSON.parse(String(jobRow.message_json)) as ChannelInboundMessage }
    catch { throw new Error('Queued message payload is unavailable') }
    const baseRoute = this.resolveRoute(String(jobRow.bot_id), message)
    const channel = this.db.prepare('SELECT core_thread_id FROM thread_channels WHERE id = ?').get(String(jobRow.thread_channel_id)) as Row | undefined
    if (!channel) throw new Error('Thread Channel not found')
    const previousAttempt = Math.max(1, Number(jobRow.attempts) || 0)
    const nextAttempt = previousAttempt + 1
    assertTransition('messageLog', 'failed', 'processing')
    assertTransition('threadJob', 'failed', 'queued')
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO message_attempts (
        id, log_id, attempt_number, status, response_content, error, model, reasoning_effort,
        started_at, completed_at, duration_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(log_id, attempt_number) DO UPDATE SET status = excluded.status, response_content = excluded.response_content,
        error = excluded.error, model = excluded.model, reasoning_effort = excluded.reasoning_effort,
        started_at = excluded.started_at, completed_at = excluded.completed_at, duration_ms = excluded.duration_ms, updated_at = excluded.updated_at`)
        .run(randomUUID(), id, previousAttempt, String(logRow.status), String(logRow.response_content), String(logRow.error), String(logRow.model), String(logRow.reasoning_effort), String(logRow.started_at), String(logRow.completed_at), logRow.duration_ms === null || logRow.duration_ms === undefined ? null : Number(logRow.duration_ms), timestamp, timestamp)
      this.db.prepare(`INSERT INTO message_attempts (
        id, log_id, attempt_number, status, requested_by_account_id, requested_by_login_name, requested_by_display_name,
        model, reasoning_effort, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), id, nextAttempt, actor.id, actor.loginName, actor.displayName, baseRoute.modelConfig.model, baseRoute.modelConfig.reasoningEffort, timestamp, timestamp)
      const restarted = this.db.prepare(`UPDATE message_logs SET bot_name = ?, workspace_id = ?, workspace_name = ?, scene_id = ?, scene_name = ?,
        skill_packages_json = ?, investigation_json = '{}', model = ?, reasoning_effort = ?, model_source = ?, reasoning_effort_source = ?,
        model_fallback = 0, core_thread_id = ?, thread_route_type = 'fixed', matched_thread_id = ?, thread_match_score = 1,
        thread_match_reason = '管理员手动重试，沿用原 Thread Channel', response_content = '', status = 'processing', error = '',
        started_at = ?, completed_at = '', duration_ms = NULL WHERE id = ? AND status = 'failed'`)
        .run(baseRoute.bot.name, baseRoute.workspace.id, baseRoute.workspace.name, baseRoute.scene?.id ?? '', baseRoute.scene?.name ?? '',
          JSON.stringify(baseRoute.skillPackages.map(item => ({ id: item.id, name: item.name }))), baseRoute.modelConfig.model,
          baseRoute.modelConfig.reasoningEffort, baseRoute.modelConfig.modelSource, baseRoute.modelConfig.reasoningEffortSource,
          String(channel.core_thread_id), String(channel.core_thread_id), timestamp, id).changes
      if (!restarted) throw new Error('Message log changed concurrently')
      const retried = this.db.prepare(`UPDATE thread_jobs SET status = 'queued', receipt_reaction_id = '', error = '', started_at = '', completed_at = '', updated_at = ? WHERE id = ? AND status = 'failed'`)
        .run(timestamp, String(jobRow.id)).changes
      if (!retried) throw new Error('Thread job changed concurrently')
      this.deps.hubTasks.createHubTask({
        kind: 'agent_turn', origin: 'feishu', principal: actor.id, idempotencyKey: `${String(jobRow.bot_id)}:${String(jobRow.message_id)}:attempt:${nextAttempt}`,
        taskInput: { text: message.text, messageId: message.messageId, conversationId: message.conversation.id, retryOf: id },
        botId: String(jobRow.bot_id), sceneId: baseRoute.scene?.id ?? '', threadChannelId: String(jobRow.thread_channel_id), sourceKind: 'thread_job', sourceId: String(jobRow.id),
      })
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { log: this.getMessageLog(id), job: this.getThreadJob(String(jobRow.id)), attempts: this.listMessageAttempts(id) }
  }

  listMessageAttempts(logId: string): MessageAttemptRecord[] {
    const log = this.getMessageLog(logId)
    const jobRow = this.db.prepare('SELECT * FROM thread_jobs WHERE log_id = ?').get(logId) as Row | undefined
    if (!jobRow) return []
    const rows = this.db.prepare('SELECT * FROM message_attempts WHERE log_id = ? ORDER BY attempt_number').all(logId) as Row[]
    const attempts = rows.map(this.messageAttempt)
    const currentNumber = String(jobRow.status) === 'queued' ? Number(jobRow.attempts) + 1 : Math.max(1, Number(jobRow.attempts))
    const currentStatus = String(jobRow.status) as MessageAttemptRecord['status']
    const current: MessageAttemptRecord = {
      id: attempts.find(item => item.attemptNumber === currentNumber)?.id ?? `current:${logId}:${currentNumber}`,
      logId, attemptNumber: currentNumber, status: currentStatus,
      requestedByAccountId: attempts.find(item => item.attemptNumber === currentNumber)?.requestedByAccountId ?? '',
      requestedByLoginName: attempts.find(item => item.attemptNumber === currentNumber)?.requestedByLoginName ?? '',
      requestedByDisplayName: attempts.find(item => item.attemptNumber === currentNumber)?.requestedByDisplayName ?? '',
      responseContent: log.responseContent, error: log.error, model: log.model, reasoningEffort: log.reasoningEffort,
      startedAt: currentStatus === 'queued' ? '' : log.startedAt, completedAt: ['completed', 'failed'].includes(currentStatus) ? log.completedAt : '',
      durationMs: ['completed', 'failed'].includes(currentStatus) ? log.durationMs : null,
      createdAt: attempts.find(item => item.attemptNumber === currentNumber)?.createdAt ?? log.receivedAt,
      updatedAt: attempts.find(item => item.attemptNumber === currentNumber)?.updatedAt ?? (log.completedAt || log.startedAt),
    }
    const index = attempts.findIndex(item => item.attemptNumber === currentNumber)
    if (index >= 0) attempts[index] = current
    else attempts.push(current)
    return attempts.sort((left, right) => left.attemptNumber - right.attemptNumber)
  }

  private messageAttempt = (row: Row): MessageAttemptRecord => ({
    id: String(row.id), logId: String(row.log_id), attemptNumber: Number(row.attempt_number), status: String(row.status) as MessageAttemptRecord['status'],
    requestedByAccountId: String(row.requested_by_account_id), requestedByLoginName: String(row.requested_by_login_name), requestedByDisplayName: String(row.requested_by_display_name),
    responseContent: String(row.response_content), error: String(row.error), model: String(row.model), reasoningEffort: String(row.reasoning_effort),
    startedAt: String(row.started_at), completedAt: String(row.completed_at), durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  listThreadChannels(limit = 200): ThreadChannelRecord[] {
    const rows = this.db.prepare(`SELECT tc.*, b.name AS bot_name,
      (SELECT COUNT(*) FROM conversation_bindings cb WHERE cb.thread_channel_id = tc.id) AS binding_count,
      (SELECT COUNT(*) FROM thread_jobs tj WHERE tj.thread_channel_id = tc.id AND tj.status = 'queued') AS queued_jobs,
      (SELECT COUNT(*) FROM thread_jobs tj WHERE tj.thread_channel_id = tc.id AND tj.status = 'processing') AS processing_jobs
      FROM thread_channels tc JOIN bots b ON b.id = tc.bot_id ORDER BY tc.updated_at DESC LIMIT ?`).all(Math.min(500, Math.max(1, limit))) as Row[]
    return rows.map(row => ({ id: String(row.id), botId: String(row.bot_id), botName: String(row.bot_name), runtimeKind: String(row.runtime_kind || 'codex') as AgentRuntimeKind, coreThreadId: String(row.core_thread_id), bindingCount: Number(row.binding_count), queuedJobs: Number(row.queued_jobs), processingJobs: Number(row.processing_jobs), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
  }

  listMessageLogs(input: { limit?: number; offset?: number; botId?: string; sceneId?: string; status?: string; query?: string } = {}): { items: MessageLogRecord[]; total: number } {
    const filters: string[] = []
    const params: Array<string | number> = []
    if (input.botId) { filters.push('bot_id = ?'); params.push(input.botId) }
    if (input.sceneId) { filters.push('scene_id = ?'); params.push(input.sceneId) }
    if (input.status && ['processing', 'completed', 'failed'].includes(input.status)) { filters.push('status = ?'); params.push(input.status) }
    if (input.query?.trim()) {
      filters.push('(inbound_content LIKE ? ESCAPE \'\\\' OR response_content LIKE ? ESCAPE \'\\\' OR message_id LIKE ? OR id LIKE ? OR core_thread_id LIKE ? OR thread_channel_id LIKE ?)')
      const escaped = input.query.trim().replace(/[\\%_]/gu, value => `\\${value}`)
      params.push(`%${escaped}%`, `%${escaped}%`, `%${input.query.trim()}%`, `%${input.query.trim()}%`, `%${input.query.trim()}%`, `%${input.query.trim()}%`)
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

  getMessageLogForToolInvocation(id: string, threadChannelId: string): MessageLogRecord {
    const log = this.getMessageLog(id)
    if (log.threadChannelId !== threadChannelId) throw new Error('Tool invocation message does not belong to the active Thread Channel')
    return log
  }

  getMessageLogByBotMessage(botId: string, messageId: string): MessageLogRecord {
    const row = this.db.prepare('SELECT * FROM message_logs WHERE bot_id = ? AND message_id = ? ORDER BY received_at DESC, id DESC LIMIT 1').get(botId, messageId) as Row | undefined
    if (!row) throw new Error('Tool invocation source message log not found')
    return this.messageLog(row)
  }

  latestMessageLogForThreadChannel(threadChannelId: string): MessageLogRecord {
    const row = this.db.prepare('SELECT * FROM message_logs WHERE thread_channel_id = ? ORDER BY received_at DESC, id DESC LIMIT 1').get(threadChannelId) as Row | undefined
    if (!row) throw new Error('Message log not found for Thread Channel')
    return this.messageLog(row)
  }

  private messageLog = (row: Row): MessageLogRecord => ({
    id: String(row.id), eventId: String(row.event_id), messageId: String(row.message_id),
    botId: String(row.bot_id), botName: String(row.bot_name), runtimeKind: String(row.runtime_kind || 'codex') as AgentRuntimeKind, chatId: String(row.chat_id), topicId: String(row.topic_id), senderId: String(row.sender_id),
    messageType: String(row.message_type), inboundContent: String(row.inbound_content),
    inboundRaw: (() => { try { return JSON.parse(String(row.inbound_raw_json)) as unknown } catch { return null } })(),
    responseContent: String(row.response_content),
    status: String(row.status) as MessageLogRecord['status'], error: String(row.error),
    workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), sceneId: String(row.scene_id), sceneName: String(row.scene_name),
    skillPackages: (() => { try { return JSON.parse(String(row.skill_packages_json)) as Array<{ id: string; name: string }> } catch { return [] } })(),
    investigation: (() => {
      try {
        const value = JSON.parse(String(row.investigation_json)) as Partial<InvestigationTraceRecord>
        return {
          mode: value.mode ?? 'workspace', primarySkills: value.primarySkills ?? [], candidateSkills: value.candidateSkills ?? [],
          knowledgeResources: value.knowledgeResources ?? [], knowledgeRoots: value.knowledgeRoots ?? [], codeRoot: value.codeRoot ?? '', tools: value.tools ?? [],
        }
      } catch { return { mode: 'workspace', primarySkills: [], candidateSkills: [], knowledgeResources: [], knowledgeRoots: [], codeRoot: '', tools: [] } }
    })(),
    model: String(row.model), reasoningEffort: String(row.reasoning_effort), modelSource: String(row.model_source) as ModelConfigSource,
    reasoningEffortSource: String(row.reasoning_effort_source) as ModelConfigSource, modelFallback: Boolean(row.model_fallback),
    coreThreadId: String(row.core_thread_id), threadChannelId: String(row.thread_channel_id || ''),
    threadRouting: { type: String(row.thread_route_type || 'fixed') as ThreadRoutingDecision['type'], matchedThreadId: String(row.matched_thread_id || ''), score: Number(row.thread_match_score || 0), reason: String(row.thread_match_reason || '') },
    receivedAt: String(row.received_at), startedAt: String(row.started_at), completedAt: String(row.completed_at),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    botReplyDepth: Number(row.bot_reply_depth || 0),
  })

  getBotSecret(botId: string): string {
    const row = this.db.prepare('SELECT app_secret_encrypted FROM bots WHERE id = ?').get(botId) as Row | undefined
    if (!row) throw new Error('Bot not found')
    return String(row.app_secret_encrypted)
  }

  bindGroupScene(botId: string, chatId: string, sceneId: string, actorId: string): void {
    const scene = this.deps.botScenes.getScene(sceneId)
    if (scene.botId !== botId) throw new Error('Scene does not belong to this Bot')
    const timestamp = now()
    this.db.prepare(`INSERT INTO group_scene_bindings (bot_id, chat_id, scene_id, bound_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id) DO UPDATE SET scene_id = excluded.scene_id, bound_by = excluded.bound_by, updated_at = excluded.updated_at`)
      .run(botId, chatId, sceneId, actorId, timestamp, timestamp)
    this.deps.audit.createAuditLog({ action: 'scene.bind_group', targetType: 'scene', targetId: sceneId, summary: `通过飞书将群 ${chatId} 绑定到场景 ${scene.name}`, details: { botId, chatId, feishuActorId: actorId } })
  }

  rememberTopicRoute(botId: string, chatId: string, topicId: string, sceneId: string): void {
    if (!topicId) throw new Error('Topic ID is required')
    const scene = this.deps.botScenes.getScene(sceneId)
    if (scene.botId !== botId) throw new Error('Scene does not belong to this Bot')
    const timestamp = now()
    this.db.prepare(`INSERT INTO topic_route_contexts (bot_id, chat_id, topic_id, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id, topic_id) DO UPDATE SET scene_id = excluded.scene_id, updated_at = excluded.updated_at`)
      .run(botId, chatId, topicId, sceneId, timestamp, timestamp)
  }

  resolveRoute(botId: string, message: ChannelInboundMessage, options: { sceneId?: string } = {}): ResolvedRoute {
    const bot = this.deps.botScenes.getBot(botId)
    const topicId = bot.conversationMode === 'topic' && message.conversation.scope !== 'private'
      ? (message.conversation.rootId || message.messageId)
      : ''
    const topicContext = topicId
      ? this.db.prepare('SELECT scene_id FROM topic_route_contexts WHERE bot_id = ? AND chat_id = ? AND topic_id = ?').get(botId, message.conversation.id, topicId) as Row | undefined
      : undefined
    const groupBinding = this.db.prepare('SELECT scene_id FROM group_scene_bindings WHERE bot_id = ? AND chat_id = ?').get(botId, message.conversation.id) as Row | undefined
    const candidates = this.deps.botScenes.listScenes().filter(scene => scene.botId === botId && scene.enabled)
    const explicit = options.sceneId ? candidates.find(scene => scene.id === options.sceneId) ?? null : null
    if (options.sceneId && !explicit) throw new Error('Scene not found, disabled, or does not belong to this Bot')
    const topicBound = topicContext ? candidates.find(scene => scene.id === String(topicContext.scene_id)) ?? null : null
    const groupBound = groupBinding ? candidates.find(scene => scene.id === String(groupBinding.scene_id)) ?? null : null
    const matched = candidates.find(candidate => hasSceneMatcher(candidate.matcher) && sceneMatches(candidate.matcher, message)) ?? null
    const fallback = candidates.find(candidate => !hasSceneMatcher(candidate.matcher)) ?? null
    const scene = explicit ?? matched ?? topicBound ?? groupBound ?? fallback
    const routeSource: ResolvedRoute['routeSource'] = explicit ? 'explicit' : matched ? 'matcher' : topicBound ? 'topic_context' : groupBound ? 'group_binding' : 'default'
    const workspace = this.deps.workspaces.getWorkspace(scene?.workspaceId ?? bot.defaultWorkspaceId)
    const packages = scene ? this.deps.toolCatalog.listSkillPackages().filter(item => scene.skillPackageIds.includes(item.id)) : []
    const conversationKey = topicId ? `bot:${bot.id}:chat:${message.conversation.id}:topic:${topicId}` : `bot:${bot.id}:chat:${message.conversation.id}`
    const skillNames = packages.flatMap(item => item.skills)
    const skillPolicy = packages.some(item => item.fallbackMode === 'package_only')
      ? '本轮只允许使用技能包中列出的 Skill。'
      : packages.some(item => item.fallbackMode === 'mixed')
        ? '本轮同时检索技能包和当前 Agent 运行环境中的其他 Skill。'
        : skillNames.length ? '本轮优先使用技能包中的 Skill；无法满足时再检索当前 Agent 运行环境中的其他 Skill。' : ''
    const settings = this.deps.settings.getPlatformSettings()
    const platformModel = bot.runtimeKind === 'codex' ? settings.defaultModel : ''
    const platformEffort = bot.runtimeKind === 'codex' ? settings.defaultReasoningEffort : ''
    const model = scene?.model || bot.model || platformModel
    const reasoningEffort = scene?.reasoningEffort || bot.reasoningEffort || platformEffort
    const modelSource: ModelConfigSource = scene?.model ? 'scene' : bot.model ? 'bot' : platformModel ? 'platform' : bot.runtimeKind === 'traex' ? 'runtime' : 'codex'
    const reasoningEffortSource: ModelConfigSource = scene?.reasoningEffort ? 'scene' : bot.reasoningEffort ? 'bot' : platformEffort ? 'platform' : bot.runtimeKind === 'traex' ? 'runtime' : 'codex'
    const layers = [settings.basePrompt, workspace.prompt, bot.prompt, scene?.prompt ?? '', ...packages.map(item => item.prompt)]
      .map(value => value.trim()).filter(Boolean)
    if (skillNames.length) layers.push(`当前场景技能包：${skillNames.join('、')}。${skillPolicy}`)
    return { bot, workspace, scene, skillPackages: packages, conversationMode: bot.conversationMode, replyInTopic: Boolean(topicId), routeSource, conversationKey, threadChannelId: '', topicId, turnInstructions: layers.join('\n\n'), modelConfig: { model, reasoningEffort, modelSource, reasoningEffortSource, fallbackEnabled: settings.modelFallbackEnabled }, threadRouting: { type: 'fixed', matchedThreadId: '', score: 0, reason: '当前会话固定映射' } }
  }

  resolveThreadRouting(route: ResolvedRoute, message: ChannelInboundMessage, options: { allowProfileReuse?: boolean } = {}): ResolvedRoute {
    const existing = this.db.prepare(`SELECT cb.thread_channel_id, tc.core_thread_id, tc.runtime_kind FROM conversation_bindings cb
      JOIN thread_channels tc ON tc.id = cb.thread_channel_id WHERE cb.conversation_key = ?`).get(route.conversationKey) as Row | undefined
    if (existing && String(existing.runtime_kind || 'codex') === route.bot.runtimeKind) {
      const timestamp = now()
      this.db.prepare('UPDATE conversation_bindings SET updated_at = ? WHERE conversation_key = ?').run(timestamp, route.conversationKey)
      this.db.prepare('UPDATE thread_channels SET updated_at = ? WHERE id = ?').run(timestamp, String(existing.thread_channel_id))
      return { ...route, threadChannelId: String(existing.thread_channel_id), threadRouting: { type: 'fixed', matchedThreadId: String(existing.core_thread_id), score: 1, reason: '当前群或话题已经绑定 Thread Channel' } }
    }
    if (!route.scene) {
      const channel = this.bindConversationToChannel(route, message)
      return { ...route, threadChannelId: channel.id, threadRouting: { type: 'new', matchedThreadId: channel.coreThreadId, score: 0, reason: '默认路由创建新的 Thread Channel' } }
    }
    if (options.allowProfileReuse === false) {
      const channel = this.bindConversationToChannel(route, message)
      return { ...route, threadChannelId: channel.id, threadRouting: { type: 'new', matchedThreadId: channel.coreThreadId, score: 0, reason: '当前入口要求会话隔离，不复用其他会话的 Thread Channel' } }
    }
    const rule = this.getThreadRoutingRule(route.scene.id)
    if (!rule.enabled) {
      const channel = this.bindConversationToChannel(route, message)
      return { ...route, threadChannelId: channel.id, threadRouting: { type: 'new', matchedThreadId: channel.coreThreadId, score: 0, reason: '当前场景未启用智能 Thread 路由' } }
    }
    const cutoff = new Date(Date.now() - rule.timeWindowHours * 60 * 60_000).toISOString()
    const rows = this.db.prepare(`SELECT * FROM thread_profiles WHERE bot_id = ? AND workspace_id = ? AND scene_id = ? AND runtime_kind = ? AND last_active_at >= ?
      ORDER BY last_active_at DESC LIMIT ?`).all(route.bot.id, route.workspace.id, route.scene.id, route.bot.runtimeKind, cutoff, rule.maxCandidates) as Row[]
    const current = extractThreadFeatures(message.text, message.content?.raw)
    let best: { row: Row; score: number; reason: string } | null = null
    for (const row of rows) {
      let fields: Record<string, string> = {}
      try { fields = JSON.parse(String(row.fields_json)) as Record<string, string> } catch { /* ignore invalid historical metadata */ }
      const previous = extractThreadFeatures(String(row.normalized_text))
      previous.fields = fields
      const similarity = scoreThreadSimilarity(current, previous, { structuredWeight: rule.structuredWeight, textWeight: rule.textWeight })
      const ageRatio = Math.min(1, Math.max(0, (Date.now() - Date.parse(String(row.last_active_at))) / (rule.timeWindowHours * 60 * 60_000)))
      const score = similarity.sameEvent ? similarity.score : similarity.score * (1 - ageRatio * 0.1)
      const labels: Record<string, string> = { service: '服务', event: 'Event', group: 'Group', partition: 'Partition', task_id: '任务 ID', check_index: 'checkIndex', warn_id: 'warn_id', alarm_rule: '告警规则', title: '标题' }
      const reason = `${similarity.sameEvent ? '稳定事件特征命中；' : ''}${similarity.matchedFields.map(name => labels[name] ?? name).join('、') || '文本特征'}；文本相似度 ${(similarity.textScore * 100).toFixed(0)}%`
      if (!best || score > best.score) best = { row, score, reason }
    }
    if (!best) {
      const channel = this.bindConversationToChannel(route, message)
      return { ...route, threadChannelId: channel.id, threadRouting: { type: 'new', matchedThreadId: '', score: 0, reason: '同场景时间窗口内没有历史 Thread 画像' } }
    }
    const matchedThreadId = String(best.row.core_thread_id)
    if (best.score >= rule.reuseThreshold) {
      const channel = this.bindConversationToChannel(route, message, String(best.row.thread_channel_id))
      return { ...route, threadChannelId: channel.id, threadRouting: { type: 'reused', matchedThreadId, score: best.score, reason: best.reason } }
    }
    if (best.score >= rule.experienceThreshold) {
      const channel = this.bindConversationToChannel(route, message)
      const experience = String(best.row.experience_summary).slice(0, 8_000)
      const context = `# 历史相似经验\n以下内容来自同一 Bot、工作区和场景下的历史 Thread，仅作调查线索，必须重新验证当前样本。\n历史 Thread：${matchedThreadId}\n匹配分数：${best.score.toFixed(3)}\n匹配依据：${best.reason}\n\n${experience || '历史 Thread 尚未生成可用结论摘要。'}`
      return { ...route, threadChannelId: channel.id, turnInstructions: [route.turnInstructions, context].filter(Boolean).join('\n\n'), threadRouting: { type: 'experience', matchedThreadId, score: best.score, reason: best.reason } }
    }
    const channel = this.bindConversationToChannel(route, message)
    return { ...route, threadChannelId: channel.id, threadRouting: { type: 'new', matchedThreadId, score: best.score, reason: `最高候选低于经验阈值；${best.reason}` } }
  }

  private bindConversationToChannel(route: ResolvedRoute, message: ChannelInboundMessage, preferredChannelId = ''): { id: string; coreThreadId: string } {
    const current = this.db.prepare(`SELECT tc.id, tc.core_thread_id, tc.runtime_kind FROM conversation_bindings cb JOIN thread_channels tc ON tc.id = cb.thread_channel_id
      WHERE cb.conversation_key = ?`).get(route.conversationKey) as Row | undefined
    if (current && String(current.runtime_kind || 'codex') === route.bot.runtimeKind) return { id: String(current.id), coreThreadId: String(current.core_thread_id) }
    const timestamp = now()
    const createdChannelId = preferredChannelId || randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (preferredChannelId) {
        const target = this.db.prepare('SELECT id FROM thread_channels WHERE id = ? AND bot_id = ? AND runtime_kind = ?').get(preferredChannelId, route.bot.id, route.bot.runtimeKind)
        if (!target) throw new Error('Thread Channel not found')
      } else {
        this.db.prepare(`INSERT INTO thread_channels (id, bot_id, runtime_kind, core_thread_id, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)`)
          .run(createdChannelId, route.bot.id, route.bot.runtimeKind, timestamp, timestamp)
      }
      this.db.prepare(`INSERT INTO conversation_bindings (conversation_key, thread_channel_id, bot_id, conversation_mode, chat_id, topic_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_key) DO UPDATE SET thread_channel_id = excluded.thread_channel_id, conversation_mode = excluded.conversation_mode, chat_id = excluded.chat_id, topic_id = excluded.topic_id, updated_at = excluded.updated_at`)
        .run(route.conversationKey, createdChannelId, route.bot.id, route.conversationMode, message.conversation.id, route.topicId, timestamp, timestamp)
      const bound = this.db.prepare(`SELECT tc.id, tc.core_thread_id FROM conversation_bindings cb JOIN thread_channels tc ON tc.id = cb.thread_channel_id
        WHERE cb.conversation_key = ?`).get(route.conversationKey) as Row
      if (!preferredChannelId && String(bound.id) !== createdChannelId) this.db.prepare("DELETE FROM thread_channels WHERE id = ? AND core_thread_id = ''").run(createdChannelId)
      this.db.prepare('UPDATE thread_channels SET updated_at = ? WHERE id = ?').run(timestamp, String(bound.id))
      this.db.exec('COMMIT')
      return { id: String(bound.id), coreThreadId: String(bound.core_thread_id) }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listThreadRoutingRules(): ThreadRoutingRuleRecord[] {
    const rows = this.db.prepare(`SELECT s.id AS scene_id, s.name AS scene_name, s.bot_id, b.name AS bot_name, s.workspace_id, w.name AS workspace_name,
      COALESCE(r.enabled, 0) AS enabled, COALESCE(r.reuse_threshold, 0.85) AS reuse_threshold,
      COALESCE(r.experience_threshold, 0.55) AS experience_threshold, COALESCE(r.time_window_hours, 72) AS time_window_hours,
      COALESCE(r.max_candidates, 100) AS max_candidates, COALESCE(r.structured_weight, 0.7) AS structured_weight,
      COALESCE(r.text_weight, 0.3) AS text_weight, COALESCE(r.updated_at, '') AS updated_at,
      (SELECT COUNT(*) FROM thread_profiles p WHERE p.bot_id = s.bot_id AND p.workspace_id = s.workspace_id AND p.scene_id = s.id) AS profile_count
      FROM scenes s JOIN bots b ON b.id = s.bot_id JOIN workspaces w ON w.id = s.workspace_id
      LEFT JOIN thread_routing_rules r ON r.scene_id = s.id ORDER BY s.priority, s.name COLLATE NOCASE`).all() as Row[]
    return rows.map(row => this.threadRoutingRule(row))
  }

  getThreadRoutingRule(sceneId: string): ThreadRoutingRuleRecord {
    const rule = this.listThreadRoutingRules().find(item => item.sceneId === sceneId)
    if (!rule) throw new Error('Scene not found')
    return rule
  }

  setThreadRoutingRule(sceneId: string, input: Pick<ThreadRoutingRuleRecord, 'enabled' | 'reuseThreshold' | 'experienceThreshold' | 'timeWindowHours' | 'maxCandidates' | 'structuredWeight' | 'textWeight'>): ThreadRoutingRuleRecord {
    this.deps.botScenes.getScene(sceneId)
    const reuseThreshold = Math.min(1, Math.max(0, Number(input.reuseThreshold)))
    const experienceThreshold = Math.min(reuseThreshold, Math.max(0, Number(input.experienceThreshold)))
    const timeWindowHours = Math.min(24 * 365, Math.max(1, Math.trunc(Number(input.timeWindowHours) || 72)))
    const maxCandidates = Math.min(1_000, Math.max(10, Math.trunc(Number(input.maxCandidates) || 100)))
    const structuredWeight = Math.min(1, Math.max(0, Number(input.structuredWeight)))
    const textWeight = Math.min(1, Math.max(0, Number(input.textWeight)))
    if (structuredWeight + textWeight <= 0) throw new Error('At least one Thread routing weight must be positive')
    const timestamp = now()
    this.db.prepare(`INSERT INTO thread_routing_rules (scene_id, enabled, reuse_threshold, experience_threshold, time_window_hours, max_candidates, structured_weight, text_weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scene_id) DO UPDATE SET enabled = excluded.enabled, reuse_threshold = excluded.reuse_threshold,
      experience_threshold = excluded.experience_threshold, time_window_hours = excluded.time_window_hours, max_candidates = excluded.max_candidates,
      structured_weight = excluded.structured_weight, text_weight = excluded.text_weight, updated_at = excluded.updated_at`)
      .run(sceneId, input.enabled ? 1 : 0, reuseThreshold, experienceThreshold, timeWindowHours, maxCandidates, structuredWeight, textWeight, timestamp)
    return this.getThreadRoutingRule(sceneId)
  }

  processThreadProfileJobs(limit = 20): { processed: number; failed: number } {
    const jobs = this.db.prepare('SELECT * FROM thread_profile_jobs ORDER BY created_at LIMIT ?').all(Math.min(100, Math.max(1, limit))) as Row[]
    let processed = 0, failed = 0
    for (const job of jobs) {
      const logId = String(job.log_id)
      try {
        this.refreshThreadProfile(logId)
        this.db.prepare('DELETE FROM thread_profile_jobs WHERE log_id = ?').run(logId)
        processed += 1
      } catch (error) {
        failed += 1
        const attempts = Number(job.attempts) + 1
        if (attempts >= 5) this.db.prepare('DELETE FROM thread_profile_jobs WHERE log_id = ?').run(logId)
        else this.db.prepare('UPDATE thread_profile_jobs SET attempts = ?, error = ?, updated_at = ? WHERE log_id = ?').run(attempts, String(error).slice(0, 2_000), now(), logId)
      }
    }
    return { processed, failed }
  }

  listThreadProfiles(limit = 100): ThreadProfileRecord[] {
    return (this.db.prepare('SELECT * FROM thread_profiles ORDER BY last_active_at DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as Row[]).map(this.threadProfile)
  }

  listThreadRoutingDecisions(limit = 50): Array<{ logId: string; messageId: string; inboundContent: string; sceneName: string; type: ThreadRoutingDecision['type']; threadChannelId: string; coreThreadId: string; matchedThreadId: string; score: number; reason: string; receivedAt: string }> {
    return (this.db.prepare(`SELECT id, message_id, inbound_content, scene_name, thread_route_type, thread_channel_id, core_thread_id, matched_thread_id, thread_match_score, thread_match_reason, received_at
      FROM message_logs WHERE scene_id <> '' ORDER BY received_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as Row[]).map(row => ({
      logId: String(row.id), messageId: String(row.message_id), inboundContent: String(row.inbound_content), sceneName: String(row.scene_name), type: String(row.thread_route_type) as ThreadRoutingDecision['type'], threadChannelId: String(row.thread_channel_id), coreThreadId: String(row.core_thread_id), matchedThreadId: String(row.matched_thread_id), score: Number(row.thread_match_score), reason: String(row.thread_match_reason), receivedAt: String(row.received_at),
    }))
  }

  private refreshThreadProfile(logId: string): void {
    const log = this.db.prepare("SELECT * FROM message_logs WHERE id = ? AND status = 'completed' AND core_thread_id <> ''").get(logId) as Row | undefined
    if (!log) return
    const coreThreadId = String(log.core_thread_id)
    const sceneId = String(log.scene_id)
    if (!sceneId) return
    const runtimeKind = String(log.runtime_kind || 'codex') as AgentRuntimeKind
    const logs = this.db.prepare(`SELECT * FROM message_logs WHERE core_thread_id = ? AND scene_id = ? AND runtime_kind = ? AND status = 'completed' ORDER BY received_at DESC LIMIT 50`).all(coreThreadId, sceneId, runtimeKind) as Row[]
    if (!logs.length) return
    const total = Number((this.db.prepare("SELECT COUNT(*) AS count FROM message_logs WHERE core_thread_id = ? AND scene_id = ? AND runtime_kind = ? AND status = 'completed'").get(coreThreadId, sceneId, runtimeKind) as Row).count)
    const fieldMap: Record<string, string> = {}
    const normalized: string[] = []
    for (const item of [...logs].reverse()) {
      let raw: unknown = null
      try { raw = JSON.parse(String(item.inbound_raw_json)) } catch { /* ignore */ }
      const features = extractThreadFeatures(String(item.inbound_content), raw)
      Object.assign(fieldMap, features.fields)
      if (features.normalizedText) normalized.push(features.normalizedText)
    }
    const latest = logs[0]!
    const threadChannelId = String(latest.thread_channel_id || '')
    if (!threadChannelId) return
    const title = String(latest.inbound_content).split('\n').map(value => value.trim()).find(Boolean)?.slice(0, 300) ?? ''
    const summary = String(latest.response_content).trim().slice(0, 8_000)
    const timestamp = now()
    this.db.prepare(`INSERT INTO thread_profiles (core_thread_id, conversation_key, thread_channel_id, bot_id, workspace_id, scene_id, runtime_kind, title, fields_json, normalized_text,
      experience_summary, message_count, last_message_log_id, last_active_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(core_thread_id, scene_id) DO UPDATE SET conversation_key = excluded.conversation_key, thread_channel_id = excluded.thread_channel_id, bot_id = excluded.bot_id, workspace_id = excluded.workspace_id,
      scene_id = excluded.scene_id, runtime_kind = excluded.runtime_kind, title = excluded.title, fields_json = excluded.fields_json, normalized_text = excluded.normalized_text,
      experience_summary = excluded.experience_summary, message_count = excluded.message_count, last_message_log_id = excluded.last_message_log_id,
      last_active_at = excluded.last_active_at, updated_at = excluded.updated_at`)
      .run(coreThreadId, threadChannelId, threadChannelId, String(latest.bot_id), String(latest.workspace_id), String(latest.scene_id), runtimeKind, title, JSON.stringify(fieldMap), normalized.join('\n').slice(-50_000), summary, total, String(latest.id), String(latest.received_at), timestamp)
  }

  private threadRoutingRule = (row: Row): ThreadRoutingRuleRecord => ({
    sceneId: String(row.scene_id), sceneName: String(row.scene_name), botId: String(row.bot_id), botName: String(row.bot_name), workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), enabled: Boolean(row.enabled), reuseThreshold: Number(row.reuse_threshold), experienceThreshold: Number(row.experience_threshold), timeWindowHours: Number(row.time_window_hours), maxCandidates: Number(row.max_candidates), structuredWeight: Number(row.structured_weight), textWeight: Number(row.text_weight), profileCount: Number(row.profile_count), updatedAt: String(row.updated_at),
  })

  private threadProfile = (row: Row): ThreadProfileRecord => ({
    coreThreadId: String(row.core_thread_id), threadChannelId: String(row.thread_channel_id || row.conversation_key), botId: String(row.bot_id), workspaceId: String(row.workspace_id), sceneId: String(row.scene_id), runtimeKind: String(row.runtime_kind || 'codex') as AgentRuntimeKind, title: String(row.title), fields: (() => { try { return JSON.parse(String(row.fields_json)) as Record<string, string> } catch { return {} } })(), normalizedText: String(row.normalized_text), experienceSummary: String(row.experience_summary), messageCount: Number(row.message_count), lastMessageLogId: String(row.last_message_log_id), lastActiveAt: String(row.last_active_at), updatedAt: String(row.updated_at),
  })

  messageMatchesScene(sceneId: string, message: ChannelInboundMessage): boolean {
    return sceneMatches(this.deps.botScenes.getScene(sceneId).matcher, message)
  }

  claimScenePicker(botId: string, chatId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO scene_picker_prompts (bot_id, chat_id, prompted_at) VALUES (?, ?, ?)').run(botId, chatId, now()).changes > 0
  }

  upsertChatMetadata(botId: string, input: { chatId: string; name: string; mode: 'group' | 'topic' | 'p2p' }): ChatMetadataRecord {
    const timestamp = now()
    this.db.prepare(`INSERT INTO chat_metadata (bot_id, chat_id, name, mode, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chat_metadata.name END, mode = excluded.mode, updated_at = excluded.updated_at`)
      .run(botId, input.chatId, input.name.trim(), input.mode, timestamp)
    return { botId, chatId: input.chatId, name: input.name.trim(), mode: input.mode, updatedAt: timestamp }
  }

  listChatMetadata(input: { botId?: string; query?: string; limit?: number } = {}): ChatMetadataRecord[] {
    const filters: string[] = [], params: Array<string | number> = []
    if (input.botId) { filters.push('bot_id = ?'); params.push(input.botId) }
    if (input.query?.trim()) { filters.push('(name LIKE ? OR chat_id LIKE ?)'); const value = `%${input.query.trim()}%`; params.push(value, value) }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 200)))
    const rows = this.db.prepare(`SELECT * FROM chat_metadata ${where} ORDER BY name COLLATE NOCASE, chat_id LIMIT ?`).all(...params, limit) as Row[]
    return rows.map(row => ({ botId: String(row.bot_id), chatId: String(row.chat_id), name: String(row.name), mode: String(row.mode) as ChatMetadataRecord['mode'], updatedAt: String(row.updated_at) }))
  }

  listChatIdsForMetadataSync(botId: string): string[] {
    const rows = this.db.prepare(`SELECT chat_id FROM conversation_bindings WHERE bot_id = ? UNION SELECT chat_id FROM group_scene_bindings WHERE bot_id = ?`).all(botId, botId) as Row[]
    const ids = new Set(rows.map(row => String(row.chat_id)).filter(Boolean))
    for (const scene of this.deps.botScenes.listScenes().filter(item => item.botId === botId)) for (const chatId of scene.matcher.chatIds) ids.add(chatId)
    return [...ids]
  }

  latestSenderIdForChat(botId: string, chatId: string): string {
    const row = this.db.prepare(`SELECT sender_id FROM message_logs
      WHERE bot_id = ? AND chat_id = ? AND sender_id <> ''
      ORDER BY received_at DESC LIMIT 1`).get(botId, chatId) as Row | undefined
    return String(row?.sender_id ?? '')
  }

  listObservedSenderIds(botId: string, limit = 200): Array<{ openId: string; messageCount: number; lastSeenAt: string }> {
    const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)))
    return (this.db.prepare(`SELECT sender_id, COUNT(*) AS message_count, MAX(received_at) AS last_seen_at
      FROM message_logs
      WHERE bot_id = ? AND sender_id LIKE 'ou\\_%' ESCAPE '\\'
      GROUP BY sender_id
      ORDER BY last_seen_at DESC
      LIMIT ?`).all(botId, boundedLimit) as Row[]).map(row => ({
      openId: String(row.sender_id), messageCount: Number(row.message_count), lastSeenAt: String(row.last_seen_at),
    }))
  }

  listConversationThreads(input: { limit?: number; offset?: number; botId?: string; query?: string } = {}): { items: ConversationThreadRecord[]; total: number } {
    const filters: string[] = [], params: Array<string | number> = []
    if (input.botId) { filters.push('cb.bot_id = ?'); params.push(input.botId) }
    if (input.query?.trim()) {
      const value = `%${input.query.trim()}%`
      filters.push('(cb.conversation_key LIKE ? OR cb.chat_id LIKE ? OR COALESCE(cm.name, \'\') LIKE ? OR cb.topic_id LIKE ? OR tc.core_thread_id LIKE ? OR tc.id LIKE ? OR b.name LIKE ?)')
      params.push(value, value, value, value, value, value, value)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const from = `FROM conversation_bindings cb JOIN thread_channels tc ON tc.id = cb.thread_channel_id JOIN bots b ON b.id = cb.bot_id LEFT JOIN chat_metadata cm ON cm.bot_id = cb.bot_id AND cm.chat_id = cb.chat_id`
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count ${from} ${where}`).get(...params) as Row).count)
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50))), offset = Math.max(0, Math.trunc(input.offset ?? 0))
    const rows = this.db.prepare(`SELECT cb.conversation_key AS id, cb.thread_channel_id, cb.bot_id, cb.conversation_mode, cb.chat_id, cb.topic_id,
      cb.created_at, MAX(cb.updated_at, tc.updated_at) AS updated_at, tc.core_thread_id, tc.runtime_kind, b.name AS bot_name,
      COALESCE(cm.name, '') AS chat_name, COALESCE(cm.mode, '') AS chat_mode ${from} ${where}
      ORDER BY updated_at DESC, cb.conversation_key DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[]
    return { items: rows.map(this.conversationThread), total }
  }

  getConversationThread(id: string): ConversationThreadRecord {
    const row = this.db.prepare(`SELECT cb.conversation_key AS id, cb.thread_channel_id, cb.bot_id, cb.conversation_mode, cb.chat_id, cb.topic_id,
      cb.created_at, MAX(cb.updated_at, tc.updated_at) AS updated_at, tc.core_thread_id, tc.runtime_kind, b.name AS bot_name,
      COALESCE(cm.name, '') AS chat_name, COALESCE(cm.mode, '') AS chat_mode
      FROM conversation_bindings cb JOIN thread_channels tc ON tc.id = cb.thread_channel_id JOIN bots b ON b.id = cb.bot_id
      LEFT JOIN chat_metadata cm ON cm.bot_id = cb.bot_id AND cm.chat_id = cb.chat_id WHERE cb.conversation_key = ?`).get(id) as Row | undefined
    if (!row) throw new Error('Conversation thread not found')
    return this.conversationThread(row)
  }

  private conversationThread = (row: Row): ConversationThreadRecord => ({
    id: String(row.id), threadChannelId: String(row.thread_channel_id), botId: String(row.bot_id), botName: String(row.bot_name), runtimeKind: String(row.runtime_kind || 'codex') as AgentRuntimeKind, conversationMode: String(row.conversation_mode) as ConversationThreadRecord['conversationMode'],
    chatId: String(row.chat_id), chatName: String(row.chat_name), chatMode: String(row.chat_mode) as ConversationThreadRecord['chatMode'], topicId: String(row.topic_id),
    coreThreadId: String(row.core_thread_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })
}
