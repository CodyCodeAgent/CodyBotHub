import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubStore } from '../src/db.js'
import { CodyBotRuntime } from '../src/runtime.js'

describe('Scene task timeout', () => {
  afterEach(() => vi.useRealTimers())

  it('defaults to 15 minutes, preserves omitted updates, and rejects invalid values', () => {
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Fixture', path: '/tmp/timeout-fixture' })
      const bot = store.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id })
      const input = { botId: bot.id, workspaceId: workspace.id, name: 'Scene', prompt: '', priority: 100, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } }
      const scene = store.createScene(input)
      expect(scene.turnTimeoutMinutes).toBe(15)
      expect(store.updateScene(scene.id, { ...input, turnTimeoutMinutes: 60 }).turnTimeoutMinutes).toBe(60)
      expect(store.updateScene(scene.id, input).turnTimeoutMinutes).toBe(60)
      for (const value of [0, -1, 1.5, NaN, Infinity, 35792]) expect(() => store.updateScene(scene.id, { ...input, turnTimeoutMinutes: value })).toThrow('任务超时')
    } finally { store.close() }
  })

  it('uses the scene limit instead of the global limit and interrupts only at the deadline', async () => {
    vi.useFakeTimers()
    const store = new HubStore(':memory:')
    try {
      const runtime = new CodyBotRuntime(store, '/tmp/timeout-fixture')
      const manager = { interrupt: vi.fn().mockResolvedValue(undefined) }
      const wait = (runtime as unknown as { waitForCompletion: (manager: unknown, id: string, done: Promise<unknown>, kind: string, minutes?: number) => Promise<unknown> }).waitForCompletion.bind(runtime)
      const result = wait(manager, 'channel', new Promise(() => {}), 'codex', 60)
      const rejection = expect(result).rejects.toThrow('60 分钟')
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(manager.interrupt).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(45 * 60_000)
      await rejection
      expect(manager.interrupt).toHaveBeenCalledWith('channel')
      expect(vi.getTimerCount()).toBe(0)
      const fallback = wait(manager, 'fallback', new Promise(() => {}), 'codex')
      const fallbackRejection = expect(fallback).rejects.toThrow('15 分钟')
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      await fallbackRejection
      manager.interrupt.mockClear()
      await wait(manager, 'completed', Promise.resolve({ assistantText: 'done' }), 'codex', 30)
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(manager.interrupt).not.toHaveBeenCalled()
    } finally { store.close() }
  })
})
