import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, type DatabaseRow as Row } from '../db-values.js'
import type { PlatformSettingsRecord } from '../types.js'

export class PlatformSettingsRepository {
  constructor(readonly db: DatabaseSync) {}

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
}
