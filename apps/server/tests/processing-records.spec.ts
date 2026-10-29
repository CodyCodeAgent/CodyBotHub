import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubStore } from '../src/db.js'
import { HubTaskService } from '../src/tasks.js'
import { handleInsightsRoute } from '../src/http/insights-router.js'
import type { CodyBotRuntime } from '../src/runtime.js'

const stores: HubStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture() {
  const store = new HubStore(':memory:'); stores.push(store)
  const workspace = store.createWorkspace({ name: 'AI Hub', path: '/tmp' })
  const bot = store.createBot({ name: 'Employee executor', defaultWorkspaceId: workspace.id })
  const identity = store.identities.create({ name: 'Employee', type: 'digital_employee', defaultBotId: bot.id })
  const pack = store.createSkillPackage({ workspaceId: workspace.id, name: 'Budget skills', prompt: '', description: '', skills: ['budget-oncall'], fallbackMode: 'package_first' })
  const sceneInput = { botId: bot.id, workspaceId: workspace.id, name: 'Budget alert', prompt: '', enabled: true, priority: 100,
    matcher: { chatIds: ['another-group'], messageTypes: [], textIncludes: [], cardTitleIncludes: [] }, skillPackageIds: [pack.id] }
  const scene = store.createScene(sceneInput)
  const message = { sceneId: scene.id, chatId: 'oc_original', chatName: 'Budget group', topicId: 'om_topic', messageId: 'om_first',
    sender: { id: 'ou_original' }, message: { type: 'interactive', text: 'Investigate budget alert', raw: { title: 'Alert' } } }
  return { store, workspace, bot, identity, pack, sceneInput, scene, message }
}

describe('unified processing records', () => {
  it('shows CLI lifecycle, real runtime evidence and immutable route snapshots in the list and dashboard', async () => {
    const { store, bot, identity, scene, sceneInput, pack, message } = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execute: CodyBotRuntime['execute'] = async (_route, _message, _attachments, onProgress, onModel, onInvestigation, onThread) => {
      onModel?.({ model: 'actual-model', reasoningEffort: 'high', modelSource: 'bot', reasoningEffortSource: 'bot', fallback: false })
      onThread?.('native-thread')
      onInvestigation?.({ mode: 'package_first', primarySkills: [{ name: 'budget-oncall', description: 'Budget investigation', path: '/tmp/skills/budget-oncall/SKILL.md' }],
        candidateSkills: [], knowledgeResources: [], knowledgeRoots: [], codeRoot: '/tmp', tools: [{ kind: 'command', title: 'Query', summary: 'Read evidence', status: 'completed' }] })
      onProgress?.({ phase: 'answering', reasoning: '', answer: 'Still collecting evidence' })
      await gate
      return 'No online evidence; root cause unconfirmed'
    }
    const tasks = new HubTaskService(store, { execute } as never)
    tasks.beginDrain()
    const task = tasks.dispatchMessage(message, identity, 'credential')
    expect(store.getMessageLog(task.taskId)).toMatchObject({ origin: 'cli', taskId: task.taskId, taskStatus: 'queued',
      messageId: message.messageId, chatId: message.chatId, senderId: message.sender.id, routeSource: 'explicit', skillPackages: [{ id: pack.id, name: pack.name }] })
    expect(store.systemHealth().queue.queued).toBe(1)
    tasks.cancelDrain()
    try {
      await vi.waitFor(() => expect(store.getMessageLog(task.taskId)).toMatchObject({ taskStatus: 'running', responseContent: 'Still collecting evidence',
        model: 'actual-model', coreThreadId: 'native-thread', investigation: { primarySkills: [{ name: 'budget-oncall' }], tools: [{ title: 'Query' }] } }))
    } finally { release(); await tasks.waitForIdle() }
    store.updateScene(scene.id, { ...sceneInput, name: 'Renamed scene', skillPackageIds: [] })
    expect(store.getMessageLog(task.taskId)).toMatchObject({ status: 'completed', sceneName: scene.name, skillPackages: [{ id: pack.id, name: pack.name }], responseContent: 'No online evidence; root cause unconfirmed' })
    expect(store.getMessageLog(task.taskId).durationMs).toBeTypeOf('number')
    expect(store.listMessageAttempts(task.taskId)).toMatchObject([{ status: 'completed', model: 'actual-model' }])
    expect(tasks.dispatchMessage(message, identity, 'credential').taskId).toBe(task.taskId)
    expect(store.listMessageLogs({ origin: 'cli', query: task.taskId })).toMatchObject({ total: 1, items: [{ id: task.taskId }] })
    expect(store.stats({ origin: 'cli' }).analytics).toMatchObject({ total: { received: 1, completed: 1 }, scenes: [{ sceneId: scene.id, sceneName: scene.name, received: 1 }], capabilities: { skillPackageUses: 1, successfulToolCalls: 0 } })
    expect(store.stats({ origin: 'feishu' }).analytics.total.received).toBe(0)
    expect(store.stats({ origin: 'cli', chatId: message.chatId, threadChannelId: task.route.threadChannelId }).analytics.total.received).toBe(1)
    expect(store.stats({ fromDate: '2099-01-01', toDate: '2099-01-02' }).analytics.total.received).toBe(0)
    expect(store.dashboardDimensions().groups).toMatchObject([{ chatId: message.chatId, chatName: message.chatName }])
    expect(store.systemHealth().queue).toMatchObject({ queued: 0, processing: 0 })
  })

  it('projects pre-upgrade tasks without rewriting data or inventing historical skill usage', () => {
    const { store, bot, scene, message } = fixture()
    const cli = store.createHubTask({ origin: 'cli', kind: 'agent_turn', principal: 'old-identity', idempotencyKey: 'legacy-cli',
      botId: bot.id, sceneId: scene.id, taskInput: { message, route: { routeSource: 'explicit' } } })
    store.transitionHubTask(cli.id, { type: 'start' })
    store.transitionHubTask(cli.id, { type: 'complete', result: { text: 'Historical result' } })
    const mcp = store.createHubTask({ origin: 'mcp', kind: 'agent_turn', principal: 'mcp-client', idempotencyKey: 'legacy-mcp',
      botId: bot.id, sceneId: scene.id, taskInput: { prompt: 'Historical MCP request', sessionId: 'session' } })
    store.transitionHubTask(mcp.id, { type: 'fail', error: 'CLI launch failed' })
    const before = store.getHubTask(cli.id)
    expect(store.getMessageLog(cli.id)).toMatchObject({ taskId: cli.id, origin: 'cli', sceneName: scene.name, routeSource: 'explicit', auditAvailable: false, skillPackages: [], model: '', responseContent: 'Historical result' })
    expect(store.getMessageLog(mcp.id)).toMatchObject({ origin: 'mcp', status: 'failed', error: 'CLI launch failed', inboundContent: 'Historical MCP request' })
    expect(store.listMessageLogs({ status: 'failed', origin: 'mcp' }).total).toBe(1)
    expect(store.listMessageLogs({ query: 'Historical', limit: 1, offset: 1 })).toMatchObject({ total: 2, items: [expect.anything()] })
    expect(store.stats().analytics).toMatchObject({ total: { received: 2, completed: 1, failed: 1 }, capabilities: { skillPackageUses: 0 } })
    expect(store.getHubTask(cli.id)).toEqual(before)
    expect(() => store.retryMessageLog(mcp.id, { id: 'admin', loginName: 'admin', displayName: 'Admin' })).toThrow()
  })

  it('counts Feishu once, excludes discovery and other task kinds, and includes actual MCP execution', async () => {
    const { store, bot, scene } = fixture()
    const message = { provider: 'feishu' as const, accountId: bot.id, eventId: 'event', messageId: 'feishu-message',
      conversation: { id: 'oc_feishu', scope: 'group' as const }, sender: { id: 'ou_feishu', type: 'user' as const },
      content: { type: 'text' }, text: 'Feishu input', attachments: [], addressedToAgent: true, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString() }
    const route = store.resolveThreadRouting(store.resolveRoute(bot.id, message), message)
    store.acceptInboundMessage(bot.id, route, message)
    const tasks = new HubTaskService(store, { execute: async () => 'MCP answer' } as never)
    tasks.inspectPlatform({ requestId: 'inspect', principal: 'mcp' })
    const mcp = tasks.dispatchAgentTask({ botId: bot.id, sceneId: scene.id, prompt: 'MCP input', sessionId: 'session', requestId: 'mcp-request', principal: 'mcp' })
    await tasks.waitForIdle()
    expect(store.listMessageLogs().total).toBe(2)
    expect(store.getMessageLog(mcp.id)).toMatchObject({ origin: 'mcp', inboundContent: 'MCP input', responseContent: 'MCP answer' })
    expect(store.stats().analytics.total).toMatchObject({ received: 2, completed: 1, processing: 1 })
    expect(store.stats({ origin: 'mcp' }).analytics.total.received).toBe(1)
    expect(store.stats({ origin: 'feishu' }).analytics.total.received).toBe(1)
  })

  it('exposes task lookup and entry filters through the management API', async () => {
    const { store, bot, scene } = fixture()
    const tasks = new HubTaskService(store, { execute: async () => 'answer' } as never)
    const task = tasks.dispatchAgentTask({ botId: bot.id, sceneId: scene.id, prompt: 'MCP request', sessionId: 's', requestId: 'r', principal: 'p' })
    await tasks.waitForIdle()
    const payloads: unknown[] = []
    const response = { setHeader: vi.fn(), end: (body: string) => payloads.push(JSON.parse(body)) }
    for (const endpoint of [`/api/message-logs?origin=mcp&query=${task.id}`, `/api/message-logs/${task.id}`, '/api/dashboard?origin=cli']) {
      await handleInsightsRoute({ store, response, method: 'GET', url: new URL(endpoint, 'http://localhost') } as never)
    }
    expect(payloads[0]).toMatchObject({ total: 1, items: [{ taskId: task.id, origin: 'mcp' }] })
    expect(payloads[1]).toMatchObject({ taskId: task.id, responseContent: 'answer' })
    expect(payloads[2]).toMatchObject({ analytics: { total: { received: 0 } } })
    await expect(handleInsightsRoute({ store, response, method: 'POST', url: new URL(`/api/message-logs/${task.id}/retry`, 'http://localhost') } as never)).rejects.toMatchObject({ status: 400 })
  })
})
