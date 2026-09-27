import { randomUUID } from 'node:crypto'
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

export class HubTaskService {
  private readonly channelQueues = new Map<string, Promise<void>>()
  private readonly scheduled = new Set<string>()
  private readonly events = new TaskEventBus<HubTaskRecord>()
  private draining = false

  constructor(private readonly store: HubStore, private readonly runtime: CodyBotRuntime) {}

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
    for (const task of this.store.listHubTasks({ status: 'queued', origin: 'mcp', limit: 500 })) {
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
    return { draining: this.draining, activeTasks: this.scheduled.size, queuedTasks: this.store.listHubTasks({ status: 'queued', origin: 'mcp', limit: 500 }).length }
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
      const text = await this.runtime.execute(route, message, [], onProgress, undefined, undefined, undefined, '', false, 'read_only')
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
      turnInstructions: [route.turnInstructions, '# MCP 只读任务\n本轮可读取工作区、知识库和查询型能力，但不得修改文件、配置或外部系统；不得调用 Tool Package。需要产生副作用时，请说明应转到飞书审批流程。'].filter(Boolean).join('\n\n'),
    }
  }
}

export const newTaskRequestId = (): string => randomUUID()
