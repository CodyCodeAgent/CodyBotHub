import { describe, expect, it, vi } from 'vitest'
import { HubStore } from '../src/db.js'
import { HubTaskService } from '../src/tasks.js'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { ResolvedRoute } from '../src/types.js'

function fixture(mode: 'chat' | 'topic' = 'chat') {
  const store = new HubStore(':memory:')
  const workspace = store.createWorkspace({ name: 'Workspace', path: '/tmp' })
  const bot = store.createBot({ name: 'API Bot', defaultWorkspaceId: workspace.id, conversationMode: mode })
  const identity = store.identities.create({ name: 'Employee', type: 'digital_employee', defaultBotId: bot.id })
  const message = { chatId: 'oc_group', topicId: 'om_root', messageId: 'om_first', sender: { id: 'ou_original', name: 'Original', appId: 'cli_source', idType: 'open_id' }, message: { type: 'card', title: 'Alert', text: 'Explain alert', raw: { service: 'payments' } } }
  return { store, workspace, bot, identity, message }
}

describe('CLI group task routing', () => {
  it('infers the authorized Bot from sceneId, pins explicit routing across recovery and rejects stale or conflicting selections', async () => {
    const { store, workspace, bot, identity, message } = fixture('topic')
    const target = store.createBot({ name: 'Other authorized Bot', defaultWorkspaceId: workspace.id, conversationMode: 'topic' })
    const caller = store.identities.update(identity.id, { ...identity, allowedBotIds: [bot.id, target.id], enabled: true })
    const base = { botId: target.id, workspaceId: workspace.id, prompt: '', priority: 100, enabled: true, matcher: { chatIds: ['not_this_group'], messageTypes: ['interactive'], textIncludes: ['never_match'], cardTitleIncludes: [] } }
    const scene = store.createScene({ ...base, name: 'Selected' })
    const alternate = store.createScene({ ...base, name: 'Alternate' })
    const stopped = new HubTaskService(store, {} as never)
    stopped.beginDrain()
    const selectedMessage = { ...message, sceneId: scene.id }
    const task = stopped.dispatchMessage(selectedMessage, caller, 'cred')
    expect(task.route).toMatchObject({ botId: target.id, sceneId: scene.id, routeSource: 'explicit' })
    expect(stopped.dispatchMessage({ ...selectedMessage, botId: target.id }, caller, 'cred').taskId).toBe(task.taskId)
    expect(() => stopped.dispatchMessage({ ...selectedMessage, sceneId: alternate.id }, caller, 'cred')).toThrow('different content')
    expect(() => stopped.dispatchMessage({ ...selectedMessage, botId: bot.id }, caller, 'cred')).toThrow('does not belong')
    expect(() => stopped.dispatchMessage(selectedMessage, identity, 'cred')).toThrow('not allowed')
    expect(() => stopped.dispatchMessage({ ...message, sceneId: '00000000-0000-4000-8000-000000000000' }, caller, 'cred')).toThrow('Scene not found')
    const disabled = stopped.dispatchMessage({ ...message, topicId: 'om_disabled_topic', messageId: 'om_disabled', sceneId: alternate.id }, caller, 'cred')
    store.updateScene(alternate.id, { ...base, name: 'Alternate', enabled: false })
    const deletedScene = store.createScene({ ...base, name: 'Will delete' })
    const deleted = stopped.dispatchMessage({ ...message, topicId: 'om_deleted_topic', messageId: 'om_deleted', sceneId: deletedScene.id }, caller, 'cred')
    store.deleteScene(deletedScene.id)
    // A higher-priority matching Scene must not replace an explicitly selected Scene after restart.
    store.createScene({ ...base, name: 'Competing automatic scene', priority: 1, matcher: { chatIds: [], messageTypes: [], textIncludes: ['alert'], cardTitleIncludes: [] } })
    const execute = vi.fn(async (_route: ResolvedRoute) => 'explicit answer')
    const restarted = new HubTaskService(store, { execute } as never)
    try {
      restarted.resumeQueuedTasks()
      expect((await restarted.waitInteraction(task.taskId, caller.id, 1000)).answer).toBe('explicit answer')
      expect(execute.mock.calls[0]![0].scene?.id).toBe(scene.id)
      expect(restarted.getInteraction(disabled.taskId, caller.id).status).toBe('failed')
      expect(restarted.getInteraction(deleted.taskId, caller.id).status).toBe('failed')
      expect(execute).toHaveBeenCalledOnce()
      const next = restarted.dispatchMessage({ ...message, botId: target.id, messageId: 'om_followup', message: { type: 'text', text: 'continue' } }, caller, 'cred')
      expect(next.route).toMatchObject({ sceneId: scene.id, routeSource: 'topic_context', threadChannelId: task.route.threadChannelId })
    } finally { await restarted.waitForIdle(); store.close() }
  })

  it('matches real group metadata, keeps native threads per identity/topic, deduplicates and enforces read-only execution', async () => {
    const { store, workspace, bot, identity, message } = fixture('topic')
    const pack = store.createSkillPackage({ workspaceId: workspace.id, name: 'Guide', description: '', prompt: '', skills: [], fallbackMode: 'package_first' })
    const scene = store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'Alert', prompt: '', priority: 1, enabled: true, matcher: { chatIds: ['oc_group'], messageTypes: ['card'], textIncludes: ['alert'], cardTitleIncludes: ['Alert'] }, skillPackageIds: [pack.id] })
    const execute = vi.fn(async (_route: ResolvedRoute, _message: ChannelInboundMessage) => 'Answer')
    const tasks = new HubTaskService(store, { execute } as never)
    try {
      const task = tasks.dispatchMessage(message, identity, 'credential-one')
      const duplicate = tasks.dispatchMessage({ ...message, eventId: 'new-delivery-id' }, identity, 'credential-two')
      expect(task.taskId).toBe(duplicate.taskId)
      expect(() => tasks.dispatchMessage({ ...message, message: { ...message.message, text: 'Changed' } }, identity, 'cred')).toThrow('different content')
      const next = tasks.dispatchMessage({ ...message, messageId: 'om_next' }, identity, 'cred')
      const otherTopic = tasks.dispatchMessage({ ...message, messageId: 'om_other', topicId: 'om_other_root' }, identity, 'cred')
      const otherIdentity = store.identities.create({ name: 'Other', type: 'bot', defaultBotId: bot.id })
      const otherTask = tasks.dispatchMessage(message, otherIdentity, 'other-cred')
      expect(next.route.threadChannelId).toBe(task.route.threadChannelId)
      expect(otherTopic.route.threadChannelId).not.toBe(task.route.threadChannelId)
      expect(otherTask.route.threadChannelId).not.toBe(task.route.threadChannelId)
      expect(() => tasks.getInteraction(task.taskId, otherIdentity.id)).toThrow('Task not found')
      const result = await tasks.waitInteraction(task.taskId, identity.id, 2000)
      expect(result).toMatchObject({ status: 'completed', answer: 'Answer', route: { sceneId: scene.id, workspaceId: workspace.id, routeSource: 'matcher' } })
      await tasks.waitForIdle()
      expect(execute).toHaveBeenCalledTimes(4)
      const call = execute.mock.calls[0]!
      expect(call[0].skillPackages[0]?.toolPackageIds).toEqual([])
      expect(call[1]).toMatchObject({ conversation: { id: message.chatId, rootId: message.topicId }, sender: { id: 'ou_original' }, content: { title: 'Alert', raw: { service: 'payments' } } })
      expect(call[1].text).toContain('cli_source')
      expect((execute.mock.calls[0] as unknown[])[8]).toBe(false)
      expect((execute.mock.calls[0] as unknown[])[9]).toBe('read_only')
      expect(() => tasks.dispatchMessage({ ...message, botId: '00000000-0000-4000-8000-000000000000' }, identity, 'cred')).toThrow('not allowed')
    } finally { await tasks.waitForIdle(); store.close() }
  })

  it('serializes one channel, allows other groups concurrently and restores queued tasks without replaying running work', async () => {
    const { store, identity, message } = fixture()
    const stopped = new HubTaskService(store, {} as never)
    stopped.beginDrain()
    const first = stopped.dispatchMessage(message, identity, 'cred')
    const second = stopped.dispatchMessage({ ...message, messageId: 'om_second' }, identity, 'cred')
    const third = stopped.dispatchMessage({ ...message, messageId: 'om_third', chatId: 'oc_other' }, identity, 'cred')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const execute = vi.fn(async (_route: ResolvedRoute, inbound: ChannelInboundMessage) => {
      started.push(inbound.messageId)
      if (inbound.messageId === message.messageId) await gate
      return inbound.messageId
    })
    const restored = new HubTaskService(store, { execute } as never)
    try {
      restored.resumeQueuedTasks()
      await restored.waitInteraction(third.taskId, identity.id, 1000)
      // A recovered queue preserves acceptance order, so the second message cannot overtake the first.
      expect(started).toContain(message.messageId)
      expect(started).not.toContain('om_second')
      release()
      await restored.waitForIdle()
      expect(restored.getInteraction(second.taskId, identity.id).status).toBe('completed')
      expect(restored.getInteraction(first.taskId, identity.id).status).toBe('completed')
      expect(started.indexOf(message.messageId)).toBeLessThan(started.indexOf('om_second'))
      const interrupted = store.createHubTask({ origin: 'cli', principal: identity.id, kind: 'agent_turn', idempotencyKey: 'interrupted', taskInput: {} })
      store.transitionHubTask(interrupted.id, { type: 'start' })
      store.recoverInterruptedWork()
      expect(store.getHubTask(interrupted.id).status).toBe('failed')
    } finally { release(); await restored.waitForIdle(); store.close() }
  })

  it('fails queued tasks after an identity is disabled', async () => {
    const { store, identity, message } = fixture()
    const service = new HubTaskService(store, {} as never)
    service.beginDrain()
    const task = service.dispatchMessage(message, identity, 'cred')
    store.identities.update(identity.id, { ...identity, enabled: false })
    service.cancelDrain()
    expect(service.getInteraction(task.taskId, identity.id).status).toBe('failed')
    store.close()
  })

  it('inherits the matched topic Scene only inside the same CLI identity', async () => {
    const { store, workspace, bot, identity, message } = fixture('topic')
    const scene = store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'Alert', prompt: '', priority: 1, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: ['alert'], cardTitleIncludes: [] } })
    const tasks = new HubTaskService(store, { execute: async () => 'answer' } as never)
    try {
      tasks.dispatchMessage(message, identity, 'cred')
      const followup = { ...message, messageId: 'om_followup', message: { type: 'text', text: 'continue' } }
      const inherited = tasks.dispatchMessage(followup, identity, 'cred')
      expect(inherited.route).toMatchObject({ sceneId: scene.id, routeSource: 'topic_context' })
      const other = store.identities.create({ name: 'Other', type: 'bot', defaultBotId: bot.id })
      expect(tasks.dispatchMessage(followup, other, 'cred').route.sceneId).toBe('')
      const feishu = store.resolveRoute(bot.id, { provider: 'feishu', accountId: bot.id, eventId: 'evt', messageId: 'om_feishu', conversation: { id: message.chatId, scope: 'topic', rootId: message.topicId }, sender: { id: 'ou_original', type: 'user' }, text: 'continue', content: { type: 'text' }, attachments: [], addressedToAgent: true, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString() })
      expect(feishu.scene).toBeNull()
    } finally { await tasks.waitForIdle(); store.close() }
  })
})
