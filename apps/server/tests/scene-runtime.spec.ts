import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { HubStore } from '../src/db.js'
import { FeishuBotManager } from '../src/feishu.js'
import { sceneInput } from '../src/http/input-parsers.js'
import { handleConfigurationRoute } from '../src/http/configuration-router.js'

const message: ChannelInboundMessage = {
  provider: 'feishu', accountId: 'bot', eventId: 'event', messageId: 'message', conversation: { id: 'oc_scene_runtime', scope: 'group' },
  sender: { id: 'ou_actor', type: 'user' }, content: { type: 'text' }, text: 'test scene engine', attachments: [], addressedToAgent: true,
  mentionsOtherRecipient: false, createdAtIso: '2026-11-06T00:00:00.000Z',
}
function fixture() {
  const store = new HubStore(':memory:')
  const workspace = store.createWorkspace({ name: 'Workspace', path: '/tmp/scene-runtime' })
  store.setPlatformSettings({ ...store.getPlatformSettings(), defaultModel: 'codex-platform', defaultReasoningEffort: 'high', traexDefaultModel: 'traex-platform', traexDefaultReasoningEffort: 'low' })
  const bot = store.createBot({ name: 'Bot', runtimeKind: 'codex', model: 'codex-bot', reasoningEffort: 'medium', defaultWorkspaceId: workspace.id })
  const input = { botId: bot.id, workspaceId: workspace.id, name: 'Scene', prompt: '', priority: 100, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } }
  return { store, bot, input }
}

describe('Scene engine selection', () => {
  it('continues a tool result through its original Scene engine rather than another fallback Scene', async () => {
    const { store, bot, input } = fixture()
    try {
      store.createScene({ ...input, name: 'Codex fallback', runtimeKind: 'codex', priority: 200 })
      const scene = store.createScene({ ...input, runtimeKind: 'traex', matcher: { ...input.matcher, messageTypes: ['text'] } })
      const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message, { sceneId: scene.id }), message)
      store.setThreadChannelCoreThread(route.threadChannelId, 'traex-thread', 2)
      store.createMessageLog(bot.id, route, message)
      const execute = vi.fn(async (_route: unknown) => 'Tool result received')
      const manager = new FeishuBotManager(store, {} as never, { execute } as never, '/tmp/scene-runtime-attachments')
      const continuation = manager as unknown as { continueAfterToolExecution: (execution: unknown, provider: unknown) => Promise<void> }
      await continuation.continueAfterToolExecution({ id: 'execution', botId: bot.id, sceneId: scene.id, sourceMessageId: message.messageId, chatId: message.conversation.id, topicId: '', threadChannelId: route.threadChannelId, coreThreadId: 'traex-thread', toolPackageName: 'Test', status: 'completed', result: [] }, { replyCard: vi.fn(async () => 'sent'), classifyError: () => ({ retryable: false }) })
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ runtimeKind: 'traex', scene: { id: scene.id }, threadChannelId: route.threadChannelId })
    } finally { store.close() }
  })
  it('keeps legacy inheritance, selects independent engine defaults, and isolates native threads', () => {
    const { store, bot, input } = fixture()
    try {
      const scene = store.createScene(input)
      const original = store.resolveThreadRouting(store.resolveRoute(bot.id, message, { sceneId: scene.id }), message)
      expect(original.modelConfig).toMatchObject({ model: 'codex-bot', reasoningEffort: 'medium', modelSource: 'bot' })
      store.updateScene(scene.id, { ...input, runtimeKind: 'traex' })
      const selected = store.resolveThreadRouting(store.resolveRoute(bot.id, message, { sceneId: scene.id }), message)
      expect(selected.runtimeKind).toBe('traex')
      expect(selected.bot.runtimeKind).toBe('codex')
      expect(store.listBots()[0]?.runtimeKind).toBe('codex')
      expect(selected.modelConfig).toMatchObject({ model: 'traex-platform', reasoningEffort: 'low', modelSource: 'platform' })
      expect(selected.threadChannelId).not.toBe(original.threadChannelId)
      expect(store.getThreadChannel(selected.threadChannelId).runtimeKind).toBe('traex')
      expect(store.getThreadChannel(original.threadChannelId).runtimeKind).toBe('codex')
      expect(store.createMessageLog(bot.id, selected, message).runtimeKind).toBe('traex')
      // Older clients that omit the new field must preserve a configured override.
      expect(store.updateScene(scene.id, input).runtimeKind).toBe('traex')
      store.updateScene(scene.id, { ...input, runtimeKind: '' })
      expect(store.resolveRoute(bot.id, message, { sceneId: scene.id }).modelConfig.model).toBe('codex-bot')
    } finally { store.close() }
  })

  it('uses engine defaults rather than Bot model overrides for an explicitly selected same engine', () => {
    const { store, bot, input } = fixture()
    try {
      const scene = store.createScene({ ...input, runtimeKind: 'codex' })
      expect(store.resolveRoute(bot.id, message, { sceneId: scene.id }).modelConfig).toMatchObject({ model: 'codex-platform', reasoningEffort: 'high' })
      store.updateScene(scene.id, { ...input, runtimeKind: 'traex', model: 'scene-model', reasoningEffort: 'high' })
      expect(store.resolveRoute(bot.id, message, { sceneId: scene.id }).modelConfig).toMatchObject({ model: 'scene-model', reasoningEffort: 'high', modelSource: 'scene' })
    } finally { store.close() }
  })

  it('validates models against the Scene engine and preserves it when an older client updates a Scene', async () => {
    const { store, input } = fixture()
    try {
      const validateModelSelection = vi.fn(async () => {})
      const payloads: string[] = []
      const response = { setHeader: vi.fn(), end: vi.fn((body: string) => payloads.push(body)) }
      const invoke = async (path: string, method: string, body: object) => handleConfigurationRoute({
        request: Readable.from([JSON.stringify(body)]), response, url: new URL(`http://localhost${path}`), method, store,
        runtime: { validateModelSelection }, audit: vi.fn(),
      } as never)
      await invoke('/api/scenes', 'POST', { ...input, runtimeKind: 'traex', model: 'traex-model' })
      const created = JSON.parse(payloads.pop()!)
      expect(validateModelSelection).toHaveBeenLastCalledWith('traex', 'traex-model', '')
      await invoke(`/api/scenes/${created.id}`, 'PUT', { ...input, model: 'traex-next' })
      expect(validateModelSelection).toHaveBeenLastCalledWith('traex', 'traex-next', '')
      expect(JSON.parse(payloads.pop()!).runtimeKind).toBe('traex')
      expect(() => sceneInput({ ...input, runtimeKind: 'typo' })).toThrow('runtimeKind must be')
    } finally { store.close() }
  })
})
