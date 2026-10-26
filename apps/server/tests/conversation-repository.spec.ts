import { describe, expect, it } from 'vitest'
import { HubStore } from '../src/db.js'
import { ConversationRepository } from '../src/persistence/conversation-repository.js'

describe('ConversationRepository', () => {
  it('owns message and thread-routing persistence behind HubStore compatibility methods', () => {
    const store = new HubStore(':memory:')
    const conversations = new ConversationRepository(store.db, {
      botScenes: store.botScenes,
      workspaces: store.workspaces,
      toolCatalog: store.toolCatalog,
      settings: store.settings,
      audit: store.audit,
      hubTasks: store.hubTasks,
    })
    expect(conversations.listMessageLogs()).toEqual(store.listMessageLogs())
    expect(conversations.listThreadRoutingRules()).toEqual(store.listThreadRoutingRules())
    expect(conversations.listConversationThreads()).toEqual(store.listConversationThreads())
    store.close()
  })
})
