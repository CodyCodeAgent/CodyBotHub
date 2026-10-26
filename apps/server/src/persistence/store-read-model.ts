import { DatabaseSync } from 'node:sqlite'
import { type DatabaseRow as Row } from '../db-values.js'
import type { StoreHealthRecord } from '../types.js'

export class StoreReadModel {
  constructor(readonly db: DatabaseSync) {}

  dashboardDimensions(): {
    groups: Array<{ botId: string; botName: string; chatId: string; chatName: string; chatMode: string; lastActiveAt: string }>
    conversations: Array<{ botId: string; botName: string; chatId: string; chatName: string; topicId: string; threadChannelId: string; coreThreadId: string; lastActiveAt: string }>
  } {
    const groups = (this.db.prepare(`SELECT m.bot_id, MAX(m.bot_name) AS bot_name, m.chat_id,
      COALESCE(NULLIF(MAX(cm.name), ''), m.chat_id) AS chat_name, COALESCE(MAX(cm.mode), '') AS chat_mode,
      MAX(m.received_at) AS last_active_at
      FROM message_logs m LEFT JOIN chat_metadata cm ON cm.bot_id = m.bot_id AND cm.chat_id = m.chat_id
      GROUP BY m.bot_id, m.chat_id ORDER BY last_active_at DESC LIMIT 1000`).all() as Row[]).map(row => ({
        botId: String(row.bot_id), botName: String(row.bot_name), chatId: String(row.chat_id), chatName: String(row.chat_name), chatMode: String(row.chat_mode), lastActiveAt: String(row.last_active_at),
      }))
    const conversations = (this.db.prepare(`SELECT m.bot_id, MAX(m.bot_name) AS bot_name, m.chat_id,
      COALESCE(NULLIF(MAX(cm.name), ''), m.chat_id) AS chat_name, MAX(m.topic_id) AS topic_id,
      m.thread_channel_id, COALESCE(MAX(tc.core_thread_id), '') AS core_thread_id, MAX(m.received_at) AS last_active_at
      FROM message_logs m
      LEFT JOIN chat_metadata cm ON cm.bot_id = m.bot_id AND cm.chat_id = m.chat_id
      LEFT JOIN thread_channels tc ON tc.id = m.thread_channel_id
      WHERE m.thread_channel_id <> ''
      GROUP BY m.bot_id, m.chat_id, m.thread_channel_id ORDER BY last_active_at DESC LIMIT 1000`).all() as Row[]).map(row => ({
        botId: String(row.bot_id), botName: String(row.bot_name), chatId: String(row.chat_id), chatName: String(row.chat_name), topicId: String(row.topic_id), threadChannelId: String(row.thread_channel_id), coreThreadId: String(row.core_thread_id), lastActiveAt: String(row.last_active_at),
      }))
    return { groups, conversations }
  }

  stats(input: { fromDate?: string; toDate?: string; botId?: string; chatId?: string; threadChannelId?: string } = {}): {
    workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number
    today: { received: number; completed: number; failed: number; processing: number; reused: number; experience: number; created: number; averageDurationMs: number }
    threads: { channels: number; bindings: number; profiles: number; queuedJobs: number; processingJobs: number }
    analytics: {
      range: { fromDate: string; toDate: string; days: number; botId: string; chatId: string; threadChannelId: string }
      total: { received: number; completed: number; failed: number; processing: number; uniqueChats: number; averageDurationMs: number }
      daily: Array<{ date: string; received: number; completed: number; failed: number; reused: number; experience: number }>
      chats: Array<{ botId: string; botName: string; chatId: string; chatName: string; chatMode: string; received: number; completed: number; failed: number; averageDurationMs: number; lastActiveAt: string }>
      scenes: Array<{ sceneId: string; sceneName: string; received: number; completed: number; failed: number }>
      routes: Array<{ type: string; count: number }>
      capabilities: {
        configuredTools: number; configuredToolPackages: number; skillPackageUses: number; toolPackageRequests: number; successfulToolCalls: number
        status: { awaitingApproval: number; queued: number; running: number; completed: number; failed: number; rejected: number }
        skillPackages: Array<{ id: string; name: string; uses: number }>
        toolPackages: Array<{ id: string; name: string; requests: number; awaitingApproval: number; queued: number; running: number; completed: number; failed: number; rejected: number; successfulToolCalls: number }>
      }
    }
  } {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count)
    const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const parseDate = (value: string | undefined, fallback: Date) => {
      if (!value) return new Date(fallback)
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      if (!match) throw new Error('统计日期格式必须为 YYYY-MM-DD')
      const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      if (dateKey(parsed) !== value) throw new Error('统计日期无效')
      return parsed
    }
    const defaultEnd = new Date(); defaultEnd.setHours(0, 0, 0, 0)
    const defaultStart = new Date(defaultEnd); defaultStart.setDate(defaultStart.getDate() - 13)
    const rangeStart = parseDate(input.fromDate, defaultStart); rangeStart.setHours(0, 0, 0, 0)
    const rangeEnd = parseDate(input.toDate, defaultEnd); rangeEnd.setHours(0, 0, 0, 0)
    if (rangeStart > rangeEnd) throw new Error('统计开始日期不能晚于结束日期')
    const rangeDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000) + 1
    if (rangeDays > 366) throw new Error('单次统计范围不能超过 366 天')
    const rangeEndExclusive = new Date(rangeEnd); rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1)
    const messageConditions = ['m.received_at >= ?', 'm.received_at < ?']
    const messageParams: Array<string | number> = [rangeStart.toISOString(), rangeEndExclusive.toISOString()]
    const toolConditions = ['e.created_at >= ?', 'e.created_at < ?']
    const toolParams: Array<string | number> = [rangeStart.toISOString(), rangeEndExclusive.toISOString()]
    if (input.botId) { messageConditions.push('m.bot_id = ?'); messageParams.push(input.botId); toolConditions.push('e.bot_id = ?'); toolParams.push(input.botId) }
    if (input.chatId) { messageConditions.push('m.chat_id = ?'); messageParams.push(input.chatId); toolConditions.push('e.chat_id = ?'); toolParams.push(input.chatId) }
    if (input.threadChannelId) { messageConditions.push('m.thread_channel_id = ?'); messageParams.push(input.threadChannelId); toolConditions.push('e.thread_channel_id = ?'); toolParams.push(input.threadChannelId) }
    const messageWhere = `WHERE ${messageConditions.join(' AND ')}`
    const toolWhere = `WHERE ${toolConditions.join(' AND ')}`
    const enabledScenes = Number((this.db.prepare('SELECT COUNT(*) AS count FROM scenes WHERE enabled = 1').get() as Row).count)
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const activity = this.db.prepare(`SELECT COUNT(*) AS received,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN thread_route_type = 'reused' THEN 1 ELSE 0 END) AS reused,
      SUM(CASE WHEN thread_route_type = 'experience' THEN 1 ELSE 0 END) AS experience,
      SUM(CASE WHEN thread_route_type = 'new' THEN 1 ELSE 0 END) AS created,
      AVG(CASE WHEN status = 'completed' AND duration_ms IS NOT NULL THEN duration_ms END) AS average_duration_ms
      FROM message_logs WHERE received_at >= ?`).get(start.toISOString()) as Row
    const queue = this.db.prepare(`SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_jobs FROM thread_jobs`).get() as Row
    const total = this.db.prepare(`SELECT COUNT(*) AS received,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      COUNT(DISTINCT bot_id || char(31) || chat_id) AS unique_chats,
      AVG(CASE WHEN status = 'completed' AND duration_ms IS NOT NULL THEN duration_ms END) AS average_duration_ms
      FROM message_logs m ${messageWhere}`).get(...messageParams) as Row
    const dailyRows = this.db.prepare(`SELECT date(m.received_at, 'localtime') AS date, COUNT(*) AS received,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN thread_route_type = 'reused' THEN 1 ELSE 0 END) AS reused,
      SUM(CASE WHEN thread_route_type = 'experience' THEN 1 ELSE 0 END) AS experience
      FROM message_logs m ${messageWhere} GROUP BY date(m.received_at, 'localtime') ORDER BY date`).all(...messageParams) as Row[]
    const dailyByDate = new Map(dailyRows.map(row => [String(row.date), row]))
    const daily = Array.from({ length: rangeDays }, (_, index) => {
      const date = new Date(rangeStart); date.setDate(date.getDate() + index)
      const key = dateKey(date)
      const row = dailyByDate.get(key)
      return { date: key, received: Number(row?.received ?? 0), completed: Number(row?.completed ?? 0), failed: Number(row?.failed ?? 0), reused: Number(row?.reused ?? 0), experience: Number(row?.experience ?? 0) }
    })
    const chats = (this.db.prepare(`SELECT m.bot_id, MAX(m.bot_name) AS bot_name, m.chat_id,
      COALESCE(NULLIF(MAX(cm.name), ''), m.chat_id) AS chat_name, COALESCE(MAX(cm.mode), '') AS chat_mode,
      COUNT(*) AS received, SUM(CASE WHEN m.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      AVG(CASE WHEN m.status = 'completed' AND m.duration_ms IS NOT NULL THEN m.duration_ms END) AS average_duration_ms,
      MAX(m.received_at) AS last_active_at FROM message_logs m
      LEFT JOIN chat_metadata cm ON cm.bot_id = m.bot_id AND cm.chat_id = m.chat_id
      ${messageWhere} GROUP BY m.bot_id, m.chat_id ORDER BY received DESC, last_active_at DESC LIMIT 10`).all(...messageParams) as Row[]).map(row => ({
        botId: String(row.bot_id), botName: String(row.bot_name), chatId: String(row.chat_id), chatName: String(row.chat_name), chatMode: String(row.chat_mode), received: Number(row.received), completed: Number(row.completed), failed: Number(row.failed), averageDurationMs: Number(row.average_duration_ms || 0), lastActiveAt: String(row.last_active_at),
      }))
    const sceneStats = (this.db.prepare(`SELECT scene_id, CASE WHEN scene_id = '' THEN '默认路由' ELSE MAX(scene_name) END AS scene_name,
      COUNT(*) AS received, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM message_logs m ${messageWhere} GROUP BY scene_id ORDER BY received DESC LIMIT 8`).all(...messageParams) as Row[]).map(row => ({
        sceneId: String(row.scene_id), sceneName: String(row.scene_name), received: Number(row.received), completed: Number(row.completed), failed: Number(row.failed),
      }))
    const routes = (this.db.prepare(`SELECT thread_route_type AS type, COUNT(*) AS count FROM message_logs m ${messageWhere} GROUP BY thread_route_type ORDER BY count DESC`).all(...messageParams) as Row[]).map(row => ({ type: String(row.type), count: Number(row.count) }))
    const skillUsageRows = this.db.prepare(`WITH refs AS (
      SELECT DISTINCT m.id AS log_id, json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.id') AS package_id,
        json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name') AS snapshot_name
      FROM message_logs m JOIN json_each(CASE WHEN json_valid(m.skill_packages_json) THEN m.skill_packages_json ELSE '[]' END) j
      ${messageWhere} AND j.type = 'object' AND json_extract(j.value, '$.id') IS NOT NULL AND json_extract(j.value, '$.id') <> ''
    )
    SELECT refs.package_id AS id, COALESCE(sp.name, MAX(refs.snapshot_name), '已删除技能包') AS name, COUNT(*) AS uses
    FROM refs LEFT JOIN skill_packages sp ON sp.id = refs.package_id
    GROUP BY refs.package_id, sp.name ORDER BY uses DESC, name COLLATE NOCASE LIMIT 10`).all(...messageParams) as Row[]
    const skillPackages = skillUsageRows.map(row => ({ id: String(row.id), name: String(row.name), uses: Number(row.uses) }))
    const skillPackageUses = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT m.id AS log_id, json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.id') AS package_id
      FROM message_logs m JOIN json_each(CASE WHEN json_valid(m.skill_packages_json) THEN m.skill_packages_json ELSE '[]' END) j
      ${messageWhere} AND j.type = 'object' AND json_extract(j.value, '$.id') IS NOT NULL AND json_extract(j.value, '$.id') <> ''
    )`).get(...messageParams) as Row).count)
    const toolUsageRows = this.db.prepare(`SELECT e.tool_package_id AS id,
      COALESCE(tp.name, MAX(e.tool_package_name), '已删除工具包') AS name,
      COUNT(*) AS requests,
      SUM(CASE WHEN e.status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting_approval,
      SUM(CASE WHEN e.status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN e.status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN e.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN json_type(CASE WHEN json_valid(e.result_json) THEN e.result_json ELSE 'null' END) = 'array' THEN json_array_length(e.result_json) ELSE 0 END) AS successful_tool_calls
      FROM tool_package_executions e LEFT JOIN tool_packages tp ON tp.id = e.tool_package_id
      ${toolWhere} GROUP BY e.tool_package_id, tp.name ORDER BY requests DESC, name COLLATE NOCASE LIMIT 10`).all(...toolParams) as Row[]
    const toolPackages = toolUsageRows.map(row => ({
      id: String(row.id), name: String(row.name), requests: Number(row.requests), awaitingApproval: Number(row.awaiting_approval), queued: Number(row.queued), running: Number(row.running), completed: Number(row.completed), failed: Number(row.failed), rejected: Number(row.rejected), successfulToolCalls: Number(row.successful_tool_calls),
    }))
    const toolTotals = this.db.prepare(`SELECT COUNT(*) AS requests,
      SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting_approval,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN json_type(CASE WHEN json_valid(result_json) THEN result_json ELSE 'null' END) = 'array' THEN json_array_length(result_json) ELSE 0 END) AS successful_tool_calls
      FROM tool_package_executions e ${toolWhere}`).get(...toolParams) as Row
    const toolPackageRequests = Number(toolTotals.requests)
    const successfulToolCalls = Number(toolTotals.successful_tool_calls || 0)
    const toolStatus = { awaitingApproval: Number(toolTotals.awaiting_approval || 0), queued: Number(toolTotals.queued || 0), running: Number(toolTotals.running || 0), completed: Number(toolTotals.completed || 0), failed: Number(toolTotals.failed || 0), rejected: Number(toolTotals.rejected || 0) }
    return {
      workspaces: count('workspaces'), bots: count('bots'), scenes: enabledScenes, skillPackages: count('skill_packages'), messageLogs: count('message_logs'),
      today: { received: Number(activity.received), completed: Number(activity.completed), failed: Number(activity.failed), processing: Number(activity.processing), reused: Number(activity.reused), experience: Number(activity.experience), created: Number(activity.created), averageDurationMs: Number(activity.average_duration_ms || 0) },
      threads: { channels: count('thread_channels'), bindings: count('conversation_bindings'), profiles: count('thread_profiles'), queuedJobs: Number(queue.queued_jobs), processingJobs: Number(queue.processing_jobs) },
      analytics: {
        range: { fromDate: dateKey(rangeStart), toDate: dateKey(rangeEnd), days: rangeDays, botId: input.botId ?? '', chatId: input.chatId ?? '', threadChannelId: input.threadChannelId ?? '' },
        total: { received: Number(total.received), completed: Number(total.completed), failed: Number(total.failed), processing: Number(total.processing), uniqueChats: Number(total.unique_chats), averageDurationMs: Number(total.average_duration_ms || 0) },
        daily, chats, scenes: sceneStats, routes,
        capabilities: {
          configuredTools: count('tools'), configuredToolPackages: count('tool_packages'), skillPackageUses, toolPackageRequests, successfulToolCalls,
          status: toolStatus, skillPackages, toolPackages,
        },
      },
    }
  }

  systemHealth(staleAfterMs = 20 * 60_000): StoreHealthRecord {
    let database = { ok: false, result: 'unknown' }
    try {
      const row = this.db.prepare('PRAGMA quick_check(1)').get() as Row | undefined
      const result = String(row ? Object.values(row)[0] : 'no result')
      database = { ok: result === 'ok', result }
    } catch (error) {
      database = { ok: false, result: error instanceof Error ? error.message : String(error) }
    }
    const staleBefore = new Date(Date.now() - Math.max(60_000, staleAfterMs)).toISOString()
    const queue = this.db.prepare(`SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'processing' AND started_at <> '' AND started_at < ? THEN 1 ELSE 0 END) AS stale_processing,
      MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest_queued_at
      FROM thread_jobs`).get(staleBefore) as Row
    const profiles = this.db.prepare(`SELECT COUNT(*) AS queued, SUM(CASE WHEN error <> '' THEN 1 ELSE 0 END) AS failed FROM thread_profile_jobs`).get() as Row
    return {
      database,
      queue: {
        queued: Number(queue.queued || 0), processing: Number(queue.processing || 0), staleProcessing: Number(queue.stale_processing || 0), oldestQueuedAt: String(queue.oldest_queued_at || ''),
      },
      profiles: { queued: Number(profiles.queued || 0), failed: Number(profiles.failed || 0) },
    }
  }
}
