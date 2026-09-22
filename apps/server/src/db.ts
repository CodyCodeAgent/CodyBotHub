import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AdminAccountRecord, AgentRuntimeKind, AuditLogRecord, BotRecord, ChatMetadataRecord, ConversationThreadRecord, CopilotMessageRecord, CopilotProposalRecord, CopilotSessionRecord, InvestigationTraceRecord, MessageAttemptRecord, MessageLogRecord, ModelConfigSource, PlatformSettingsRecord, ProvisioningJobRecord, ResolvedRoute, SceneRecord, SkillInstallationRecord, SkillPackageRecord, SkillSourceRecord, StoreHealthRecord, ThreadChannelRecord, ThreadJobRecord, ThreadProfileRecord, ThreadRoutingDecision, ThreadRoutingRuleRecord, ToolPackageExecutionRecord, ToolPackageRecord, ToolRecord, ToolScriptVersionRecord, WorkspaceRecord } from './types.js'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { extractThreadFeatures, scoreThreadSimilarity } from './thread-routing.js'

type Row = Record<string, unknown>
type SceneWriteInput = Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt' | 'model' | 'reasoningEffort' | 'retrieval'> & {
  model?: string
  reasoningEffort?: string
  retrieval?: SceneRecord['retrieval']
  skillPackageIds?: string[]
}
type ToolWriteInput = Omit<ToolRecord, 'id' | 'createdAt' | 'updatedAt' | 'rpcConfig' | 'scriptLanguage' | 'scriptContent' | 'scriptVersion'> & Partial<Pick<ToolRecord, 'rpcConfig' | 'scriptLanguage' | 'scriptContent' | 'scriptVersion'>>
const now = () => new Date().toISOString()
const list = (value: unknown): string[] => {
  try { return JSON.parse(String(value)) as string[] } catch { return [] }
}
const object = (value: unknown): Record<string, unknown> => {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
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

  recoverInterruptedToolExecutions(): number {
    const timestamp = now()
    return Number(this.db.prepare("UPDATE tool_package_executions SET status = 'failed', error = '服务在工具执行期间重启，外部副作用状态未知，请人工核对后再决定是否重试', completed_at = ?, updated_at = ? WHERE status = 'running'").run(timestamp, timestamp).changes)
  }

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
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
        last_login_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        base_prompt TEXT NOT NULL DEFAULT '',
        default_model TEXT NOT NULL DEFAULT '',
        default_reasoning_effort TEXT NOT NULL DEFAULT '',
        model_fallback_enabled INTEGER NOT NULL DEFAULT 1 CHECK (model_fallback_enabled IN (0, 1)),
        thread_profile_refresh_interval_seconds INTEGER NOT NULL DEFAULT 5,
        thread_profile_batch_size INTEGER NOT NULL DEFAULT 20,
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
      CREATE TABLE IF NOT EXISTS copilot_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        core_thread_id TEXT NOT NULL DEFAULT '',
        tool_contract_version INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '平台 Copilot',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS copilot_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES copilot_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS copilot_proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES copilot_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('managed_script', 'bot_operator')),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied', 'dismissed')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT ''
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
        conversation_mode TEXT NOT NULL DEFAULT 'chat' CHECK (conversation_mode IN ('chat', 'topic')),
        bot_message_policy TEXT NOT NULL DEFAULT 'mentioned_or_scene' CHECK (bot_message_policy IN ('reject', 'mentioned', 'mentioned_or_scene')),
        mention_source_bot INTEGER NOT NULL DEFAULT 1 CHECK (mention_source_bot IN (0, 1)),
        bot_source_allowlist_json TEXT NOT NULL DEFAULT '[]',
        max_bot_reply_depth INTEGER NOT NULL DEFAULT 1,
        runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex')),
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
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
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
        retrieval_config_json TEXT NOT NULL DEFAULT '{}',
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
      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        executor_type TEXT NOT NULL DEFAULT 'bits_rpc' CHECK (executor_type IN ('bits_rpc', 'command')),
        command TEXT NOT NULL DEFAULT 'bits',
        arguments_template_json TEXT NOT NULL DEFAULT '[]',
        input_schema_json TEXT NOT NULL DEFAULT '{}',
        rpc_config_json TEXT NOT NULL DEFAULT '{}',
        script_language TEXT NOT NULL DEFAULT '',
        script_content TEXT NOT NULL DEFAULT '',
        script_version INTEGER NOT NULL DEFAULT 0,
        timeout_seconds INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS tool_script_versions (
        tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        language TEXT NOT NULL CHECK (language IN ('python', 'shell', 'node')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tool_id, version)
      );
      CREATE TABLE IF NOT EXISTS tool_packages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required IN (0, 1)),
        approver_ids_json TEXT NOT NULL DEFAULT '[]',
        card_title TEXT NOT NULL DEFAULT '',
        card_description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS tool_package_steps (
        tool_package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
        phase TEXT NOT NULL DEFAULT 'execute' CHECK (phase IN ('precheck', 'execute', 'verify')),
        position INTEGER NOT NULL DEFAULT 0,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (tool_package_id, position)
      );
      CREATE TABLE IF NOT EXISTS skill_package_tool_packages (
        skill_package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
        tool_package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (skill_package_id, tool_package_id)
      );
      CREATE TABLE IF NOT EXISTS tool_package_executions (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        tool_package_id TEXT NOT NULL REFERENCES tool_packages(id) ON DELETE RESTRICT,
        tool_package_name TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        thread_channel_id TEXT NOT NULL REFERENCES thread_channels(id) ON DELETE CASCADE,
        core_thread_id TEXT NOT NULL DEFAULT '',
        source_message_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'queued', 'running', 'completed', 'failed', 'rejected')),
        arguments_json TEXT NOT NULL DEFAULT '{}',
        reason TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT '',
        approved_by TEXT NOT NULL DEFAULT '',
        card_message_id TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT 'null',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        UNIQUE (thread_channel_id, call_id)
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
      CREATE TABLE IF NOT EXISTS topic_route_contexts (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, chat_id, topic_id)
      );
      CREATE TABLE IF NOT EXISTS chat_metadata (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'group' CHECK (mode IN ('group', 'topic', 'p2p')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        conversation_mode TEXT NOT NULL CHECK (conversation_mode IN ('chat', 'topic')),
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        core_thread_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, chat_id, topic_id)
      );
      CREATE TABLE IF NOT EXISTS thread_conversation_aliases (
        source_key TEXT PRIMARY KEY,
        target_key TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_channels (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex')),
        core_thread_id TEXT NOT NULL DEFAULT '',
        tool_contract_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_bindings (
        conversation_key TEXT PRIMARY KEY,
        thread_channel_id TEXT NOT NULL REFERENCES thread_channels(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        conversation_mode TEXT NOT NULL CHECK (conversation_mode IN ('chat', 'topic')),
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, chat_id, topic_id)
      );
      CREATE TABLE IF NOT EXISTS thread_routing_rules (
        scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        reuse_threshold REAL NOT NULL DEFAULT 0.85,
        experience_threshold REAL NOT NULL DEFAULT 0.55,
        time_window_hours INTEGER NOT NULL DEFAULT 72,
        max_candidates INTEGER NOT NULL DEFAULT 100,
        structured_weight REAL NOT NULL DEFAULT 0.7,
        text_weight REAL NOT NULL DEFAULT 0.3,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_profiles (
        core_thread_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        thread_channel_id TEXT NOT NULL DEFAULT '',
        bot_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex')),
        title TEXT NOT NULL DEFAULT '',
        fields_json TEXT NOT NULL DEFAULT '{}',
        normalized_text TEXT NOT NULL DEFAULT '',
        experience_summary TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_log_id TEXT NOT NULL DEFAULT '',
        last_active_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (core_thread_id, scene_id)
      );
      CREATE TABLE IF NOT EXISTS thread_profile_jobs (
        log_id TEXT PRIMARY KEY REFERENCES message_logs(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scene_picker_prompts (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        prompted_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
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
        runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex')),
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        sender_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL,
        inbound_content TEXT NOT NULL,
        inbound_raw_json TEXT NOT NULL DEFAULT 'null',
        response_content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        error TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        scene_id TEXT NOT NULL DEFAULT '',
        scene_name TEXT NOT NULL DEFAULT '',
        skill_packages_json TEXT NOT NULL DEFAULT '[]',
        investigation_json TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
        model_source TEXT NOT NULL DEFAULT 'codex',
        reasoning_effort_source TEXT NOT NULL DEFAULT 'codex',
        model_fallback INTEGER NOT NULL DEFAULT 0 CHECK (model_fallback IN (0, 1)),
        core_thread_id TEXT NOT NULL DEFAULT '',
        thread_route_type TEXT NOT NULL DEFAULT 'fixed',
        matched_thread_id TEXT NOT NULL DEFAULT '',
        thread_match_score REAL NOT NULL DEFAULT 0,
        thread_match_reason TEXT NOT NULL DEFAULT '',
        thread_channel_id TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        bot_reply_depth INTEGER NOT NULL DEFAULT 0,
        UNIQUE (bot_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS outbound_messages (
        message_id TEXT PRIMARY KEY,
        message_log_id TEXT NOT NULL REFERENCES message_logs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        bot_reply_depth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_jobs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        thread_channel_id TEXT NOT NULL REFERENCES thread_channels(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        log_id TEXT NOT NULL DEFAULT '',
        receipt_reaction_id TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS message_attempts (
        id TEXT PRIMARY KEY,
        log_id TEXT NOT NULL REFERENCES message_logs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        requested_by_account_id TEXT NOT NULL DEFAULT '',
        requested_by_login_name TEXT NOT NULL DEFAULT '',
        requested_by_display_name TEXT NOT NULL DEFAULT '',
        response_content TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (log_id, attempt_number)
      );
      CREATE TABLE IF NOT EXISTS skill_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        skill_roots_json TEXT NOT NULL DEFAULT '[]',
        knowledge_roots_json TEXT NOT NULL DEFAULT '[]',
        auto_install INTEGER NOT NULL DEFAULT 0 CHECK (auto_install IN (0, 1)),
        last_synced_at TEXT NOT NULL DEFAULT '',
        last_commit TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS skill_installations (
        source_id TEXT NOT NULL REFERENCES skill_sources(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        skill_key TEXT NOT NULL,
        target_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        installed_commit TEXT NOT NULL DEFAULT '',
        source_checksum TEXT NOT NULL DEFAULT '',
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, workspace_id, skill_key),
        UNIQUE (workspace_id, target_path)
      );
      CREATE INDEX IF NOT EXISTS idx_scenes_bot ON scenes(bot_id, enabled, priority);
      CREATE INDEX IF NOT EXISTS idx_threads_chat ON conversation_threads(bot_id, chat_id, topic_id);
      CREATE INDEX IF NOT EXISTS idx_thread_aliases_target ON thread_conversation_aliases(target_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_channels_core ON thread_channels(core_thread_id) WHERE core_thread_id <> '';
      CREATE INDEX IF NOT EXISTS idx_conversation_bindings_channel ON conversation_bindings(thread_channel_id);
      CREATE INDEX IF NOT EXISTS idx_thread_jobs_channel ON thread_jobs(thread_channel_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_attempts_log ON message_attempts(log_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_thread_profiles_scope ON thread_profiles(bot_id, workspace_id, scene_id, last_active_at DESC);
      CREATE INDEX IF NOT EXISTS idx_thread_profile_jobs_created ON thread_profile_jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_topic_context_scene ON topic_route_contexts(scene_id);
      CREATE INDEX IF NOT EXISTS idx_chat_metadata_name ON chat_metadata(bot_id, name);
      DELETE FROM inbound_events WHERE rowid NOT IN (SELECT MIN(rowid) FROM inbound_events GROUP BY bot_id, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_message ON inbound_events(bot_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_events(received_at);
      CREATE INDEX IF NOT EXISTS idx_message_logs_received ON message_logs(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_logs_bot ON message_logs(bot_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_logs_scene ON message_logs(scene_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outbound_messages_log ON outbound_messages(message_log_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_sources_workspace ON skill_sources(workspace_id, name);
      CREATE INDEX IF NOT EXISTS idx_skill_installations_workspace ON skill_installations(workspace_id, target_name);
      DROP TABLE IF EXISTS conversation_routes;
      DROP TABLE IF EXISTS topic_scene_bindings;
    `)
    const botColumns = this.db.prepare('PRAGMA table_info(bots)').all() as Row[]
    if (!botColumns.some(column => String(column.name) === 'conversation_mode')) {
      this.db.exec("ALTER TABLE bots ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'chat' CHECK (conversation_mode IN ('chat', 'topic'))")
      if (botColumns.some(column => String(column.name) === 'reply_mode')) this.db.exec("UPDATE bots SET conversation_mode = CASE WHEN reply_mode = 'topic' THEN 'topic' ELSE 'chat' END")
    }
    if (!botColumns.some(column => String(column.name) === 'model')) this.db.exec("ALTER TABLE bots ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    if (!botColumns.some(column => String(column.name) === 'reasoning_effort')) this.db.exec("ALTER TABLE bots ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!botColumns.some(column => String(column.name) === 'runtime_kind')) this.db.exec("ALTER TABLE bots ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    if (!botColumns.some(column => String(column.name) === 'bot_message_policy')) this.db.exec("ALTER TABLE bots ADD COLUMN bot_message_policy TEXT NOT NULL DEFAULT 'mentioned_or_scene' CHECK (bot_message_policy IN ('reject', 'mentioned', 'mentioned_or_scene'))")
    if (!botColumns.some(column => String(column.name) === 'mention_source_bot')) this.db.exec('ALTER TABLE bots ADD COLUMN mention_source_bot INTEGER NOT NULL DEFAULT 1 CHECK (mention_source_bot IN (0, 1))')
    if (!botColumns.some(column => String(column.name) === 'bot_source_allowlist_json')) this.db.exec("ALTER TABLE bots ADD COLUMN bot_source_allowlist_json TEXT NOT NULL DEFAULT '[]'")
    if (!botColumns.some(column => String(column.name) === 'max_bot_reply_depth')) this.db.exec('ALTER TABLE bots ADD COLUMN max_bot_reply_depth INTEGER NOT NULL DEFAULT 1')
    const messageLogMentionColumns = this.db.prepare('PRAGMA table_info(message_logs)').all() as Row[]
    if (!messageLogMentionColumns.some(column => String(column.name) === 'bot_reply_depth')) this.db.exec('ALTER TABLE message_logs ADD COLUMN bot_reply_depth INTEGER NOT NULL DEFAULT 0')
    const settingsColumns = this.db.prepare('PRAGMA table_info(platform_settings)').all() as Row[]
    if (!settingsColumns.some(column => String(column.name) === 'default_model')) this.db.exec("ALTER TABLE platform_settings ADD COLUMN default_model TEXT NOT NULL DEFAULT ''")
    if (!settingsColumns.some(column => String(column.name) === 'default_reasoning_effort')) this.db.exec("ALTER TABLE platform_settings ADD COLUMN default_reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!settingsColumns.some(column => String(column.name) === 'model_fallback_enabled')) this.db.exec('ALTER TABLE platform_settings ADD COLUMN model_fallback_enabled INTEGER NOT NULL DEFAULT 1 CHECK (model_fallback_enabled IN (0, 1))')
    if (!settingsColumns.some(column => String(column.name) === 'thread_profile_refresh_interval_seconds')) this.db.exec('ALTER TABLE platform_settings ADD COLUMN thread_profile_refresh_interval_seconds INTEGER NOT NULL DEFAULT 5')
    if (!settingsColumns.some(column => String(column.name) === 'thread_profile_batch_size')) this.db.exec('ALTER TABLE platform_settings ADD COLUMN thread_profile_batch_size INTEGER NOT NULL DEFAULT 20')
    const sceneColumns = this.db.prepare('PRAGMA table_info(scenes)').all() as Row[]
    if (!sceneColumns.some(column => String(column.name) === 'model')) this.db.exec("ALTER TABLE scenes ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    if (!sceneColumns.some(column => String(column.name) === 'reasoning_effort')) this.db.exec("ALTER TABLE scenes ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!sceneColumns.some(column => String(column.name) === 'retrieval_config_json')) this.db.exec("ALTER TABLE scenes ADD COLUMN retrieval_config_json TEXT NOT NULL DEFAULT '{}'")
    const toolColumns = this.db.prepare('PRAGMA table_info(tools)').all() as Row[]
    if (!toolColumns.some(column => String(column.name) === 'rpc_config_json')) this.db.exec("ALTER TABLE tools ADD COLUMN rpc_config_json TEXT NOT NULL DEFAULT '{}'")
    if (!toolColumns.some(column => String(column.name) === 'script_language')) this.db.exec("ALTER TABLE tools ADD COLUMN script_language TEXT NOT NULL DEFAULT ''")
    if (!toolColumns.some(column => String(column.name) === 'script_content')) this.db.exec("ALTER TABLE tools ADD COLUMN script_content TEXT NOT NULL DEFAULT ''")
    if (!toolColumns.some(column => String(column.name) === 'script_version')) this.db.exec('ALTER TABLE tools ADD COLUMN script_version INTEGER NOT NULL DEFAULT 0')
    const messageLogColumns = this.db.prepare('PRAGMA table_info(message_logs)').all() as Row[]
    if (!messageLogColumns.some(column => String(column.name) === 'model')) this.db.exec("ALTER TABLE message_logs ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'reasoning_effort')) this.db.exec("ALTER TABLE message_logs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'model_source')) this.db.exec("ALTER TABLE message_logs ADD COLUMN model_source TEXT NOT NULL DEFAULT 'codex'")
    if (!messageLogColumns.some(column => String(column.name) === 'reasoning_effort_source')) this.db.exec("ALTER TABLE message_logs ADD COLUMN reasoning_effort_source TEXT NOT NULL DEFAULT 'codex'")
    if (!messageLogColumns.some(column => String(column.name) === 'model_fallback')) this.db.exec('ALTER TABLE message_logs ADD COLUMN model_fallback INTEGER NOT NULL DEFAULT 0 CHECK (model_fallback IN (0, 1))')
    if (!messageLogColumns.some(column => String(column.name) === 'inbound_raw_json')) this.db.exec("ALTER TABLE message_logs ADD COLUMN inbound_raw_json TEXT NOT NULL DEFAULT 'null'")
    if (!messageLogColumns.some(column => String(column.name) === 'investigation_json')) this.db.exec("ALTER TABLE message_logs ADD COLUMN investigation_json TEXT NOT NULL DEFAULT '{}'")
    if (!messageLogColumns.some(column => String(column.name) === 'core_thread_id')) {
      this.db.exec("ALTER TABLE message_logs ADD COLUMN core_thread_id TEXT NOT NULL DEFAULT ''")
      this.db.exec(`UPDATE message_logs SET core_thread_id = COALESCE((
        SELECT r.core_thread_id FROM conversation_threads r
        WHERE r.bot_id = message_logs.bot_id AND r.chat_id = message_logs.chat_id AND r.topic_id = message_logs.topic_id
        ORDER BY r.updated_at DESC LIMIT 1
      ), '') WHERE core_thread_id = ''`)
    }
    if (!messageLogColumns.some(column => String(column.name) === 'thread_route_type')) this.db.exec("ALTER TABLE message_logs ADD COLUMN thread_route_type TEXT NOT NULL DEFAULT 'fixed'")
    if (!messageLogColumns.some(column => String(column.name) === 'matched_thread_id')) this.db.exec("ALTER TABLE message_logs ADD COLUMN matched_thread_id TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'thread_match_score')) this.db.exec('ALTER TABLE message_logs ADD COLUMN thread_match_score REAL NOT NULL DEFAULT 0')
    if (!messageLogColumns.some(column => String(column.name) === 'thread_match_reason')) this.db.exec("ALTER TABLE message_logs ADD COLUMN thread_match_reason TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'thread_channel_id')) this.db.exec("ALTER TABLE message_logs ADD COLUMN thread_channel_id TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'runtime_kind')) this.db.exec("ALTER TABLE message_logs ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    const threadProfileColumns = this.db.prepare('PRAGMA table_info(thread_profiles)').all() as Row[]
    if (!threadProfileColumns.some(column => String(column.name) === 'thread_channel_id')) this.db.exec("ALTER TABLE thread_profiles ADD COLUMN thread_channel_id TEXT NOT NULL DEFAULT ''")
    if (!threadProfileColumns.some(column => String(column.name) === 'runtime_kind')) this.db.exec("ALTER TABLE thread_profiles ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    const threadChannelColumns = this.db.prepare('PRAGMA table_info(thread_channels)').all() as Row[]
    if (!threadChannelColumns.some(column => String(column.name) === 'runtime_kind')) this.db.exec("ALTER TABLE thread_channels ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    if (!threadChannelColumns.some(column => String(column.name) === 'tool_contract_version')) this.db.exec('ALTER TABLE thread_channels ADD COLUMN tool_contract_version INTEGER NOT NULL DEFAULT 0')
    const copilotSessionColumns = this.db.prepare('PRAGMA table_info(copilot_sessions)').all() as Row[]
    if (!copilotSessionColumns.some(column => String(column.name) === 'tool_contract_version')) this.db.exec('ALTER TABLE copilot_sessions ADD COLUMN tool_contract_version INTEGER NOT NULL DEFAULT 0')
    const threadJobColumns = this.db.prepare('PRAGMA table_info(thread_jobs)').all() as Row[]
    if (!threadJobColumns.some(column => String(column.name) === 'receipt_reaction_id')) this.db.exec("ALTER TABLE thread_jobs ADD COLUMN receipt_reaction_id TEXT NOT NULL DEFAULT ''")
    this.db.prepare(`WITH canonical AS (
      SELECT p.core_thread_id, p.conversation_key FROM thread_profiles p
      WHERE p.last_active_at = (SELECT MAX(p2.last_active_at) FROM thread_profiles p2 WHERE p2.core_thread_id = p.core_thread_id)
      GROUP BY p.core_thread_id
    ) INSERT OR IGNORE INTO thread_conversation_aliases (source_key, target_key, bot_id, chat_id, topic_id, created_at, updated_at)
      SELECT c.id, canonical.conversation_key, c.bot_id, c.chat_id, c.topic_id, ?, ?
      FROM conversation_threads c JOIN canonical ON canonical.core_thread_id = c.core_thread_id
      JOIN conversation_threads target ON target.id = canonical.conversation_key
      WHERE c.id <> canonical.conversation_key`).run(now(), now())
    this.db.exec(`INSERT OR IGNORE INTO thread_channels (id, bot_id, core_thread_id, created_at, updated_at)
      SELECT 'channel:thread:' || core_thread_id, MIN(bot_id), core_thread_id, MIN(created_at), MAX(updated_at)
      FROM conversation_threads WHERE core_thread_id <> '' GROUP BY core_thread_id;
      INSERT OR IGNORE INTO thread_channels (id, bot_id, core_thread_id, created_at, updated_at)
      SELECT 'channel:conversation:' || id, bot_id, '', created_at, updated_at FROM conversation_threads WHERE core_thread_id = '';
      INSERT OR IGNORE INTO conversation_bindings (conversation_key, thread_channel_id, bot_id, conversation_mode, chat_id, topic_id, created_at, updated_at)
      SELECT id, CASE WHEN core_thread_id <> '' THEN 'channel:thread:' || core_thread_id ELSE 'channel:conversation:' || id END,
        bot_id, conversation_mode, chat_id, topic_id, created_at, updated_at FROM conversation_threads;
      UPDATE thread_profiles SET thread_channel_id = 'channel:thread:' || core_thread_id WHERE thread_channel_id = '' AND core_thread_id <> '';
      UPDATE message_logs SET thread_channel_id = COALESCE((
        SELECT cb.thread_channel_id FROM conversation_bindings cb
        WHERE cb.bot_id = message_logs.bot_id AND cb.chat_id = message_logs.chat_id AND cb.topic_id = message_logs.topic_id LIMIT 1
      ), CASE WHEN core_thread_id <> '' THEN 'channel:thread:' || core_thread_id ELSE '' END) WHERE thread_channel_id = '';
    `)
    this.db.prepare(`INSERT OR IGNORE INTO thread_profile_jobs (log_id, created_at, updated_at)
      SELECT m.id, ?, ? FROM message_logs m LEFT JOIN thread_profiles p ON p.core_thread_id = m.core_thread_id AND p.scene_id = m.scene_id
      WHERE m.status = 'completed' AND m.core_thread_id <> '' AND (p.core_thread_id IS NULL OR m.received_at > p.last_active_at)`).run(now(), now())
    const sessionColumns = this.db.prepare('PRAGMA table_info(auth_sessions)').all() as Row[]
    if (!sessionColumns.some(column => String(column.name) === 'account_id')) this.db.exec("ALTER TABLE auth_sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT ''")
    const accountColumns = this.db.prepare('PRAGMA table_info(admin_accounts)').all() as Row[]
    if (!accountColumns.some(column => String(column.name) === 'is_primary')) this.db.exec('ALTER TABLE admin_accounts ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))')
    if (!accountColumns.some(column => String(column.name) === 'theme')) this.db.exec("ALTER TABLE admin_accounts ADD COLUMN theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark'))")
    const legacy = this.db.prepare('SELECT password_hash, created_at, updated_at FROM admin_credentials WHERE id = 1').get() as Row | undefined
    if (legacy && !(this.db.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get())) {
      this.db.prepare('INSERT INTO admin_accounts (id, login_name, display_name, password_hash, is_primary, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)')
        .run('legacy-admin', 'admin', '管理员', String(legacy.password_hash), String(legacy.created_at), String(legacy.updated_at))
    }
    const firstAccount = this.db.prepare('SELECT id FROM admin_accounts ORDER BY created_at LIMIT 1').get() as Row | undefined
    if (firstAccount) {
      if (!this.db.prepare('SELECT 1 FROM admin_accounts WHERE is_primary = 1 LIMIT 1').get()) this.db.prepare('UPDATE admin_accounts SET is_primary = 1 WHERE id = ?').run(String(firstAccount.id))
      this.db.prepare("UPDATE auth_sessions SET account_id = ? WHERE account_id = ''").run(String(firstAccount.id))
    }
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
    const primary = this.db.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get() ? 0 : 1
    this.db.prepare('INSERT INTO admin_accounts (id, login_name, display_name, password_hash, is_primary, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, input.loginName, input.displayName, input.passwordHash, primary, timestamp, timestamp)
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
    if (this.getAdminAccount(id).primary) throw new Error('Cannot delete the primary administrator account')
    if (this.listAdminAccounts().filter(item => item.enabled).length <= 1) throw new Error('Cannot delete the last administrator account')
    this.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(id)
    if (!this.db.prepare('DELETE FROM admin_accounts WHERE id = ?').run(id).changes) throw new Error('Account not found')
  }
  touchAdminLogin(id: string): void { this.db.prepare('UPDATE admin_accounts SET last_login_at = ? WHERE id = ?').run(now(), id) }
  setAdminTheme(id: string, theme: AdminAccountRecord['theme']): AdminAccountRecord {
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Theme must be system, light, or dark')
    if (!this.db.prepare('UPDATE admin_accounts SET theme = ?, updated_at = ? WHERE id = ?').run(theme, now(), id).changes) throw new Error('Account not found')
    return this.getAdminAccount(id)
  }
  private adminAccount = (row: Row): AdminAccountRecord => ({
    id: String(row.id), loginName: String(row.login_name), displayName: String(row.display_name), primary: Boolean(row.is_primary), enabled: Boolean(row.enabled),
    theme: (String(row.theme || 'system') as AdminAccountRecord['theme']), lastLoginAt: String(row.last_login_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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

  getOrCreateCopilotSession(accountId: string, workspaceId: string): CopilotSessionRecord {
    this.getAdminAccount(accountId)
    this.getWorkspace(workspaceId)
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
    return (this.db.prepare('SELECT * FROM copilot_messages WHERE session_id = ? ORDER BY created_at, id').all(sessionId) as Row[]).map(row => ({ id: String(row.id), sessionId: String(row.session_id), role: String(row.role) as CopilotMessageRecord['role'], content: String(row.content), createdAt: String(row.created_at) }))
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

  getPlatformSettings(): PlatformSettingsRecord {
    const row = this.db.prepare('SELECT * FROM platform_settings WHERE id = 1').get() as Row | undefined
    return row ? {
      basePrompt: String(row.base_prompt), defaultModel: String(row.default_model), defaultReasoningEffort: String(row.default_reasoning_effort), modelFallbackEnabled: Boolean(row.model_fallback_enabled),
      threadProfileRefreshIntervalSeconds: Number(row.thread_profile_refresh_interval_seconds), threadProfileBatchSize: Number(row.thread_profile_batch_size),
    } : { basePrompt: '', defaultModel: '', defaultReasoningEffort: '', modelFallbackEnabled: true, threadProfileRefreshIntervalSeconds: 5, threadProfileBatchSize: 20 }
  }
  getPlatformPrompt(): string { return this.getPlatformSettings().basePrompt }
  setPlatformPrompt(value: string): string {
    this.setPlatformSettings({ ...this.getPlatformSettings(), basePrompt: value })
    return value
  }
  setPlatformSettings(input: PlatformSettingsRecord): PlatformSettingsRecord {
    const interval = Math.min(3600, Math.max(1, Math.trunc(input.threadProfileRefreshIntervalSeconds || 5)))
    const batchSize = Math.min(100, Math.max(1, Math.trunc(input.threadProfileBatchSize || 20)))
    this.db.prepare(`INSERT INTO platform_settings (id, base_prompt, default_model, default_reasoning_effort, model_fallback_enabled, thread_profile_refresh_interval_seconds, thread_profile_batch_size, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET base_prompt = excluded.base_prompt, default_model = excluded.default_model, default_reasoning_effort = excluded.default_reasoning_effort, model_fallback_enabled = excluded.model_fallback_enabled, thread_profile_refresh_interval_seconds = excluded.thread_profile_refresh_interval_seconds, thread_profile_batch_size = excluded.thread_profile_batch_size, updated_at = excluded.updated_at`)
      .run(input.basePrompt, input.defaultModel, input.defaultReasoningEffort, input.modelFallbackEnabled ? 1 : 0, interval, batchSize, now())
    return this.getPlatformSettings()
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
  getWorkspace(id: string): WorkspaceRecord {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Workspace not found')
    return this.workspace(row)
  }
  private workspace = (row: Row): WorkspaceRecord => ({
    id: String(row.id), name: String(row.name), path: String(row.path), prompt: String(row.prompt),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  listSkillSources(): SkillSourceRecord[] {
    return (this.db.prepare(`SELECT s.*, w.name AS workspace_name FROM skill_sources s JOIN workspaces w ON w.id = s.workspace_id ORDER BY s.name COLLATE NOCASE`).all() as Row[]).map(this.skillSource)
  }
  getSkillSource(id: string): SkillSourceRecord {
    const row = this.db.prepare(`SELECT s.*, w.name AS workspace_name FROM skill_sources s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`).get(id) as Row | undefined
    if (!row) throw new Error('Skill source not found')
    return this.skillSource(row)
  }
  createSkillSource(input: { name: string; repositoryUrl: string; branch: string; workspaceId: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean }): SkillSourceRecord {
    this.getWorkspace(input.workspaceId)
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO skill_sources (id, name, repository_url, branch, workspace_id, skill_roots_json, knowledge_roots_json, auto_install, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.repositoryUrl, input.branch, input.workspaceId, JSON.stringify(input.skillRoots), JSON.stringify(input.knowledgeRoots), input.autoInstall ? 1 : 0, timestamp, timestamp)
    return this.getSkillSource(id)
  }
  updateSkillSource(id: string, input: { name: string; repositoryUrl: string; branch: string; workspaceId: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean }): SkillSourceRecord {
    this.getWorkspace(input.workspaceId)
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
  private getBot(id: string): BotRecord {
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
  private assertWorkspaces(ids: string[]): void {
    if (!ids.length) throw new Error('At least one Workspace is required')
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as Row
    if (Number(count.count) !== ids.length) throw new Error('Workspace not found')
  }

  listScenes(): Array<SceneRecord & { skillPackageIds: string[] }> {
    return (this.db.prepare('SELECT * FROM scenes ORDER BY priority ASC, name COLLATE NOCASE').all() as Row[]).map(row => this.scene(row))
  }
  createScene(input: SceneWriteInput): SceneRecord & { skillPackageIds: string[] } {
    this.assertBotWorkspace(input.botId, input.workspaceId)
    this.assertScenePackages(input.workspaceId, input.skillPackageIds ?? [])
    const id = randomUUID(), timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO scenes (id, bot_id, workspace_id, name, prompt, priority, enabled, model, reasoning_effort, retrieval_config_json, matcher_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.botId, input.workspaceId, input.name, input.prompt, input.priority, input.enabled ? 1 : 0, input.model ?? '', input.reasoningEffort ?? '', JSON.stringify(this.normalizeRetrieval(input.retrieval)), JSON.stringify(input.matcher), timestamp, timestamp)
      this.setScenePackages(id, input.skillPackageIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getScene(id)
  }
  updateScene(id: string, input: SceneWriteInput): SceneRecord & { skillPackageIds: string[] } {
    this.assertBotWorkspace(input.botId, input.workspaceId)
    this.assertScenePackages(input.workspaceId, input.skillPackageIds ?? [])
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`UPDATE scenes SET bot_id = ?, workspace_id = ?, name = ?, prompt = ?, priority = ?, enabled = ?, model = ?, reasoning_effort = ?, retrieval_config_json = ?, matcher_json = ?, updated_at = ? WHERE id = ?`)
        .run(input.botId, input.workspaceId, input.name, input.prompt, input.priority, input.enabled ? 1 : 0, input.model ?? '', input.reasoningEffort ?? '', JSON.stringify(this.normalizeRetrieval(input.retrieval)), JSON.stringify(input.matcher), now(), id)
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
    let retrieval: Partial<SceneRecord['retrieval']> = {}
    try { retrieval = JSON.parse(String(row.retrieval_config_json)) as Partial<SceneRecord['retrieval']> } catch { /* use defaults */ }
    const skillPackageIds = (this.db.prepare('SELECT skill_package_id FROM scene_skill_packages WHERE scene_id = ? ORDER BY position').all(String(row.id)) as Row[]).map(item => String(item.skill_package_id))
    return { id: String(row.id), botId: String(row.bot_id), workspaceId: String(row.workspace_id), name: String(row.name), prompt: String(row.prompt), priority: Number(row.priority), enabled: Boolean(row.enabled), model: String(row.model), reasoningEffort: String(row.reasoning_effort), retrieval: this.normalizeRetrieval(retrieval), matcher: { chatIds: raw.chatIds ?? [], messageTypes: raw.messageTypes ?? [], textIncludes: raw.textIncludes ?? [], cardTitleIncludes: raw.cardTitleIncludes ?? [] }, skillPackageIds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
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
    this.db.prepare('UPDATE tool_package_executions SET status = ?, approved_by = ?, card_message_id = ?, result_json = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(patch.status ?? current.status, patch.approvedBy ?? current.approvedBy, patch.cardMessageId ?? current.cardMessageId, JSON.stringify(patch.result === undefined ? current.result : patch.result), patch.error ?? current.error, patch.completedAt ?? current.completedAt, now(), id)
    return this.getToolPackageExecution(id)
  }
  transitionToolPackageExecution(id: string, from: ToolPackageExecutionRecord['status'], to: ToolPackageExecutionRecord['status'], approvedBy = '', completedAt = ''): ToolPackageExecutionRecord | null {
    const result = this.db.prepare('UPDATE tool_package_executions SET status = ?, approved_by = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, approvedBy, completedAt, now(), id, from)
    return result.changes ? this.getToolPackageExecution(id) : null
  }
  private toolPackageExecution = (row: Row): ToolPackageExecutionRecord => ({ id: String(row.id), callId: String(row.call_id), toolPackageId: String(row.tool_package_id), toolPackageName: String(row.tool_package_name), botId: String(row.bot_id), sceneId: String(row.scene_id), chatId: String(row.chat_id), topicId: String(row.topic_id), threadChannelId: String(row.thread_channel_id), coreThreadId: String(row.core_thread_id), sourceMessageId: String(row.source_message_id), status: String(row.status) as ToolPackageExecutionRecord['status'], arguments: object(row.arguments_json), reason: String(row.reason), requestedBy: String(row.requested_by), approvedBy: String(row.approved_by), cardMessageId: String(row.card_message_id), result: (() => { try { return JSON.parse(String(row.result_json)) as unknown } catch { return null } })(), error: String(row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: String(row.completed_at) })

  stats(): {
    workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number
    today: { received: number; completed: number; failed: number; processing: number; reused: number; experience: number; created: number; averageDurationMs: number }
    threads: { channels: number; bindings: number; profiles: number; queuedJobs: number; processingJobs: number }
    analytics: {
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
      FROM message_logs`).get() as Row
    const dailyStart = new Date(); dailyStart.setHours(0, 0, 0, 0); dailyStart.setDate(dailyStart.getDate() - 13)
    const dailyRows = this.db.prepare(`SELECT date(received_at, 'localtime') AS date, COUNT(*) AS received,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN thread_route_type = 'reused' THEN 1 ELSE 0 END) AS reused,
      SUM(CASE WHEN thread_route_type = 'experience' THEN 1 ELSE 0 END) AS experience
      FROM message_logs WHERE received_at >= ? GROUP BY date(received_at, 'localtime') ORDER BY date`).all(dailyStart.toISOString()) as Row[]
    const dailyByDate = new Map(dailyRows.map(row => [String(row.date), row]))
    const daily = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(dailyStart); date.setDate(date.getDate() + index)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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
      GROUP BY m.bot_id, m.chat_id ORDER BY received DESC, last_active_at DESC LIMIT 10`).all() as Row[]).map(row => ({
        botId: String(row.bot_id), botName: String(row.bot_name), chatId: String(row.chat_id), chatName: String(row.chat_name), chatMode: String(row.chat_mode), received: Number(row.received), completed: Number(row.completed), failed: Number(row.failed), averageDurationMs: Number(row.average_duration_ms || 0), lastActiveAt: String(row.last_active_at),
      }))
    const sceneStats = (this.db.prepare(`SELECT scene_id, CASE WHEN scene_id = '' THEN '默认路由' ELSE MAX(scene_name) END AS scene_name,
      COUNT(*) AS received, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM message_logs GROUP BY scene_id ORDER BY received DESC LIMIT 8`).all() as Row[]).map(row => ({
        sceneId: String(row.scene_id), sceneName: String(row.scene_name), received: Number(row.received), completed: Number(row.completed), failed: Number(row.failed),
      }))
    const routes = (this.db.prepare('SELECT thread_route_type AS type, COUNT(*) AS count FROM message_logs GROUP BY thread_route_type ORDER BY count DESC').all() as Row[]).map(row => ({ type: String(row.type), count: Number(row.count) }))
    const skillUsageRows = this.db.prepare(`WITH refs AS (
      SELECT DISTINCT m.id AS log_id, json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.id') AS package_id,
        json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name') AS snapshot_name
      FROM message_logs m JOIN json_each(CASE WHEN json_valid(m.skill_packages_json) THEN m.skill_packages_json ELSE '[]' END) j
      WHERE j.type = 'object' AND json_extract(j.value, '$.id') IS NOT NULL AND json_extract(j.value, '$.id') <> ''
    )
    SELECT refs.package_id AS id, COALESCE(sp.name, MAX(refs.snapshot_name), '已删除技能包') AS name, COUNT(*) AS uses
    FROM refs LEFT JOIN skill_packages sp ON sp.id = refs.package_id
    GROUP BY refs.package_id, sp.name ORDER BY uses DESC, name COLLATE NOCASE LIMIT 10`).all() as Row[]
    const skillPackages = skillUsageRows.map(row => ({ id: String(row.id), name: String(row.name), uses: Number(row.uses) }))
    const skillPackageUses = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT m.id AS log_id, json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.id') AS package_id
      FROM message_logs m JOIN json_each(CASE WHEN json_valid(m.skill_packages_json) THEN m.skill_packages_json ELSE '[]' END) j
      WHERE j.type = 'object' AND json_extract(j.value, '$.id') IS NOT NULL AND json_extract(j.value, '$.id') <> ''
    )`).get() as Row).count)
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
      GROUP BY e.tool_package_id, tp.name ORDER BY requests DESC, name COLLATE NOCASE LIMIT 10`).all() as Row[]
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
      FROM tool_package_executions`).get() as Row
    const toolPackageRequests = Number(toolTotals.requests)
    const successfulToolCalls = Number(toolTotals.successful_tool_calls || 0)
    const toolStatus = { awaitingApproval: Number(toolTotals.awaiting_approval || 0), queued: Number(toolTotals.queued || 0), running: Number(toolTotals.running || 0), completed: Number(toolTotals.completed || 0), failed: Number(toolTotals.failed || 0), rejected: Number(toolTotals.rejected || 0) }
    return {
      workspaces: count('workspaces'), bots: count('bots'), scenes: enabledScenes, skillPackages: count('skill_packages'), messageLogs: count('message_logs'),
      today: { received: Number(activity.received), completed: Number(activity.completed), failed: Number(activity.failed), processing: Number(activity.processing), reused: Number(activity.reused), experience: Number(activity.experience), created: Number(activity.created), averageDurationMs: Number(activity.average_duration_ms || 0) },
      threads: { channels: count('thread_channels'), bindings: count('conversation_bindings'), profiles: count('thread_profiles'), queuedJobs: Number(queue.queued_jobs), processingJobs: Number(queue.processing_jobs) },
      analytics: {
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
    const completedAt = now()
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(current.startedAt))
    const error = update.error?.slice(0, 20_000) ?? ''
    this.db.prepare(`UPDATE message_logs SET response_content = ?, status = ?, error = ?, completed_at = ?, duration_ms = ? WHERE id = ?`)
      .run((update.responseContent ?? '').slice(0, 500_000), error ? 'failed' : 'completed', error, completedAt, durationMs, id)
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

  recoverInterruptedWork(error = '服务在任务完成前重启，执行已中断'): { jobs: number; messages: number } {
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const jobs = Number(this.db.prepare(`UPDATE thread_jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE status = 'processing'`)
        .run(error, timestamp, timestamp).changes)
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
      return { jobs, messages }
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
    const timestamp = now()
    const changed = this.db.prepare("UPDATE thread_jobs SET status = 'processing', attempts = attempts + 1, started_at = ?, completed_at = '', error = '', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(timestamp, timestamp, id).changes > 0
    if (changed) this.db.prepare(`UPDATE message_attempts SET status = 'processing', started_at = ?, updated_at = ?
      WHERE log_id = (SELECT log_id FROM thread_jobs WHERE id = ?) AND attempt_number = (SELECT attempts FROM thread_jobs WHERE id = ?)`)
      .run(timestamp, timestamp, id, id)
    return changed
  }

  finishThreadJob(id: string, status: 'completed' | 'failed', error = ''): void {
    const timestamp = now()
    this.db.prepare('UPDATE thread_jobs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, error.slice(0, 20_000), timestamp, timestamp, id)
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
      this.db.prepare(`UPDATE message_logs SET bot_name = ?, workspace_id = ?, workspace_name = ?, scene_id = ?, scene_name = ?,
        skill_packages_json = ?, investigation_json = '{}', model = ?, reasoning_effort = ?, model_source = ?, reasoning_effort_source = ?,
        model_fallback = 0, core_thread_id = ?, thread_route_type = 'fixed', matched_thread_id = ?, thread_match_score = 1,
        thread_match_reason = '管理员手动重试，沿用原 Thread Channel', response_content = '', status = 'processing', error = '',
        started_at = ?, completed_at = '', duration_ms = NULL WHERE id = ?`)
        .run(baseRoute.bot.name, baseRoute.workspace.id, baseRoute.workspace.name, baseRoute.scene?.id ?? '', baseRoute.scene?.name ?? '',
          JSON.stringify(baseRoute.skillPackages.map(item => ({ id: item.id, name: item.name }))), baseRoute.modelConfig.model,
          baseRoute.modelConfig.reasoningEffort, baseRoute.modelConfig.modelSource, baseRoute.modelConfig.reasoningEffortSource,
          String(channel.core_thread_id), String(channel.core_thread_id), timestamp, id)
      this.db.prepare(`UPDATE thread_jobs SET status = 'queued', receipt_reaction_id = '', error = '', started_at = '', completed_at = '', updated_at = ? WHERE id = ?`)
        .run(timestamp, String(jobRow.id))
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
    const scene = this.getScene(sceneId)
    if (scene.botId !== botId) throw new Error('Scene does not belong to this Bot')
    const timestamp = now()
    this.db.prepare(`INSERT INTO group_scene_bindings (bot_id, chat_id, scene_id, bound_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id) DO UPDATE SET scene_id = excluded.scene_id, bound_by = excluded.bound_by, updated_at = excluded.updated_at`)
      .run(botId, chatId, sceneId, actorId, timestamp, timestamp)
    this.createAuditLog({ action: 'scene.bind_group', targetType: 'scene', targetId: sceneId, summary: `通过飞书将群 ${chatId} 绑定到场景 ${scene.name}`, details: { botId, chatId, feishuActorId: actorId } })
  }

  rememberTopicRoute(botId: string, chatId: string, topicId: string, sceneId: string): void {
    if (!topicId) throw new Error('Topic ID is required')
    const scene = this.getScene(sceneId)
    if (scene.botId !== botId) throw new Error('Scene does not belong to this Bot')
    const timestamp = now()
    this.db.prepare(`INSERT INTO topic_route_contexts (bot_id, chat_id, topic_id, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id, topic_id) DO UPDATE SET scene_id = excluded.scene_id, updated_at = excluded.updated_at`)
      .run(botId, chatId, topicId, sceneId, timestamp, timestamp)
  }

  resolveRoute(botId: string, message: ChannelInboundMessage): ResolvedRoute {
    const bot = this.getBot(botId)
    const topicId = bot.conversationMode === 'topic' && message.conversation.scope !== 'private'
      ? (message.conversation.rootId || message.messageId)
      : ''
    const topicContext = topicId
      ? this.db.prepare('SELECT scene_id FROM topic_route_contexts WHERE bot_id = ? AND chat_id = ? AND topic_id = ?').get(botId, message.conversation.id, topicId) as Row | undefined
      : undefined
    const groupBinding = this.db.prepare('SELECT scene_id FROM group_scene_bindings WHERE bot_id = ? AND chat_id = ?').get(botId, message.conversation.id) as Row | undefined
    const candidates = this.listScenes().filter(scene => scene.botId === botId && scene.enabled)
    const topicBound = topicContext ? candidates.find(scene => scene.id === String(topicContext.scene_id)) ?? null : null
    const groupBound = groupBinding ? candidates.find(scene => scene.id === String(groupBinding.scene_id)) ?? null : null
    const matched = candidates.find(candidate => this.hasMatcher(candidate) && this.sceneMatches(candidate, message)) ?? null
    const fallback = candidates.find(candidate => !this.hasMatcher(candidate)) ?? null
    const scene = matched ?? topicBound ?? groupBound ?? fallback
    const routeSource: ResolvedRoute['routeSource'] = matched ? 'matcher' : topicBound ? 'topic_context' : groupBound ? 'group_binding' : 'default'
    const workspace = this.getWorkspace(scene?.workspaceId ?? bot.defaultWorkspaceId)
    const packages = scene ? this.listSkillPackages().filter(item => scene.skillPackageIds.includes(item.id)) : []
    const conversationKey = topicId ? `bot:${bot.id}:chat:${message.conversation.id}:topic:${topicId}` : `bot:${bot.id}:chat:${message.conversation.id}`
    const skillNames = packages.flatMap(item => item.skills)
    const skillPolicy = packages.some(item => item.fallbackMode === 'package_only')
      ? '本轮只允许使用技能包中列出的 Skill。'
      : packages.some(item => item.fallbackMode === 'mixed')
        ? '本轮同时检索技能包和当前 Agent 运行环境中的其他 Skill。'
        : skillNames.length ? '本轮优先使用技能包中的 Skill；无法满足时再检索当前 Agent 运行环境中的其他 Skill。' : ''
    const settings = this.getPlatformSettings()
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

  resolveThreadRouting(route: ResolvedRoute, message: ChannelInboundMessage): ResolvedRoute {
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
    this.getScene(sceneId)
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
    return this.sceneMatches(this.getScene(sceneId), message)
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
    for (const scene of this.listScenes().filter(item => item.botId === botId)) for (const chatId of scene.matcher.chatIds) ids.add(chatId)
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

  private hasMatcher(scene: SceneRecord): boolean {
    const matcher = scene.matcher
    return Boolean(matcher.chatIds.length || matcher.messageTypes.length || matcher.textIncludes.length || matcher.cardTitleIncludes.length)
  }
}
