import { createHash, randomUUID } from 'node:crypto'
import type { InteractionIdentity, InteractionSceneCatalog, InteractionTask } from '@cody-bot-hub/contracts/interaction'
import { hasSceneMatcher } from './scene-matching.js'
import { groupMessageInput, type ParsedGroupMessageInput } from './interaction-input.js'
import { HttpError } from './http/common.js'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { TaskEventBus, taskIsTerminal, type TaskEvent } from '@codycodeagent/cody-web-core/task'
import type { HubStore } from './db.js'
import type { CodyBotRuntime, RuntimeProgress } from './runtime.js'
import type { HubTaskProgress, HubTaskRecord, HubTaskResult, ResolvedRoute } from './types.js'

type AgentTaskInput = {
  botId: string
  sceneId?: string
  prompt: string
  sessionId: string
  requestId: string
  principal: string
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const requestKey = (principal: string, requestId: string): string => JSON.stringify([principal, requestId])
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export class HubTaskService {
  private readonly channelQueues = new Map<string, Promise<void>>()
  private readonly scheduled = new Set<string>()
  private readonly events = new TaskEventBus<HubTaskRecord>()
  private draining = false

  constructor(private readonly store: HubStore, private readonly runtime: CodyBotRuntime) {}

  sceneCatalog(identity: InteractionIdentity, botId?: string): InteractionSceneCatalog {
    if (botId && !identity.allowedBotIds.includes(botId)) throw new HttpError(403, 'Bot is not allowed for this identity')
    const bots = new Map(this.store.listBots().filter(bot => identity.allowedBotIds.includes(bot.id)).map(bot => [bot.id, bot]))
    return {
      matchSemantics: { acrossFields: 'AND', withinField: 'OR', emptyField: 'unrestricted', textMatch: 'case_insensitive_substring', idMatch: 'exact', priority: 'ascending' },
      scenes: this.store.listScenes().filter(scene => scene.enabled && bots.has(scene.botId) && (!botId || scene.botId === botId)).map(scene => ({
        sceneId: scene.id, botId: scene.botId, botName: bots.get(scene.botId)!.name,
        name: scene.name, description: scene.description, priority: scene.priority, isFallback: !hasSceneMatcher(scene.matcher),
        conversationMode: bots.get(scene.botId)!.conversationMode, executionMode: 'read_only', matcher: scene.matcher,
      })),
    }
  }

  private selectedScene(sceneId: string, identity: InteractionIdentity, botId?: string) {
    const scene = this.store.listScenes().find(item => item.id === sceneId && item.enabled && identity.allowedBotIds.includes(item.botId))
    if (!scene) throw new HttpError(404, 'Scene not found, disabled, or not allowed for this identity')
    if (botId && botId !== scene.botId) throw new HttpError(400, 'Scene does not belong to the requested Bot')
    return scene
  }

  dispatchMessage(value: unknown, identity: InteractionIdentity, credentialId: string): InteractionTask {
    const input = groupMessageInput.parse(value)
    const selected = input.sceneId ? this.selectedScene(input.sceneId, identity, input.botId) : undefined
    const botId = selected?.botId ?? input.botId ?? identity.defaultBotId
    if (!identity.allowedBotIds.includes(botId)) throw new HttpError(403, 'Bot is not allowed for this identity')
    const { eventId: _deliveryId, ...stableInput } = input
    const fingerprint = createHash('sha256').update(canonical({ ...stableInput, botId })).digest('hex')
    const idempotencyKey = JSON.stringify([identity.id, botId, input.messageId])
    const existing = this.store.findHubTask('cli', idempotencyKey)
    if (existing) {
      if (existing.input.fingerprint !== fingerprint) throw new HttpError(409, 'Message ID was already submitted with different content')
      return this.interactionSnapshot(existing)
    }
    if (JSON.stringify(input).length > 800_000) throw new HttpError(413, 'Message payload is too large')
    const message = this.groupMessage(input, botId)
    const route = this.groupRoute(input, botId, identity.id, message)
    const task = this.store.createHubTask({
      kind: 'agent_turn', origin: 'cli', principal: identity.id, idempotencyKey,
      taskInput: { message: input, fingerprint, credentialId, route: { workspaceId: route.workspace.id, routeSource: route.routeSource } },
      botId, sceneId: route.scene?.id ?? '', threadChannelId: route.threadChannelId,
      sourceKind: 'cli_message', sourceId: input.messageId,
    })
    this.store.createAuditLog({ action: 'interaction.submit', targetType: 'task', targetId: task.id,
      summary: `${identity.name} 提交群消息任务`, details: { identityId: identity.id, credentialId, botId, chatId: input.chatId, messageId: input.messageId, sender: input.sender } })
    if (!this.draining) this.schedule(task, route, message)
    return this.interactionSnapshot(task)
  }

  getInteraction(taskId: string, identityId: string): InteractionTask {
    return this.interactionSnapshot(this.ownedInteraction(taskId, identityId))
  }

  async waitInteraction(taskId: string, identityId: string, timeoutMs: number): Promise<InteractionTask> {
    const task = await this.events.waitFor(taskId, () => this.ownedInteraction(taskId, identityId),
      snapshot => taskIsTerminal(snapshot.status), Math.min(25_000, Math.max(0, timeoutMs)))
    return this.interactionSnapshot(task)
  }

  private ownedInteraction(taskId: string, identityId: string): HubTaskRecord {
    const task = this.store.getHubTask(taskId)
    if (task.origin !== 'cli' || task.principal !== identityId) throw new HttpError(404, 'Task not found')
    return task
  }

  private interactionSnapshot(task: HubTaskRecord): InteractionTask {
    const route = task.input.route as { workspaceId: string; routeSource: string }
    return {
      taskId: task.id, status: task.status, answer: task.result?.text ?? null, error: task.error, progress: task.progress,
      route: { botId: task.botId, sceneId: task.sceneId, workspaceId: route.workspaceId, routeSource: route.routeSource, threadChannelId: task.threadChannelId },
      createdAt: task.createdAtIso, updatedAt: task.updatedAtIso,
    }
  }

  private groupMessage(input: ParsedGroupMessageInput, botId: string): ChannelInboundMessage {
    return {
      provider: 'cli', accountId: botId, eventId: input.eventId ?? input.messageId, messageId: input.messageId,
      conversation: { id: input.chatId, scope: input.topicId ? 'topic' : 'group', ...(input.topicId ? { rootId: input.topicId } : {}), ...(input.chatName ? { name: input.chatName } : {}) },
      sender: { id: input.sender.id, type: input.sender.type ?? 'user', ...(input.sender.name ? { name: input.sender.name } : {}), ...(input.sender.idType ? { idType: input.sender.idType } : {}) },
      content: { type: input.message.type ?? 'text', ...(input.message.title !== undefined ? { title: input.message.title } : {}), raw: input.message.raw },
      text: input.message.text, attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: Boolean(input.mentions?.some(mention => !mention.isCurrentBot)),
      mentions: (input.mentions ?? []).map(mention => ({ id: mention.id, idType: 'unknown', type: mention.type ?? 'user', name: mention.name ?? '', isAgent: mention.isCurrentBot ?? false })),
      createdAtIso: input.createdAt ?? new Date().toISOString(),
    }
  }

  private groupRoute(input: ParsedGroupMessageInput, botId: string, identityId: string, message: ChannelInboundMessage, fixedChannelId?: string): ResolvedRoute {
    const scopedChatId = `cli:${JSON.stringify([identityId, input.chatId])}`
    const base = this.store.resolveRoute(botId, message, { contextChatId: scopedChatId, ...(input.sceneId ? { sceneId: input.sceneId } : {}) })
    // Match on the real chat ID, but keep CLI histories separate from Feishu and other identities.
    const scoped = { ...base, conversationKey: JSON.stringify(['cli', identityId, botId, input.chatId, base.topicId]) }
    // The binding table also has a unique Bot/chat/topic constraint; scope its stored chat ID too.
    const bindingMessage = { ...message, conversation: { ...message.conversation, id: scopedChatId } }
    const route = fixedChannelId ? { ...scoped, threadChannelId: fixedChannelId } : this.store.resolveThreadRouting(scoped, bindingMessage, { allowProfileReuse: false })
    if (!fixedChannelId && route.scene && ['matcher', 'explicit'].includes(route.routeSource) && route.topicId) {
      this.store.rememberTopicRoute(botId, scopedChatId, route.topicId, route.scene.id)
    }
    return this.readOnlyRoute(route)
  }

  inspectPlatform(input: { requestId: string; principal: string }): HubTaskRecord {
    const idempotencyKey = requestKey(input.principal, input.requestId)
    const existing = this.store.findHubTask('mcp', idempotencyKey)
    if (existing) return existing
    const task = this.store.createHubTask({
      kind: 'inspect_platform', origin: 'mcp', principal: input.principal, idempotencyKey, taskInput: { requestId: input.requestId }, sourceKind: 'mcp_request', sourceId: input.requestId,
    })
    const running = this.transition(task.id, { type: 'start' })
    const skillPackages = this.store.listSkillPackages()
    return this.transition(running.id, {
      type: 'complete',
      result: {
        data: {
          bots: this.store.listBots().map(bot => ({ id: bot.id, name: bot.name, description: bot.description, runtimeKind: bot.runtimeKind })),
          scenes: this.store.listScenes().filter(scene => scene.enabled).map(scene => ({ id: scene.id, botId: scene.botId, name: scene.name, skillPackageIds: scene.skillPackageIds })),
          skillPackages: skillPackages.map(item => ({ id: item.id, name: item.name, description: item.description, skills: item.skills })),
          taskKinds: ['inspect_platform', 'agent_turn'],
          agentTaskPolicy: 'read_only',
          sideEffectTools: 'Use the Feishu approval flow; MCP agent tasks do not invoke Tool Packages.',
        },
      },
    })
  }

  dispatchAgentTask(input: AgentTaskInput): HubTaskRecord {
    const idempotencyKey = requestKey(input.principal, input.requestId)
    const existing = this.store.findHubTask('mcp', idempotencyKey)
    if (existing) return existing
    if (!this.store.listBots().some(bot => bot.id === input.botId)) throw new Error('Bot not found')
    const message = this.message(input)
    const route = this.readOnlyRoute(this.store.resolveThreadRouting(this.store.resolveRoute(input.botId, message, input.sceneId ? { sceneId: input.sceneId } : {}), message, { allowProfileReuse: false }))
    const task = this.store.createHubTask({
      kind: 'agent_turn', origin: 'mcp', principal: input.principal, idempotencyKey,
      taskInput: { botId: input.botId, ...(input.sceneId ? { sceneId: input.sceneId } : {}), prompt: input.prompt, sessionId: input.sessionId, requestId: input.requestId },
      botId: input.botId, sceneId: route.scene?.id ?? '', threadChannelId: route.threadChannelId, sourceKind: 'mcp_request', sourceId: input.requestId,
    })
    if (!this.draining) this.schedule(task, route, message)
    return task
  }

  get(taskId: string, principal?: string): HubTaskRecord {
    const task = this.store.getHubTask(taskId)
    if (principal && (task.origin !== 'mcp' || task.principal !== principal)) throw new Error('Task not found')
    return task
  }

  async wait(taskId: string, timeoutMs = 25_000, principal?: string): Promise<HubTaskRecord> {
    return this.events.waitFor(
      taskId,
      () => this.get(taskId, principal),
      task => taskIsTerminal(task.status),
      Math.min(25_000, Math.max(0, timeoutMs)),
    )
  }

  resumeQueuedTasks(): void {
    if (this.draining) return
    for (const task of this.store.listHubTasks({ status: 'queued', origin: 'cli', limit: 500 })) {
      if (this.scheduled.has(task.id)) continue
      try {
        const identity = this.store.identities.get(task.principal)
        if (!identity.enabled || !identity.allowedBotIds.includes(task.botId)) throw new Error('Identity disabled or Bot permission removed')
        const input = groupMessageInput.parse(task.input.message), message = this.groupMessage(input, task.botId)
        if (input.sceneId) this.selectedScene(input.sceneId, identity, task.botId)
        this.schedule(task, this.groupRoute(input, task.botId, task.principal, message, task.threadChannelId), message)
      } catch (error) {
        this.transition(task.id, { type: 'fail', error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const task of this.store.listHubTasks({ status: 'queued', origin: 'mcp', limit: 500 })) {
      if (this.scheduled.has(task.id)) continue
      const input = task.input
      if (typeof input.botId !== 'string' || typeof input.prompt !== 'string' || typeof input.sessionId !== 'string' || typeof input.requestId !== 'string' || (input.sceneId !== undefined && typeof input.sceneId !== 'string')) {
        this.transition(task.id, { type: 'fail', error: 'Queued task payload is invalid' })
        continue
      }
      const request: AgentTaskInput = { botId: input.botId, ...(typeof input.sceneId === 'string' ? { sceneId: input.sceneId } : {}), prompt: input.prompt, sessionId: input.sessionId, requestId: input.requestId, principal: task.principal }
      try {
        const message = this.message(request)
        const route = this.readOnlyRoute(this.store.resolveThreadRouting(this.store.resolveRoute(request.botId, message, request.sceneId ? { sceneId: request.sceneId } : {}), message, { allowProfileReuse: false }))
        this.schedule(task, route, message)
      } catch (error) {
        this.transition(task.id, { type: 'fail', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  beginDrain(): void { this.draining = true }

  cancelDrain(): void {
    this.draining = false
    this.resumeQueuedTasks()
  }

  async waitForIdle(): Promise<void> {
    while (this.scheduled.size > 0) await sleep(100)
  }

  health(): { draining: boolean; activeTasks: number; queuedTasks: number } {
    return { draining: this.draining, activeTasks: this.scheduled.size, queuedTasks: ['mcp', 'cli'].reduce((count, origin) => count + this.store.listHubTasks({ status: 'queued', origin, limit: 500 }).length, 0) }
  }

  private schedule(task: HubTaskRecord, route: ResolvedRoute, message: ChannelInboundMessage): void {
    if (this.draining) return
    if (this.scheduled.has(task.id)) return
    this.scheduled.add(task.id)
    const previous = this.channelQueues.get(route.threadChannelId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.run(task.id, route, message))
    this.channelQueues.set(route.threadChannelId, current)
    const cleanup = () => {
      this.scheduled.delete(task.id)
      if (this.channelQueues.get(route.threadChannelId) === current) this.channelQueues.delete(route.threadChannelId)
    }
    void current.then(cleanup, cleanup)
  }

  private async run(taskId: string, route: ResolvedRoute, message: ChannelInboundMessage): Promise<void> {
    const current = this.store.getHubTask(taskId)
    if (current.status !== 'queued') return
    this.transition(taskId, { type: 'start' })
    let lastProgressAt = 0
    const onProgress = (progress: RuntimeProgress) => {
      if (Date.now() - lastProgressAt < 1_000) return
      lastProgressAt = Date.now()
      try { this.transition(taskId, { type: 'progress', progress: { phase: progress.phase, answer: progress.answer.slice(-50_000) } }) }
      catch (error) { console.warn(`[tasks] failed to persist progress for ${taskId}:`, error) }
    }
    try {
      if (current.origin === 'cli') {
        const identity = this.store.identities.get(current.principal)
        if (!identity.enabled || !identity.allowedBotIds.includes(current.botId)) throw new Error('Identity disabled or Bot permission removed')
        const input = groupMessageInput.parse(current.input.message)
        if (input.sceneId) this.selectedScene(input.sceneId, identity, current.botId)
      }
      // Only user input carries caller-supplied metadata; it must never become trusted application instructions.
      const runtimeMessage = current.origin === 'cli'
        ? { ...message, text: `消息上下文（调用方提供）：\n${JSON.stringify(current.input.message)}\n\n消息正文：\n${message.text}` }
        : message
      const text = await this.runtime.execute(route, runtimeMessage, [], onProgress, undefined, undefined, undefined, '', false, 'read_only')
      this.transition(taskId, { type: 'complete', result: { text } })
    } catch (error) {
      this.transition(taskId, { type: 'fail', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private transition(taskId: string, event: TaskEvent<HubTaskProgress, HubTaskResult>): HubTaskRecord {
    const task = this.store.transitionHubTask(taskId, event)
    this.events.publish(task)
    return task
  }

  private message(input: AgentTaskInput): ChannelInboundMessage {
    const createdAtIso = new Date().toISOString()
    return {
      provider: 'mcp', accountId: input.botId, eventId: input.requestId, messageId: input.requestId,
      conversation: { id: `mcp:${JSON.stringify([input.principal, input.sessionId, input.sceneId ?? 'auto'])}`, scope: 'private' },
      sender: { id: input.principal, type: 'app', name: 'MCP client' }, content: { type: 'text' }, text: input.prompt,
      attachments: [], addressedToAgent: true, mentionsOtherRecipient: false, createdAtIso,
    }
  }

  private readOnlyRoute(route: ResolvedRoute): ResolvedRoute {
    return {
      ...route,
      skillPackages: route.skillPackages.map(item => ({ ...item, toolPackageIds: [] })),
      turnInstructions: [route.turnInstructions, '# MCP 只读任务 / CLI 只读任务\n本轮可读取工作区、知识库和查询型能力，但不得修改文件、配置或外部系统；不得调用 Tool Package。需要产生副作用时，请说明应转到飞书审批流程。'].filter(Boolean).join('\n\n'),
    }
  }
}

export const newTaskRequestId = (): string => randomUUID()
