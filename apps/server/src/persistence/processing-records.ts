import type { DatabaseSync } from 'node:sqlite'

// A read projection, not a second message store. Feishu already has an audit log;
// CLI/MCP use their durable Task input/result and an execution metadata snapshot.
export function installProcessingRecords(db: DatabaseSync): void {
  const audit = (key: string, fallback = "''") => `COALESCE(json_extract(t.payload, '$.executionAudit.${key}'), ${fallback})`
  const input = (key: string, fallback = "''") => `COALESCE(json_extract(t.payload, '$.${key}'), ${fallback})`
  const columns: Record<string, string> = {
    id: 't.id', event_id: input('message.eventId', 't.source_id'), message_id: input('message.messageId', 't.source_id'),
    bot_id: 't.bot_id', bot_name: audit('botName', "COALESCE(b.name, '已删除 Bot')"),
    runtime_kind: audit('runtimeKind', "COALESCE(tc.runtime_kind, b.runtime_kind, 'codex')"),
    chat_id: `CASE WHEN t.origin = 'cli' THEN ${input('message.chatId')} ELSE 'mcp:' || json_array(t.principal, ${input('sessionId', "'default'")}) END`,
    topic_id: input('message.topicId'), sender_id: input('message.sender.id', 't.principal'),
    message_type: input('message.message.type', "'text'"), inbound_content: input('message.message.text', input('prompt')),
    inbound_raw_json: input('message.message.raw', "'null'"),
    response_content: "COALESCE(json_extract(t.result_payload, '$.text'), json_extract(t.progress_payload, '$.answer'), '')",
    status: "CASE WHEN t.status = 'completed' THEN 'completed' WHEN t.status IN ('failed', 'cancelled') THEN 'failed' ELSE 'processing' END",
    error: "COALESCE(t.error, '')", workspace_id: audit('workspaceId', input('route.workspaceId', "COALESCE(s.workspace_id, b.default_workspace_id, '')")),
    workspace_name: audit('workspaceName', "COALESCE(w.name, '')"), scene_id: 't.scene_id', scene_name: audit('sceneName', "COALESCE(s.name, '')"),
    // Never infer historical usage from today's scene configuration.
    skill_packages_json: audit('skillPackages', "'[]'"), investigation_json: audit('investigation', "'{}'"),
    model: audit('model.model'), reasoning_effort: audit('model.reasoningEffort'), model_source: audit('model.modelSource', "'runtime'"),
    reasoning_effort_source: audit('model.reasoningEffortSource', "'runtime'"), model_fallback: audit('model.fallback', '0'),
    core_thread_id: audit('coreThreadId', "COALESCE(tc.core_thread_id, '')"), thread_channel_id: 't.thread_channel_id',
    thread_route_type: audit('threadRouting.type', "'unknown'"), matched_thread_id: audit('threadRouting.matchedThreadId'),
    thread_match_score: audit('threadRouting.score', '0'), thread_match_reason: audit('threadRouting.reason'),
    received_at: 't.created_at', started_at: "COALESCE(t.started_at, '')", completed_at: "COALESCE(t.completed_at, '')",
    duration_ms: "CASE WHEN t.completed_at IS NOT NULL AND t.started_at IS NOT NULL THEN MAX(0, CAST(ROUND((julianday(t.completed_at) - julianday(t.started_at)) * 86400000) AS INTEGER)) ELSE NULL END",
    bot_reply_depth: '0',
  }
  const names = (db.prepare('PRAGMA table_info(message_logs)').all() as Array<{ name: string }>).map(row => row.name)
  for (const name of names) if (!columns[name]) throw new Error(`Missing processing record projection: ${name}`)
  db.exec(`CREATE TEMP VIEW IF NOT EXISTS processing_records AS
    WITH task_records AS (
      SELECT *, CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END AS payload,
        CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END AS result_payload,
        CASE WHEN json_valid(progress_json) THEN progress_json ELSE '{}' END AS progress_payload
      FROM hub_tasks WHERE kind = 'agent_turn' AND origin IN ('cli', 'mcp')
    )
    SELECT ${names.map(name => `m.${name}`).join(', ')}, 'feishu' AS origin, '' AS task_id, '' AS task_status,
      COALESCE(NULLIF(cm.name, ''), m.chat_id) AS chat_name, 1 AS audit_available, '' AS route_source
    FROM message_logs m LEFT JOIN chat_metadata cm ON cm.bot_id = m.bot_id AND cm.chat_id = m.chat_id
    UNION ALL
    SELECT ${names.map(name => `${columns[name]} AS ${name}`).join(', ')}, t.origin, t.id, t.status,
      ${input('message.chatName', "CASE WHEN t.origin = 'mcp' THEN 'MCP 会话' ELSE " + input('message.chatId') + ' END')},
      CASE WHEN json_type(t.payload, '$.executionAudit') = 'object' THEN 1 ELSE 0 END,
      ${audit('routeSource', input('route.routeSource'))}
    FROM task_records t
    LEFT JOIN bots b ON b.id = t.bot_id
    LEFT JOIN scenes s ON s.id = t.scene_id
    LEFT JOIN workspaces w ON w.id = ${columns.workspace_id}
    LEFT JOIN thread_channels tc ON tc.id = t.thread_channel_id`)
}
