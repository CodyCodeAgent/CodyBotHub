import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeNotification } from '@codycodeagent/cody-web-core/runtime'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { HubStore } from '../src/db.js'
import { CodyBotRuntime } from '../src/runtime.js'

describe('Runtime task token collection', () => {
  it('collects only the admitted task turn and unsubscribes at completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-runtime-statistics-'))
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Fixture', path: root })
      const bot = store.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id })
      const message: ChannelInboundMessage = { provider: 'feishu', accountId: bot.id, eventId: 'event', messageId: 'message', conversation: { id: 'chat', scope: 'private' }, sender: { id: 'ou_actor', type: 'user' }, text: 'run', content: { type: 'text' }, attachments: [], addressedToAgent: true, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString() }
      const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
      const listeners = new Set<(notification: RuntimeNotification) => void>()
      const emit = (threadId: string, turnId: string, inputTokens: number, outputTokens: number) => {
        for (const listener of listeners) listener({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, last: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } } })
      }
      const host = { subscribe: (listener: (notification: RuntimeNotification) => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
      const manager = {
        snapshot: () => ({ threadId: 'thread' }), setContext: vi.fn(), subscribe: () => () => undefined,
        submit: () => ({ started: Promise.resolve({ turnId: 'turn' }), completed: new Promise(resolve => setTimeout(() => {
          emit('other-thread', 'turn', 99999, 99999)
          emit('thread', 'other-turn', 99999, 99999)
          emit('thread', 'turn', 1100, 110)
          emit('thread', 'turn', 1300, 140)
          resolve({ terminalEvent: { type: 'turn.completed' }, assistantText: 'done' })
        }, 0)) }),
      }
      const runtime = new CodyBotRuntime(store, root)
      const internals = runtime as unknown as {
        ensureEngine: () => Promise<unknown>; resolveModel: () => Promise<unknown>; resolveSkills: () => Promise<unknown>; ensureThreadChannel: () => Promise<unknown>
      }
      vi.spyOn(internals, 'ensureEngine').mockResolvedValue({ host, manager, tokenTotals: new Map([['thread', { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }]]) })
      vi.spyOn(internals, 'resolveModel').mockResolvedValue({ model: '', reasoningEffort: '' })
      vi.spyOn(internals, 'resolveSkills').mockResolvedValue({ attached: [], instructions: '', trace: {}, requiresDynamicTools: false })
      vi.spyOn(internals, 'ensureThreadChannel').mockResolvedValue('')
      const onUsage = vi.fn()
      expect(await runtime.execute(route, message, [], undefined, undefined, undefined, undefined, '', true, 'default', onUsage)).toBe('done')
      expect(onUsage).toHaveBeenCalledWith({ tokenUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 }, startedAt: expect.any(Number) })
      expect(listeners.size).toBe(0)
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
