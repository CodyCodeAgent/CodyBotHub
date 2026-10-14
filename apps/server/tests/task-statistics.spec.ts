import { describe, expect, it } from 'vitest'
import { TaskTokenUsageTracker, characterCount, taskStatisticsMarkdown, threadTokenCounters } from '../src/task-statistics.js'
import { HubStore } from '../src/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const counts = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })

describe('task statistics', () => {
  it('counts all model calls in this task, not historical tokens or the final call only', () => {
    const tracker = new TaskTokenUsageTracker(counts(10000, 1000))
    tracker.update(counts(11000, 1100), counts(1000, 100))
    tracker.update(counts(12000, 1300), counts(1000, 200))
    tracker.update(counts(12000, 1300), counts(1000, 200)) // repeated cumulative update
    expect(tracker.result()).toEqual(counts(2000, 300))
  })
  it('establishes a resumed-thread baseline from the first actual call', () => {
    const tracker = new TaskTokenUsageTracker(null)
    tracker.update(counts(11000, 1100), counts(1000, 100))
    tracker.update(counts(12000, 1300), counts(1000, 200))
    expect(tracker.result()).toEqual(counts(2000, 300))
  })
  it('does not fabricate usage for missing counters or a counter reset', () => {
    expect(new TaskTokenUsageTracker(null).result()).toBeNull()
    const unknown = new TaskTokenUsageTracker(null)
    unknown.update(counts(10000, 1000), null)
    expect(unknown.result()).toBeNull()
    const reset = new TaskTokenUsageTracker(counts(10000, 1000))
    reset.update(counts(11000, 1100), counts(1000, 100))
    reset.update(counts(1000, 100), counts(1000, 100))
    expect(reset.result()).toBeNull()
    expect(threadTokenCounters({ threadId: 't', turnId: 'turn', tokenUsage: { total: { inputTokens: -1 } } })).toBeNull()
  })
  it('counts Unicode characters and marks missing tokens explicitly', () => {
    expect(characterCount('你好🙂')).toBe(3)
    const markdown = taskStatisticsMarkdown('<at id=ou_user></at>', 155000, '你好🙂', '好了', null)
    expect(markdown).toContain('2 分 35 秒')
    expect(markdown).toContain('输入字符**：3')
    expect(markdown).toContain('输出字符**：2')
    expect(markdown).toContain('暂无数据')
  })
  it('defaults scene statistics to off and preserves explicit configuration', () => {
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Statistics fixture', path: '/tmp/statistics-fixture' })
      const bot = store.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id })
      const input = { botId: bot.id, workspaceId: workspace.id, name: 'Scene', prompt: '', enabled: true, priority: 100, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } }
      const scene = store.createScene(input)
      expect(scene.completionStatisticsEnabled).toBe(false)
      expect(store.updateScene(scene.id, { ...input, completionStatisticsEnabled: true }).completionStatisticsEnabled).toBe(true)
      expect(store.updateScene(scene.id, input).completionStatisticsEnabled).toBe(true)
      expect(store.updateScene(scene.id, { ...input, completionStatisticsEnabled: false }).completionStatisticsEnabled).toBe(false)
    } finally { store.close() }
  })
  it('persists the scene switch after restarting the store', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-statistics-'))
    let store = new HubStore(join(root, 'hub.db'))
    try {
      const workspace = store.createWorkspace({ name: 'Fixture', path: root })
      const bot = store.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id })
      store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'Scene', prompt: '', priority: 100, enabled: true, completionStatisticsEnabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
      store.close()
      store = new HubStore(join(root, 'hub.db'))
      expect(store.listScenes()[0]?.completionStatisticsEnabled).toBe(true)
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
