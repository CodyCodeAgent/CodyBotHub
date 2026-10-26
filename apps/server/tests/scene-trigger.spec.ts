import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { FeishuProvider } from '@codycodeagent/cody-web-core/feishu'
import { HubStore } from '../src/db.js'
import { FeishuBotManager } from '../src/feishu.js'
import type { ResolvedRoute } from '../src/types.js'

describe('Scene mention-only configuration', () => {
  it('ignores unmentioned group messages before creating a Thread Channel, then supports explicit opt-in auto-replies', () => {
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Fixture', path: '/tmp/scene-trigger-fixture' })
      const bot = store.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id, conversationMode: 'topic' })
      const input = { botId: bot.id, workspaceId: workspace.id, name: 'Group Scene', prompt: '', priority: 100, enabled: true, matcher: { chatIds: ['oc_fixture'], messageTypes: ['text'], textIncludes: [], cardTitleIncludes: [] } }
      const scene = store.createScene(input)
      expect(scene.requireMention).toBe(true)
      const message: ChannelInboundMessage = { provider: 'feishu', accountId: bot.id, eventId: 'event', messageId: 'message', conversation: { id: 'oc_fixture', scope: 'topic', rootId: 'root' }, sender: { id: 'ou_actor', type: 'user' }, text: 'ordinary chat', content: { type: 'text' }, attachments: [], addressedToAgent: false, mentionsOtherRecipient: true, createdAtIso: new Date().toISOString() }
      const provider = { isOwnSenderId: () => false } as unknown as FeishuProvider
      const manager = new FeishuBotManager(store, {} as never, {} as never, '/tmp/scene-trigger-attachments')
      const prepare = (manager as unknown as { prepareRoute: (botId: string, provider: FeishuProvider, message: ChannelInboundMessage, depth: number) => ResolvedRoute | null }).prepareRoute.bind(manager)
      expect(prepare(bot.id, provider, message, 0)).toBeNull()
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM thread_channels').get()).toMatchObject({ count: 0 })
      expect(prepare(bot.id, provider, { ...message, addressedToAgent: true }, 0)?.scene?.requireMention).toBe(true)
      expect(store.updateScene(scene.id, { ...input, requireMention: false }).requireMention).toBe(false)
      expect(prepare(bot.id, provider, message, 0)?.scene?.requireMention).toBe(false)
      // Older clients omitting the field must not silently change the switch.
      expect(store.updateScene(scene.id, input).requireMention).toBe(false)
    } finally { store.close() }
  })

  it('migrates existing automatic Scenes without disabling alerts, and persists the new switch', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-scene-trigger-'))
    const dbPath = join(root, 'hub.db')
    let store = new HubStore(dbPath)
    try {
      const workspace = store.createWorkspace({ name: 'Fixture', path: root })
      const bot = store.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id })
      const input = { botId: bot.id, workspaceId: workspace.id, name: 'Legacy automatic Scene', prompt: '', priority: 100, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } }
      const scene = store.createScene({ ...input, requireMention: false })
      store.db.exec('ALTER TABLE scenes DROP COLUMN require_mention')
      store.db.exec('ALTER TABLE scenes DROP COLUMN turn_timeout_minutes')
      // Model a database created before schema version tracking existed.
      store.db.exec('DROP TABLE schema_migrations')
      store.close()
      store = new HubStore(dbPath)
      expect(store.listScenes()[0]?.requireMention).toBe(false)
      expect(store.listScenes()[0]?.turnTimeoutMinutes).toBe(15)
      store.updateScene(scene.id, { ...input, requireMention: true, turnTimeoutMinutes: 60 })
      store.close()
      store = new HubStore(dbPath)
      expect(store.listScenes()[0]?.requireMention).toBe(true)
      expect(store.listScenes()[0]?.turnTimeoutMinutes).toBe(60)
      expect(store.createScene({ ...input, name: 'New Scene' }).requireMention).toBe(true)
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
