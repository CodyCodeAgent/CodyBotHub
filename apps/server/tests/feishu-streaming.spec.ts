import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { FeishuProvider } from '@codycodeagent/cody-web-core/feishu'
import { HubStore } from '../src/db.js'
import { FeishuBotManager } from '../src/feishu.js'
import type { CodyBotRuntime, RuntimeProgress } from '../src/runtime.js'
import type { ResolvedRoute } from '../src/types.js'

afterEach(() => vi.useRealTimers())

describe('Feishu Task streaming projection', () => {
  it.each(['completed', 'failed', 'delivery-failed'] as const)('mentions humans only in the final result card: %s', async scenario => {
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Notify workspace', path: '/tmp/codybothub-notify' })
      const bot = store.createBot({ name: 'Notify Bot', defaultWorkspaceId: workspace.id })
      const message: ChannelInboundMessage = {
        provider: 'feishu', accountId: bot.id, eventId: '0123456789abcdef0123456789abcdef', messageId: 'notify-message',
        conversation: { id: 'oc_group', scope: 'group' }, sender: { id: 'ou_user', type: 'user' },
        content: { type: 'text' }, text: 'run', attachments: [], addressedToAgent: true,
        mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
      }
      const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
      // Scene selection is independent of answer/notification sequencing.
      store.claimScenePicker(bot.id, message.conversation.id)
      const accepted = store.acceptInboundMessage(bot.id, route, message)!
      const events: Array<{ kind: string; content: string }> = []
      const provider = {
        addReaction: vi.fn(async () => 'reaction'), removeReaction: vi.fn(async () => undefined),
        replyCard: vi.fn(async (_id: string, card: unknown, _topic: boolean, uuid: string) => {
          expect(uuid.length).toBeLessThanOrEqual(50)
          const content = JSON.stringify(card)
          events.push({ kind: 'reply', content })
          if (scenario === 'delivery-failed' && content.includes('处理失败')) throw new Error('delivery unavailable')
          return `outbound-${events.length}`
        }),
        updateCard: vi.fn(async (_id: string, card: unknown) => {
          events.push({ kind: 'update', content: JSON.stringify(card) })
          if (scenario === 'delivery-failed') throw new Error('delivery unavailable')
        }),
        classifyError: (error: unknown) => ({ message: String(error), retryable: false }),
      } as unknown as FeishuProvider
      const runtime = { execute: vi.fn(async () => {
        if (scenario === 'failed' || scenario === 'delivery-failed') throw new Error('runtime failed')
        return '最终答案\n'.repeat(6000)
      }) } as unknown as CodyBotRuntime
      const manager = new FeishuBotManager(store, {} as never, runtime, '/tmp/codybothub-attachments')
      const result = await (manager as unknown as {
        onMessage: (jobId: string, botId: string, provider: FeishuProvider, route: ResolvedRoute, message: ChannelInboundMessage, logId: string, reaction: string) => Promise<{ ok: boolean; error: string }>
      }).onMessage(accepted.job.id, bot.id, provider, route, message, accepted.log.id, '')
      const mentions = events.filter(event => event.content.includes('<at'))
      expect(events[0]?.content).not.toContain('<at')
      expect(mentions).toHaveLength(1)
      expect(events.at(-1)).toBe(mentions[0])
      expect(mentions[0]?.content).toContain('回复 <at')
      expect(events.some(event => event.content.includes('请查看上方'))).toBe(false)
      expect(result.ok).toBe(scenario === 'completed')
      if (scenario === 'completed') expect(events.filter(event => event.content.includes('最终答案')).length).toBeGreaterThan(1)
    } finally { store.close() }
  })

  it('streams partial output to the card, persists Task progress, and finalizes the same card', async () => {
    vi.useFakeTimers()
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Streaming workspace', path: '/tmp/codybothub-streaming' })
    const bot = store.createBot({ name: 'Streaming Bot', defaultWorkspaceId: workspace.id })
    const message: ChannelInboundMessage = {
      provider: 'feishu', accountId: bot.id, eventId: 'event-stream', messageId: 'message-stream',
      conversation: { id: 'ou_stream', scope: 'private' }, sender: { id: 'ou_stream', type: 'user' },
      content: { type: 'text' }, text: '请流式回答', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
    const accepted = store.acceptInboundMessage(bot.id, route, message)!
    expect(store.startThreadJob(accepted.job.id)).toBe(true)

    const replyCard = vi.fn(async () => 'stream-card-message')
    const updateCard = vi.fn(async () => undefined)
    const provider = {
      addReaction: vi.fn(async () => 'receipt-reaction'),
      removeReaction: vi.fn(async () => undefined),
      replyCard,
      updateCard,
      classifyError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error), retryable: false }),
    } as unknown as FeishuProvider
    const runtime = {
      execute: vi.fn(async (
        _route: ResolvedRoute,
        _message: ChannelInboundMessage,
        _attachments: unknown[],
        onProgress?: (progress: RuntimeProgress) => void,
      ) => {
        onProgress?.({ phase: 'answering', reasoning: '', answer: '部分答案' })
        await new Promise(resolve => setTimeout(resolve, 500))
        return '最终答案'
      }),
    } as unknown as CodyBotRuntime
    const manager = new FeishuBotManager(store, {} as never, runtime, '/tmp/codybothub-attachments')
    const onMessage = (manager as unknown as {
      onMessage: (jobId: string, botId: string, provider: FeishuProvider, route: ResolvedRoute, message: ChannelInboundMessage, logId: string, receiptReactionId: string) => Promise<{ ok: boolean; error: string }>
    }).onMessage.bind(manager)

    const resultPromise = onMessage(accepted.job.id, bot.id, provider, route, message, accepted.log.id, '')
    await vi.advanceTimersByTimeAsync(450)

    expect(replyCard).toHaveBeenCalledOnce()
    expect(updateCard).toHaveBeenCalledOnce()
    expect(JSON.stringify(updateCard.mock.calls[0]?.[1])).toContain('部分答案')
    expect(store.latestHubTaskForSource('thread_job', accepted.job.id)).toMatchObject({
      status: 'running', progress: { phase: 'answering', answer: '部分答案' },
    })

    await vi.advanceTimersByTimeAsync(50)
    await expect(resultPromise).resolves.toEqual({ ok: true, error: '' })
    expect(updateCard).toHaveBeenCalledTimes(2)
    expect(updateCard.mock.calls[0]?.[0]).toBe('stream-card-message')
    expect(updateCard.mock.calls[1]?.[0]).toBe('stream-card-message')
    expect(JSON.stringify(updateCard.mock.calls[1]?.[1])).toContain('最终答案')
    expect(store.getMessageLog(accepted.log.id)).toMatchObject({ status: 'completed', responseContent: '最终答案' })

    store.finishThreadJob(accepted.job.id, 'completed')
    expect(store.latestHubTaskForSource('thread_job', accepted.job.id)).toMatchObject({
      status: 'completed', result: { text: '最终答案' },
    })
    store.close()
  })
})
