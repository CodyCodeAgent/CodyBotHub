import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, type DatabaseRow as Row } from '../db-values.js'

// Version 1 preserves upgrades from databases created before versioned migrations.
export const migrateLegacySchema = (database: DatabaseSync): void => {
    database.exec(`
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
      CREATE TABLE IF NOT EXISTS hub_tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        principal TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
        input_json TEXT NOT NULL DEFAULT '{}',
        progress_json TEXT NOT NULL DEFAULT 'null',
        result_json TEXT NOT NULL DEFAULT 'null',
        error TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        bot_id TEXT NOT NULL DEFAULT '',
        scene_id TEXT NOT NULL DEFAULT '',
        thread_channel_id TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT '',
        source_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (origin, idempotency_key)
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
      CREATE INDEX IF NOT EXISTS idx_hub_tasks_status ON hub_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_hub_tasks_source ON hub_tasks(source_kind, source_id, created_at DESC);
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
    const botColumns = database.prepare('PRAGMA table_info(bots)').all() as Row[]
    if (!botColumns.some(column => String(column.name) === 'conversation_mode')) {
      database.exec("ALTER TABLE bots ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'chat' CHECK (conversation_mode IN ('chat', 'topic'))")
      if (botColumns.some(column => String(column.name) === 'reply_mode')) database.exec("UPDATE bots SET conversation_mode = CASE WHEN reply_mode = 'topic' THEN 'topic' ELSE 'chat' END")
    }
    if (!botColumns.some(column => String(column.name) === 'model')) database.exec("ALTER TABLE bots ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    if (!botColumns.some(column => String(column.name) === 'reasoning_effort')) database.exec("ALTER TABLE bots ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!botColumns.some(column => String(column.name) === 'runtime_kind')) database.exec("ALTER TABLE bots ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    if (!botColumns.some(column => String(column.name) === 'bot_message_policy')) database.exec("ALTER TABLE bots ADD COLUMN bot_message_policy TEXT NOT NULL DEFAULT 'mentioned_or_scene' CHECK (bot_message_policy IN ('reject', 'mentioned', 'mentioned_or_scene'))")
    if (!botColumns.some(column => String(column.name) === 'mention_source_bot')) database.exec('ALTER TABLE bots ADD COLUMN mention_source_bot INTEGER NOT NULL DEFAULT 1 CHECK (mention_source_bot IN (0, 1))')
    if (!botColumns.some(column => String(column.name) === 'bot_source_allowlist_json')) database.exec("ALTER TABLE bots ADD COLUMN bot_source_allowlist_json TEXT NOT NULL DEFAULT '[]'")
    if (!botColumns.some(column => String(column.name) === 'max_bot_reply_depth')) database.exec('ALTER TABLE bots ADD COLUMN max_bot_reply_depth INTEGER NOT NULL DEFAULT 1')
    const messageLogMentionColumns = database.prepare('PRAGMA table_info(message_logs)').all() as Row[]
    if (!messageLogMentionColumns.some(column => String(column.name) === 'bot_reply_depth')) database.exec('ALTER TABLE message_logs ADD COLUMN bot_reply_depth INTEGER NOT NULL DEFAULT 0')
    const settingsColumns = database.prepare('PRAGMA table_info(platform_settings)').all() as Row[]
    if (!settingsColumns.some(column => String(column.name) === 'default_model')) database.exec("ALTER TABLE platform_settings ADD COLUMN default_model TEXT NOT NULL DEFAULT ''")
    if (!settingsColumns.some(column => String(column.name) === 'default_reasoning_effort')) database.exec("ALTER TABLE platform_settings ADD COLUMN default_reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!settingsColumns.some(column => String(column.name) === 'model_fallback_enabled')) database.exec('ALTER TABLE platform_settings ADD COLUMN model_fallback_enabled INTEGER NOT NULL DEFAULT 1 CHECK (model_fallback_enabled IN (0, 1))')
    if (!settingsColumns.some(column => String(column.name) === 'thread_profile_refresh_interval_seconds')) database.exec('ALTER TABLE platform_settings ADD COLUMN thread_profile_refresh_interval_seconds INTEGER NOT NULL DEFAULT 5')
    if (!settingsColumns.some(column => String(column.name) === 'thread_profile_batch_size')) database.exec('ALTER TABLE platform_settings ADD COLUMN thread_profile_batch_size INTEGER NOT NULL DEFAULT 20')
    const sceneColumns = database.prepare('PRAGMA table_info(scenes)').all() as Row[]
    if (!sceneColumns.some(column => String(column.name) === 'turn_timeout_minutes')) database.exec('ALTER TABLE scenes ADD COLUMN turn_timeout_minutes INTEGER NOT NULL DEFAULT 15')
    // Existing alert Scenes retain automatic handling; newly created Scenes
    // require an explicit mention unless the operator opts into auto-replies.
    if (!sceneColumns.some(column => String(column.name) === 'require_mention')) database.exec('ALTER TABLE scenes ADD COLUMN require_mention INTEGER NOT NULL DEFAULT 0')
    if (!sceneColumns.some(column => String(column.name) === 'completion_statistics_enabled')) database.exec('ALTER TABLE scenes ADD COLUMN completion_statistics_enabled INTEGER NOT NULL DEFAULT 0')
    if (!sceneColumns.some(column => String(column.name) === 'model')) database.exec("ALTER TABLE scenes ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    if (!sceneColumns.some(column => String(column.name) === 'reasoning_effort')) database.exec("ALTER TABLE scenes ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!sceneColumns.some(column => String(column.name) === 'retrieval_config_json')) database.exec("ALTER TABLE scenes ADD COLUMN retrieval_config_json TEXT NOT NULL DEFAULT '{}'")
    const toolColumns = database.prepare('PRAGMA table_info(tools)').all() as Row[]
    if (!toolColumns.some(column => String(column.name) === 'rpc_config_json')) database.exec("ALTER TABLE tools ADD COLUMN rpc_config_json TEXT NOT NULL DEFAULT '{}'")
    if (!toolColumns.some(column => String(column.name) === 'script_language')) database.exec("ALTER TABLE tools ADD COLUMN script_language TEXT NOT NULL DEFAULT ''")
    if (!toolColumns.some(column => String(column.name) === 'script_content')) database.exec("ALTER TABLE tools ADD COLUMN script_content TEXT NOT NULL DEFAULT ''")
    if (!toolColumns.some(column => String(column.name) === 'script_version')) database.exec('ALTER TABLE tools ADD COLUMN script_version INTEGER NOT NULL DEFAULT 0')
    const messageLogColumns = database.prepare('PRAGMA table_info(message_logs)').all() as Row[]
    if (!messageLogColumns.some(column => String(column.name) === 'model')) database.exec("ALTER TABLE message_logs ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'reasoning_effort')) database.exec("ALTER TABLE message_logs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'model_source')) database.exec("ALTER TABLE message_logs ADD COLUMN model_source TEXT NOT NULL DEFAULT 'codex'")
    if (!messageLogColumns.some(column => String(column.name) === 'reasoning_effort_source')) database.exec("ALTER TABLE message_logs ADD COLUMN reasoning_effort_source TEXT NOT NULL DEFAULT 'codex'")
    if (!messageLogColumns.some(column => String(column.name) === 'model_fallback')) database.exec('ALTER TABLE message_logs ADD COLUMN model_fallback INTEGER NOT NULL DEFAULT 0 CHECK (model_fallback IN (0, 1))')
    if (!messageLogColumns.some(column => String(column.name) === 'inbound_raw_json')) database.exec("ALTER TABLE message_logs ADD COLUMN inbound_raw_json TEXT NOT NULL DEFAULT 'null'")
    if (!messageLogColumns.some(column => String(column.name) === 'investigation_json')) database.exec("ALTER TABLE message_logs ADD COLUMN investigation_json TEXT NOT NULL DEFAULT '{}'")
    if (!messageLogColumns.some(column => String(column.name) === 'core_thread_id')) {
      database.exec("ALTER TABLE message_logs ADD COLUMN core_thread_id TEXT NOT NULL DEFAULT ''")
      database.exec(`UPDATE message_logs SET core_thread_id = COALESCE((
        SELECT r.core_thread_id FROM conversation_threads r
        WHERE r.bot_id = message_logs.bot_id AND r.chat_id = message_logs.chat_id AND r.topic_id = message_logs.topic_id
        ORDER BY r.updated_at DESC LIMIT 1
      ), '') WHERE core_thread_id = ''`)
    }
    if (!messageLogColumns.some(column => String(column.name) === 'thread_route_type')) database.exec("ALTER TABLE message_logs ADD COLUMN thread_route_type TEXT NOT NULL DEFAULT 'fixed'")
    if (!messageLogColumns.some(column => String(column.name) === 'matched_thread_id')) database.exec("ALTER TABLE message_logs ADD COLUMN matched_thread_id TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'thread_match_score')) database.exec('ALTER TABLE message_logs ADD COLUMN thread_match_score REAL NOT NULL DEFAULT 0')
    if (!messageLogColumns.some(column => String(column.name) === 'thread_match_reason')) database.exec("ALTER TABLE message_logs ADD COLUMN thread_match_reason TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'thread_channel_id')) database.exec("ALTER TABLE message_logs ADD COLUMN thread_channel_id TEXT NOT NULL DEFAULT ''")
    if (!messageLogColumns.some(column => String(column.name) === 'runtime_kind')) database.exec("ALTER TABLE message_logs ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    const threadProfileColumns = database.prepare('PRAGMA table_info(thread_profiles)').all() as Row[]
    if (!threadProfileColumns.some(column => String(column.name) === 'thread_channel_id')) database.exec("ALTER TABLE thread_profiles ADD COLUMN thread_channel_id TEXT NOT NULL DEFAULT ''")
    if (!threadProfileColumns.some(column => String(column.name) === 'runtime_kind')) database.exec("ALTER TABLE thread_profiles ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    const threadChannelColumns = database.prepare('PRAGMA table_info(thread_channels)').all() as Row[]
    if (!threadChannelColumns.some(column => String(column.name) === 'runtime_kind')) database.exec("ALTER TABLE thread_channels ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex' CHECK (runtime_kind IN ('codex', 'traex'))")
    if (!threadChannelColumns.some(column => String(column.name) === 'tool_contract_version')) database.exec('ALTER TABLE thread_channels ADD COLUMN tool_contract_version INTEGER NOT NULL DEFAULT 0')
    const copilotSessionColumns = database.prepare('PRAGMA table_info(copilot_sessions)').all() as Row[]
    if (!copilotSessionColumns.some(column => String(column.name) === 'tool_contract_version')) database.exec('ALTER TABLE copilot_sessions ADD COLUMN tool_contract_version INTEGER NOT NULL DEFAULT 0')
    const threadJobColumns = database.prepare('PRAGMA table_info(thread_jobs)').all() as Row[]
    if (!threadJobColumns.some(column => String(column.name) === 'receipt_reaction_id')) database.exec("ALTER TABLE thread_jobs ADD COLUMN receipt_reaction_id TEXT NOT NULL DEFAULT ''")
    database.prepare(`WITH canonical AS (
      SELECT p.core_thread_id, p.conversation_key FROM thread_profiles p
      WHERE p.last_active_at = (SELECT MAX(p2.last_active_at) FROM thread_profiles p2 WHERE p2.core_thread_id = p.core_thread_id)
      GROUP BY p.core_thread_id
    ) INSERT OR IGNORE INTO thread_conversation_aliases (source_key, target_key, bot_id, chat_id, topic_id, created_at, updated_at)
      SELECT c.id, canonical.conversation_key, c.bot_id, c.chat_id, c.topic_id, ?, ?
      FROM conversation_threads c JOIN canonical ON canonical.core_thread_id = c.core_thread_id
      JOIN conversation_threads target ON target.id = canonical.conversation_key
      WHERE c.id <> canonical.conversation_key`).run(now(), now())
    database.exec(`INSERT OR IGNORE INTO thread_channels (id, bot_id, core_thread_id, created_at, updated_at)
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
    database.prepare(`INSERT OR IGNORE INTO thread_profile_jobs (log_id, created_at, updated_at)
      SELECT m.id, ?, ? FROM message_logs m LEFT JOIN thread_profiles p ON p.core_thread_id = m.core_thread_id AND p.scene_id = m.scene_id
      WHERE m.status = 'completed' AND m.core_thread_id <> '' AND (p.core_thread_id IS NULL OR m.received_at > p.last_active_at)`).run(now(), now())
    const sessionColumns = database.prepare('PRAGMA table_info(auth_sessions)').all() as Row[]
    if (!sessionColumns.some(column => String(column.name) === 'account_id')) database.exec("ALTER TABLE auth_sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT ''")
    const accountColumns = database.prepare('PRAGMA table_info(admin_accounts)').all() as Row[]
    if (!accountColumns.some(column => String(column.name) === 'is_primary')) database.exec('ALTER TABLE admin_accounts ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))')
    if (!accountColumns.some(column => String(column.name) === 'theme')) database.exec("ALTER TABLE admin_accounts ADD COLUMN theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark'))")
    const legacy = database.prepare('SELECT password_hash, created_at, updated_at FROM admin_credentials WHERE id = 1').get() as Row | undefined
    if (legacy && !(database.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get())) {
      database.prepare('INSERT INTO admin_accounts (id, login_name, display_name, password_hash, is_primary, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)')
        .run('legacy-admin', 'admin', '管理员', String(legacy.password_hash), String(legacy.created_at), String(legacy.updated_at))
    }
    const firstAccount = database.prepare('SELECT id FROM admin_accounts ORDER BY created_at LIMIT 1').get() as Row | undefined
    if (firstAccount) {
      if (!database.prepare('SELECT 1 FROM admin_accounts WHERE is_primary = 1 LIMIT 1').get()) database.prepare('UPDATE admin_accounts SET is_primary = 1 WHERE id = ?').run(String(firstAccount.id))
      database.prepare("UPDATE auth_sessions SET account_id = ? WHERE account_id = ''").run(String(firstAccount.id))
    }
}
