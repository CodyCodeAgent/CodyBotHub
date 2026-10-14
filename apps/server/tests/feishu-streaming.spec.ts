import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { FeishuProvider } from '@codycodeagent/cody-web-core/feishu'
import { HubStore } from '../src/db.js'
import { FeishuBotManager } from '../src/feishu.js'
import type { CodyBotRuntime, RuntimeProgress, RuntimeTaskStatistics } from '../src/runtime.js'
import type { ResolvedRoute } from '../src/types.js'

afterEach(() => vi.useRealTimers())

describe('Feishu Task streaming projection', () => {
  it.each(['explicit', 'flat-group', 'disabled', 'automatic', 'private-no-mention', 'no-scene', 'other-bot', 'bot-sender', 'missing-usage', 'notify-failed', 'runtime-failed', 'result-delivery-failed'] as const)('sends optional scene statistics only after full delivery: %s', async scenario => {
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Statistics workspace', path: '/tmp/statistics-workspace' })
      const bot = store.createBot({ name: 'Statistics Bot', defaultWorkspaceId: workspace.id, conversationMode: 'topic' })
      if (scenario !== 'no-scene') store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'Statistics scene', prompt: '', priority: 100, enabled: true, completionStatisticsEnabled: scenario !== 'disabled', matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
      const message: ChannelInboundMessage = {
        provider: 'feishu', accountId: bot.id, eventId: '0123456789abcdef0123456789abcdef', messageId: 'stats-message',
        conversation: { id: 'oc_stats', scope: scenario === 'private-no-mention' ? 'private' : scenario === 'flat-group' ? 'group' : 'topic', ...(scenario === 'flat-group' || scenario === 'private-no-mention' ? {} : { rootId: 'topic-root' }) }, sender: { id: 'ou_actor', type: scenario === 'bot-sender' ? 'app' : 'user' },
        content: { type: 'text' }, text: '你好🙂', attachments: [], addressedToAgent: scenario !== 'automatic',
        mentions: scenario === 'automatic' || scenario === 'private-no-mention' ? [] : [{ id: 'ou_bot', idType: 'open_id', type: 'app', isAgent: scenario !== 'other-bot' }],
        mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
      }
      const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
      store.claimScenePicker(bot.id, message.conversation.id)
      const accepted = store.acceptInboundMessage(bot.id, route, message)!
      const delivered: string[] = []
      const provider = {
        addReaction: vi.fn(async () => 'reaction'), removeReaction: vi.fn(async () => undefined),
        updateCard: vi.fn(async (_id: string, card: unknown) => { delivered.push(JSON.stringify(card)) }),
        replyCard: vi.fn(async (_id: string, card: unknown, topic: boolean, uuid: string) => {
          expect(topic).toBe(route.replyInTopic)
          expect(uuid.length).toBeLessThanOrEqual(50)
          const content = JSON.stringify(card)
          delivered.push(content)
          if (scenario === 'result-delivery-failed' && content.includes('最终回复')) throw new Error('answer delivery failure')
          if (scenario === 'notify-failed' && content.includes('任务统计')) throw new Error('notification failure')
          return `message-${delivered.length}`
        }),
        classifyError: (error: unknown) => ({ message: String(error), retryable: false }),
      } as unknown as FeishuProvider
      const answer = '最终回复\n'.repeat(6000)
      const runtime = { execute: vi.fn(async (...args: unknown[]) => {
        if (scenario === 'runtime-failed') throw new Error('runtime failure')
        const callback = args[10] as (value: RuntimeTaskStatistics) => void
        callback({ startedAt: Date.now(), tokenUsage: scenario === 'missing-usage' ? null : { inputTokens: 2000, outputTokens: 300, totalTokens: 2300 } })
        return answer
      }) } as unknown as CodyBotRuntime
      const manager = new FeishuBotManager(store, {} as never, runtime, '/tmp/statistics-attachments')
      const result = await (manager as unknown as {
        onMessage: (jobId: string, botId: string, provider: FeishuProvider, route: ResolvedRoute, message: ChannelInboundMessage, logId: string, reaction: string) => Promise<{ ok: boolean; error: string }>
      }).onMessage(accepted.job.id, bot.id, provider, route, message, accepted.log.id, 'reaction')
      const statistics = delivered.filter(card => card.includes('任务统计'))
      const expected = ['explicit', 'flat-group', 'missing-usage', 'notify-failed'].includes(scenario)
      expect(statistics).toHaveLength(expected ? 1 : 0)
      expect(result.ok).toBe(scenario !== 'runtime-failed' && scenario !== 'result-delivery-failed')
      if (expected) {
        expect(delivered.at(-1)).toBe(statistics[0])
        expect(statistics[0]).toContain('<at id=ou_actor>')
        expect(statistics[0]).toContain('输入字符**：3')
        expect(statistics[0]).toContain('输出字符**：30,000')
        expect(statistics[0]).toContain(scenario === 'missing-usage' ? '暂无数据' : '合计 2,300')
        expect(delivered.slice(0, -1).filter(card => card.includes('最终回复')).length).toBeGreaterThan(1)
      }
    } finally { store.close() }
  })

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
