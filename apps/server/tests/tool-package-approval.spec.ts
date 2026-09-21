import { describe, expect, it, vi } from 'vitest'
import { HubStore } from '../src/db.js'
import { FeishuBotManager } from '../src/feishu.js'

describe('Tool Package approval handoff', () => {
  it('sends a confirmation card and persists awaiting_approval before execution', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Approval', path: '/tmp' })
    const bot = store.createBot({ name: 'Approval Bot', defaultWorkspaceId: workspace.id })
    const tool = store.createTool({
      workspaceId: workspace.id, name: 'Protected write', description: '', executorType: 'command', command: 'printf',
      argumentsTemplate: ['%s', '{{value}}'], inputSchema: { type: 'object', required: ['value'] }, timeoutSeconds: 5, enabled: true,
    })
    const pack = store.createToolPackage({
      workspaceId: workspace.id, name: 'Approved workflow', description: '', prompt: '', approvalRequired: true,
      approverIds: [], cardTitle: '确认执行', cardDescription: '测试受控操作', enabled: true,
      steps: [{ toolId: tool.id, toolName: tool.name, phase: 'execute', position: 0, arguments: {} }],
    })
    const skill = store.createSkillPackage({ workspaceId: workspace.id, name: 'Governed skill', description: '', prompt: '', skills: [], toolPackageIds: [pack.id], fallbackMode: 'package_first' })
    store.createScene({
      botId: bot.id, workspaceId: workspace.id, name: 'Governed scene', prompt: '', priority: 10, enabled: true,
      matcher: { chatIds: ['oc_approval'], messageTypes: ['text'], textIncludes: [], cardTitleIncludes: [] }, skillPackageIds: [skill.id],
    })
    const message = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-approval', messageId: 'om_source',
      conversation: { id: 'oc_approval', scope: 'group' as const }, sender: { id: 'ou_requester', type: 'user' as const },
      content: { type: 'text' as const }, text: '请执行', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
    store.setThreadChannelCoreThread(route.threadChannelId, 'thread-approval', 2)
    const log = store.createMessageLog(bot.id, route, message)
    const replyCard = vi.fn(async () => 'om_card')
    const provider = { replyCard, classifyError: () => ({ retryable: false }) }
    const manager = new FeishuBotManager(store, {} as never, {} as never, '/tmp/codybothub-attachments')
    const internals = manager as unknown as { providers: Map<string, { provider: unknown; fingerprint: string; botName: string; state: string; error: string }> }
    internals.providers.set(bot.id, { provider, fingerprint: '', botName: bot.name, state: 'connected', error: '' })

    const result = await manager.invokeToolPackage({ callId: 'call-approval', packageId: pack.id, arguments: { value: 'preview' }, reason: '验证审批链路', sourceLogId: log.id }, { id: route.threadChannelId, threadId: 'thread-approval' })

    expect(result).toMatchObject({ status: 'awaiting_approval', toolPackage: pack.name })
    expect(replyCard).toHaveBeenCalledOnce()
    expect(replyCard.mock.calls[0]?.[0]).toBe(message.messageId)
    expect(store.listToolPackageExecutions()).toMatchObject([{ status: 'awaiting_approval', cardMessageId: 'om_card', result: null }])
    store.close()
  })

  it('returns the exact authorized UUID when the model invents a package name', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Approval', path: '/tmp' })
    const bot = store.createBot({ name: 'Approval Bot', defaultWorkspaceId: workspace.id })
    const tool = store.createTool({ workspaceId: workspace.id, name: 'Write', description: '', executorType: 'command', command: 'printf', argumentsTemplate: [], inputSchema: {}, timeoutSeconds: 5, enabled: true })
    const pack = store.createToolPackage({ workspaceId: workspace.id, name: 'Exact package', description: '', prompt: '', approvalRequired: true, approverIds: [], cardTitle: '', cardDescription: '', enabled: true, steps: [{ toolId: tool.id, toolName: tool.name, phase: 'execute', position: 0, arguments: {} }] })
    const skill = store.createSkillPackage({ workspaceId: workspace.id, name: 'Skill', description: '', prompt: '', skills: [], toolPackageIds: [pack.id], fallbackMode: 'package_first' })
    store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'Scene', prompt: '', priority: 1, enabled: true, matcher: { chatIds: ['oc_test'], messageTypes: ['text'], textIncludes: [], cardTitleIncludes: [] }, skillPackageIds: [skill.id] })
    const message = { provider: 'feishu' as const, accountId: bot.id, eventId: 'event', messageId: 'om_source', conversation: { id: 'oc_test', scope: 'group' as const }, sender: { id: 'ou_user', type: 'user' as const }, content: { type: 'text' as const }, text: 'run', attachments: [], addressedToAgent: true, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString() }
    const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
    store.setThreadChannelCoreThread(route.threadChannelId, 'thread', 2)
    const log = store.createMessageLog(bot.id, route, message)
    const manager = new FeishuBotManager(store, {} as never, {} as never, '/tmp/codybothub-attachments')

    await expect(manager.invokeToolPackage({ callId: 'bad-id', packageId: 'invented-name', arguments: {}, reason: '', sourceLogId: log.id }, { id: route.threadChannelId, threadId: 'thread' }))
      .rejects.toThrow(`Exact package=${pack.id}`)
    expect(store.listToolPackageExecutions()).toHaveLength(0)
    store.close()
  })
})
