import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AdminAccountRecord, AuditLogRecord, BotRecord, ChatMetadataRecord, ConversationThreadRecord, InvestigationTraceRecord, MessageLogRecord, ModelConfigSource, PlatformSettingsRecord, ProvisioningJobRecord, ResolvedRoute, SceneRecord, SkillInstallationRecord, SkillPackageRecord, SkillSourceRecord, ThreadChannelRecord, ThreadJobRecord, ThreadProfileRecord, ThreadRoutingDecision, ThreadRoutingRuleRecord, WorkspaceRecord } from './types.js'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { extractThreadFeatures, scoreThreadSimilarity } from './thread-routing.js'

type Row = Record<string, unknown>
type SceneWriteInput = Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt' | 'model' | 'reasoningEffort' | 'retrieval'> & {
  model?: string
  reasoningEffort?: string
  retrieval?: SceneRecord['retrieval']
  skillPackageIds?: string[]
}
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
        core_thread_id TEXT NOT NULL DEFAULT '',
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
        UNIQUE (bot_id, message_id)
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
    const threadProfileColumns = this.db.prepare('PRAGMA table_info(thread_profiles)').all() as Row[]
    if (!threadProfileColumns.some(column => String(column.name) === 'thread_channel_id')) this.db.exec("ALTER TABLE thread_profiles ADD COLUMN thread_channel_id TEXT NOT NULL DEFAULT ''")
    const threadJobColumns = this.db.prepare('PRAGMA table_info(thread_jobs)').all() as Row[]
    if (!threadJobColumns.some(column => String(column.name) === 'receipt_reaction_id')) this.db.exec("ALTER TABLE thread_jobs ADD COLUMN receipt_reaction_id TEXT NOT NULL DEFAULT ''")
    this.db.prepare(`WITH canonical AS (
      SELECT p.core_thread_id, p.conversation_key FROM thread_profiles p
      WHERE p.last_active_at = (SELECT MAX(p2.last_active_at) FROM thread_profiles p2 WHERE p2.core_thread_id = p.core_thread_id)
      GROUP BY p.core_thread_id
    ) INSERT OR IGNORE INTO thread_conversation_aliases (source_key, target_key, bot_id, chat_id, topic_id, created_at, updated_at)
      SELECT c.id, canonical.conversation_key, c.bot_id, c.chat_id, c.topic_id, ?, ?
      FROM conversation_threads c JOIN canonical ON canonical.core_thread_id = c.core_thread_id
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
  createBot(input: { name: string; description?: string; appId?: string; appSecretEncrypted?: string; prompt?: string; permissions?: string[]; operatorIds?: string[]; conversationMode?: 'chat' | 'topic'; model?: string; reasoningEffort?: string; defaultWorkspaceId: string; workspaceIds?: string[] }): BotRecord {
    const workspaceIds = [...new Set([input.defaultWorkspaceId, ...(input.workspaceIds ?? [])])]
    this.assertWorkspaces(workspaceIds)
    const id = randomUUID(), timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO bots (id, name, description, app_id, app_secret_encrypted, prompt, permissions_json, conversation_mode, model, reasoning_effort, default_workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.description ?? '', input.appId ?? '', input.appSecretEncrypted ?? '', input.prompt ?? '', JSON.stringify(input.permissions ?? []), input.conversationMode ?? 'chat', input.model ?? '', input.reasoningEffort ?? '', input.defaultWorkspaceId, timestamp, timestamp)
      const add = this.db.prepare('INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)')
      for (const workspaceId of workspaceIds) add.run(id, workspaceId)
      this.setBotOperators(id, input.operatorIds ?? [])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBot(id)
  }
  updateBot(id: string, input: { name: string; description?: string; appId?: string; appSecretEncrypted?: string | null; prompt?: string; permissions?: string[]; operatorIds?: string[]; conversationMode?: 'chat' | 'topic'; model?: string; reasoningEffort?: string; defaultWorkspaceId: string; workspaceIds?: string[] }): BotRecord {
    const workspaceIds = [...new Set([input.defaultWorkspaceId, ...(input.workspaceIds ?? [])])]
    this.assertWorkspaces(workspaceIds)
    const current = this.db.prepare('SELECT app_secret_encrypted FROM bots WHERE id = ?').get(id) as Row | undefined
    if (!current) throw new Error('Bot not found')
    const removed = this.db.prepare(`SELECT COUNT(*) AS count FROM scenes WHERE bot_id = ? AND workspace_id NOT IN (${workspaceIds.map(() => '?').join(',')})`).get(id, ...workspaceIds) as Row
    if (Number(removed.count) > 0) throw new Error('A Scene still uses a Workspace removed from this Bot')
    const secret = input.appSecretEncrypted === null || input.appSecretEncrypted === undefined ? String(current.app_secret_encrypted) : input.appSecretEncrypted
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE bots SET name = ?, description = ?, app_id = ?, app_secret_encrypted = ?, prompt = ?, permissions_json = ?, conversation_mode = ?, model = ?, reasoning_effort = ?, default_workspace_id = ?, updated_at = ? WHERE id = ?`)
        .run(input.name, input.description ?? '', input.appId ?? '', secret, input.prompt ?? '', JSON.stringify(input.permissions ?? []), input.conversationMode ?? 'chat', input.model ?? '', input.reasoningEffort ?? '', input.defaultWorkspaceId, now(), id)
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
    return { id: String(row.id), name: String(row.name), description: String(row.description), appId: String(row.app_id), hasAppSecret: Boolean(row.app_secret_encrypted), prompt: String(row.prompt), permissions: list(row.permissions_json), operatorIds, conversationMode: String(row.conversation_mode) as BotRecord['conversationMode'], model: String(row.model), reasoningEffort: String(row.reasoning_effort), defaultWorkspaceId: String(row.default_workspace_id), workspaceIds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
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

  stats(): {
    workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number
    today: { received: number; completed: number; failed: number; processing: number; reused: number; experience: number; created: number; averageDurationMs: number }
    threads: { channels: number; bindings: number; profiles: number; queuedJobs: number; processingJobs: number }
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
    return {
      workspaces: count('workspaces'), bots: count('bots'), scenes: enabledScenes, skillPackages: count('skill_packages'), messageLogs: count('message_logs'),
      today: { received: Number(activity.received), completed: Number(activity.completed), failed: Number(activity.failed), processing: Number(activity.processing), reused: Number(activity.reused), experience: Number(activity.experience), created: Number(activity.created), averageDurationMs: Number(activity.average_duration_ms || 0) },
      threads: { channels: count('thread_channels'), bindings: count('conversation_bindings'), profiles: count('thread_profiles'), queuedJobs: Number(queue.queued_jobs), processingJobs: Number(queue.processing_jobs) },
    }
  }

  createMessageLog(botId: string, route: ResolvedRoute, message: ChannelInboundMessage): MessageLogRecord {
    const id = randomUUID()
    const startedAt = now()
    const channel = this.db.prepare('SELECT core_thread_id FROM thread_channels WHERE id = ?').get(route.threadChannelId) as Row | undefined
    const coreThreadId = String(channel?.core_thread_id ?? '')
    this.db.prepare(`INSERT INTO message_logs (
      id, event_id, message_id, bot_id, bot_name, chat_id, topic_id, sender_id,
      message_type, inbound_content, inbound_raw_json, status, workspace_id, workspace_name,
      scene_id, scene_name, skill_packages_json, investigation_json, model, reasoning_effort, model_source,
      reasoning_effort_source, model_fallback, core_thread_id, thread_route_type, matched_thread_id,
      thread_match_score, thread_match_reason, thread_channel_id, received_at, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, message.eventId, message.messageId, botId, route.bot.name,
        message.conversation.id, route.topicId, message.sender.id,
        message.content?.type ?? 'unknown', message.text.slice(0, 200_000), JSON.stringify(message.content?.raw ?? null).slice(0, 500_000),
        route.workspace.id, route.workspace.name, route.scene?.id ?? '', route.scene?.name ?? '',
        JSON.stringify(route.skillPackages.map(item => ({ id: item.id, name: item.name }))),
        route.modelConfig.model, route.modelConfig.reasoningEffort, route.modelConfig.modelSource, route.modelConfig.reasoningEffortSource, coreThreadId,
        route.threadRouting.type, route.threadRouting.matchedThreadId, route.threadRouting.score, route.threadRouting.reason,
        route.threadChannelId, message.createdAtIso, startedAt,
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
    if (!error) this.db.prepare(`INSERT INTO thread_profile_jobs (log_id, created_at, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(log_id) DO UPDATE SET error = '', updated_at = excluded.updated_at`).run(id, completedAt, completedAt)
    return this.getMessageLog(id)
  }

  failProcessingMessageLogs(error = '服务在任务完成前重启，执行已中断'): number {
    const pending = this.db.prepare(`SELECT m.id, m.started_at FROM message_logs m WHERE m.status = 'processing' AND NOT EXISTS (
      SELECT 1 FROM thread_jobs tj WHERE tj.log_id = m.id AND tj.status IN ('queued', 'processing')
    )`).all() as Row[]
    if (!pending.length) return 0
    const completedAt = now()
    const update = this.db.prepare("UPDATE message_logs SET status = 'failed', error = ?, completed_at = ?, duration_ms = ? WHERE id = ? AND status = 'processing'")
    for (const row of pending) {
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(String(row.started_at)))
      update.run(error, completedAt, durationMs, String(row.id))
    }
    return pending.length
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

  getThreadChannel(id: string): { id: string; threadId: string } {
    const row = this.db.prepare('SELECT id, core_thread_id FROM thread_channels WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Thread Channel not found')
    return { id: String(row.id), threadId: String(row.core_thread_id) }
  }

  setThreadChannelCoreThread(id: string, coreThreadId: string): void {
    const result = this.db.prepare('UPDATE thread_channels SET core_thread_id = ?, updated_at = ? WHERE id = ?').run(coreThreadId, now(), id)
    if (!result.changes) throw new Error('Thread Channel not found')
  }

  enqueueThreadJob(botId: string, threadChannelId: string, message: ChannelInboundMessage, logId: string, receiptReactionId = ''): ThreadJobRecord {
    const id = randomUUID(), timestamp = now()
    this.db.prepare(`INSERT INTO thread_jobs (id, bot_id, thread_channel_id, event_id, message_id, message_json, status, log_id, receipt_reaction_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(id, botId, threadChannelId, message.eventId, message.messageId, JSON.stringify(message).slice(0, 1_000_000), logId, receiptReactionId, timestamp, timestamp)
    return this.getThreadJob(id)
  }

  recoverThreadJobs(): number {
    const timestamp = now()
    return Number(this.db.prepare(`UPDATE thread_jobs SET status = 'failed', error = '服务重启时任务仍在执行，已停止以避免重复执行', completed_at = ?, updated_at = ? WHERE status = 'processing'`)
      .run(timestamp, timestamp).changes)
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
    return this.db.prepare("UPDATE thread_jobs SET status = 'processing', attempts = attempts + 1, started_at = ?, error = '', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(timestamp, timestamp, id).changes > 0
  }

  finishThreadJob(id: string, status: 'completed' | 'failed', error = ''): void {
    const timestamp = now()
    this.db.prepare('UPDATE thread_jobs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, error.slice(0, 20_000), timestamp, timestamp, id)
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

  listThreadChannels(limit = 200): ThreadChannelRecord[] {
    const rows = this.db.prepare(`SELECT tc.*, b.name AS bot_name,
      (SELECT COUNT(*) FROM conversation_bindings cb WHERE cb.thread_channel_id = tc.id) AS binding_count,
      (SELECT COUNT(*) FROM thread_jobs tj WHERE tj.thread_channel_id = tc.id AND tj.status = 'queued') AS queued_jobs,
      (SELECT COUNT(*) FROM thread_jobs tj WHERE tj.thread_channel_id = tc.id AND tj.status = 'processing') AS processing_jobs
      FROM thread_channels tc JOIN bots b ON b.id = tc.bot_id ORDER BY tc.updated_at DESC LIMIT ?`).all(Math.min(500, Math.max(1, limit))) as Row[]
    return rows.map(row => ({ id: String(row.id), botId: String(row.bot_id), botName: String(row.bot_name), coreThreadId: String(row.core_thread_id), bindingCount: Number(row.binding_count), queuedJobs: Number(row.queued_jobs), processingJobs: Number(row.processing_jobs), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
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

  private messageLog = (row: Row): MessageLogRecord => ({
    id: String(row.id), eventId: String(row.event_id), messageId: String(row.message_id),
    botId: String(row.bot_id), botName: String(row.bot_name), chatId: String(row.chat_id), topicId: String(row.topic_id), senderId: String(row.sender_id),
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
        ? '本轮同时检索技能包和当前 Codex 环境中的其他 Skill。'
        : skillNames.length ? '本轮优先使用技能包中的 Skill；无法满足时再检索当前 Codex 环境中的其他 Skill。' : ''
    const settings = this.getPlatformSettings()
    const model = scene?.model || bot.model || settings.defaultModel
    const reasoningEffort = scene?.reasoningEffort || bot.reasoningEffort || settings.defaultReasoningEffort
    const modelSource: ModelConfigSource = scene?.model ? 'scene' : bot.model ? 'bot' : settings.defaultModel ? 'platform' : 'codex'
    const reasoningEffortSource: ModelConfigSource = scene?.reasoningEffort ? 'scene' : bot.reasoningEffort ? 'bot' : settings.defaultReasoningEffort ? 'platform' : 'codex'
    const layers = [settings.basePrompt, workspace.prompt, bot.prompt, scene?.prompt ?? '', ...packages.map(item => item.prompt)]
      .map(value => value.trim()).filter(Boolean)
    if (skillNames.length) layers.push(`当前场景技能包：${skillNames.join('、')}。${skillPolicy}`)
    return { bot, workspace, scene, skillPackages: packages, conversationMode: bot.conversationMode, replyInTopic: Boolean(topicId), routeSource, conversationKey, threadChannelId: '', topicId, turnInstructions: layers.join('\n\n'), modelConfig: { model, reasoningEffort, modelSource, reasoningEffortSource, fallbackEnabled: settings.modelFallbackEnabled }, threadRouting: { type: 'fixed', matchedThreadId: '', score: 0, reason: '当前会话固定映射' } }
  }

  resolveThreadRouting(route: ResolvedRoute, message: ChannelInboundMessage): ResolvedRoute {
    const existing = this.db.prepare(`SELECT cb.thread_channel_id, tc.core_thread_id FROM conversation_bindings cb
      JOIN thread_channels tc ON tc.id = cb.thread_channel_id WHERE cb.conversation_key = ?`).get(route.conversationKey) as Row | undefined
    if (existing) {
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
    const rows = this.db.prepare(`SELECT * FROM thread_profiles WHERE bot_id = ? AND workspace_id = ? AND scene_id = ? AND last_active_at >= ?
      ORDER BY last_active_at DESC LIMIT ?`).all(route.bot.id, route.workspace.id, route.scene.id, cutoff, rule.maxCandidates) as Row[]
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
    const current = this.db.prepare(`SELECT tc.id, tc.core_thread_id FROM conversation_bindings cb JOIN thread_channels tc ON tc.id = cb.thread_channel_id
      WHERE cb.conversation_key = ?`).get(route.conversationKey) as Row | undefined
    if (current) return { id: String(current.id), coreThreadId: String(current.core_thread_id) }
    const timestamp = now()
    const createdChannelId = preferredChannelId || randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (preferredChannelId) {
        const target = this.db.prepare('SELECT id FROM thread_channels WHERE id = ? AND bot_id = ?').get(preferredChannelId, route.bot.id)
        if (!target) throw new Error('Thread Channel not found')
      } else {
        this.db.prepare(`INSERT INTO thread_channels (id, bot_id, core_thread_id, created_at, updated_at) VALUES (?, ?, '', ?, ?)`)
          .run(createdChannelId, route.bot.id, timestamp, timestamp)
      }
      this.db.prepare(`INSERT OR IGNORE INTO conversation_bindings (conversation_key, thread_channel_id, bot_id, conversation_mode, chat_id, topic_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(route.conversationKey, createdChannelId, route.bot.id, route.conversationMode, message.conversation.id, route.topicId, timestamp, timestamp)
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

  listThreadRoutingDecisions(limit = 50): Array<{ logId: string; messageId: string; sceneName: string; type: ThreadRoutingDecision['type']; threadChannelId: string; coreThreadId: string; matchedThreadId: string; score: number; reason: string; receivedAt: string }> {
    return (this.db.prepare(`SELECT id, message_id, scene_name, thread_route_type, thread_channel_id, core_thread_id, matched_thread_id, thread_match_score, thread_match_reason, received_at
      FROM message_logs WHERE scene_id <> '' ORDER BY received_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as Row[]).map(row => ({
      logId: String(row.id), messageId: String(row.message_id), sceneName: String(row.scene_name), type: String(row.thread_route_type) as ThreadRoutingDecision['type'], threadChannelId: String(row.thread_channel_id), coreThreadId: String(row.core_thread_id), matchedThreadId: String(row.matched_thread_id), score: Number(row.thread_match_score), reason: String(row.thread_match_reason), receivedAt: String(row.received_at),
    }))
  }

  private refreshThreadProfile(logId: string): void {
    const log = this.db.prepare("SELECT * FROM message_logs WHERE id = ? AND status = 'completed' AND core_thread_id <> ''").get(logId) as Row | undefined
    if (!log) return
    const coreThreadId = String(log.core_thread_id)
    const sceneId = String(log.scene_id)
    if (!sceneId) return
    const logs = this.db.prepare(`SELECT * FROM message_logs WHERE core_thread_id = ? AND scene_id = ? AND status = 'completed' ORDER BY received_at DESC LIMIT 50`).all(coreThreadId, sceneId) as Row[]
    if (!logs.length) return
    const total = Number((this.db.prepare("SELECT COUNT(*) AS count FROM message_logs WHERE core_thread_id = ? AND scene_id = ? AND status = 'completed'").get(coreThreadId, sceneId) as Row).count)
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
    this.db.prepare(`INSERT INTO thread_profiles (core_thread_id, conversation_key, thread_channel_id, bot_id, workspace_id, scene_id, title, fields_json, normalized_text,
      experience_summary, message_count, last_message_log_id, last_active_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(core_thread_id, scene_id) DO UPDATE SET conversation_key = excluded.conversation_key, thread_channel_id = excluded.thread_channel_id, bot_id = excluded.bot_id, workspace_id = excluded.workspace_id,
      scene_id = excluded.scene_id, title = excluded.title, fields_json = excluded.fields_json, normalized_text = excluded.normalized_text,
      experience_summary = excluded.experience_summary, message_count = excluded.message_count, last_message_log_id = excluded.last_message_log_id,
      last_active_at = excluded.last_active_at, updated_at = excluded.updated_at`)
      .run(coreThreadId, threadChannelId, threadChannelId, String(latest.bot_id), String(latest.workspace_id), String(latest.scene_id), title, JSON.stringify(fieldMap), normalized.join('\n').slice(-50_000), summary, total, String(latest.id), String(latest.received_at), timestamp)
  }

  private threadRoutingRule = (row: Row): ThreadRoutingRuleRecord => ({
    sceneId: String(row.scene_id), sceneName: String(row.scene_name), botId: String(row.bot_id), botName: String(row.bot_name), workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), enabled: Boolean(row.enabled), reuseThreshold: Number(row.reuse_threshold), experienceThreshold: Number(row.experience_threshold), timeWindowHours: Number(row.time_window_hours), maxCandidates: Number(row.max_candidates), structuredWeight: Number(row.structured_weight), textWeight: Number(row.text_weight), profileCount: Number(row.profile_count), updatedAt: String(row.updated_at),
  })

  private threadProfile = (row: Row): ThreadProfileRecord => ({
    coreThreadId: String(row.core_thread_id), threadChannelId: String(row.thread_channel_id || row.conversation_key), botId: String(row.bot_id), workspaceId: String(row.workspace_id), sceneId: String(row.scene_id), title: String(row.title), fields: (() => { try { return JSON.parse(String(row.fields_json)) as Record<string, string> } catch { return {} } })(), normalizedText: String(row.normalized_text), experienceSummary: String(row.experience_summary), messageCount: Number(row.message_count), lastMessageLogId: String(row.last_message_log_id), lastActiveAt: String(row.last_active_at), updatedAt: String(row.updated_at),
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
      cb.created_at, MAX(cb.updated_at, tc.updated_at) AS updated_at, tc.core_thread_id, b.name AS bot_name,
      COALESCE(cm.name, '') AS chat_name, COALESCE(cm.mode, '') AS chat_mode ${from} ${where}
      ORDER BY updated_at DESC, cb.conversation_key DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[]
    return { items: rows.map(this.conversationThread), total }
  }

  getConversationThread(id: string): ConversationThreadRecord {
    const row = this.db.prepare(`SELECT cb.conversation_key AS id, cb.thread_channel_id, cb.bot_id, cb.conversation_mode, cb.chat_id, cb.topic_id,
      cb.created_at, MAX(cb.updated_at, tc.updated_at) AS updated_at, tc.core_thread_id, b.name AS bot_name,
      COALESCE(cm.name, '') AS chat_name, COALESCE(cm.mode, '') AS chat_mode
      FROM conversation_bindings cb JOIN thread_channels tc ON tc.id = cb.thread_channel_id JOIN bots b ON b.id = cb.bot_id
      LEFT JOIN chat_metadata cm ON cm.bot_id = cb.bot_id AND cm.chat_id = cb.chat_id WHERE cb.conversation_key = ?`).get(id) as Row | undefined
    if (!row) throw new Error('Conversation thread not found')
    return this.conversationThread(row)
  }

  private conversationThread = (row: Row): ConversationThreadRecord => ({
    id: String(row.id), threadChannelId: String(row.thread_channel_id), botId: String(row.bot_id), botName: String(row.bot_name), conversationMode: String(row.conversation_mode) as ConversationThreadRecord['conversationMode'],
    chatId: String(row.chat_id), chatName: String(row.chat_name), chatMode: String(row.chat_mode) as ConversationThreadRecord['chatMode'], topicId: String(row.topic_id),
    coreThreadId: String(row.core_thread_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

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

  private hasMatcher(scene: SceneRecord): boolean {
    const matcher = scene.matcher
    return Boolean(matcher.chatIds.length || matcher.messageTypes.length || matcher.textIncludes.length || matcher.cardTitleIncludes.length)
  }
}
