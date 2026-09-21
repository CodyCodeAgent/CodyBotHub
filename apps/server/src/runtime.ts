import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { channelCommandId, type ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { createRuntimeAppServerHost, type AppServerHost } from '@codycodeagent/cody-web-core/runtime'
import { buildTurnUserInput, CodexSessionManager, type CodexModelOption, type CodexSkillOption, type DynamicToolProvider, type ExecutionContext, type ExecutionPolicyProvider, type ThreadBinding, type TurnInput, type TurnInputSkill, type TurnOutcome } from '@codycodeagent/cody-web-core/session'
import type { HubStore } from './db.js'
import { readSkillSearchTags, relevance, WorkspaceResourceIndex, type KnowledgeResource } from './resources.js'
import type { AgentRuntimeKind, InvestigationSkillRecord, InvestigationTraceRecord, InvestigationToolRecord, ModelConfigSource, ResolvedModelConfig, ResolvedRoute, ToolPackageRecord } from './types.js'

export type RuntimeAttachment = {
  path: string
  type: ChannelInboundMessage['attachments'][number]['type']
  name: string
  sizeBytes: number
}

export type RuntimeProgress = {
  phase: 'thinking' | 'answering'
  reasoning: string
  answer: string
}

export type RuntimeResolvedModel = {
  model: string
  reasoningEffort: string
  modelSource: ModelConfigSource
  reasoningEffortSource: ModelConfigSource
  fallback: boolean
}

export type RuntimeModelCatalog = {
  items: CodexModelOption[]
  defaultModel: string
  defaultReasoningEffort: string
}

export type RuntimeWorkspaceResources = {
  codeRoot: string
  knowledgeRoots: string[]
  knowledge: KnowledgeResource[]
  skills: CodexSkillOption[]
}

export type CopilotExecutionInput = {
  sessionId: string
  coreThreadId: string
  accountId: string
  workspaceId: string
  workspacePath: string
  workspaceName: string
  content: string
  platformContext: string
  onProgress?: (answer: string) => void
  onThreadResolved?: (threadId: string) => void
}

type RuntimeSkillPlan = {
  attached: TurnInputSkill[]
  instructions: string
  trace: InvestigationTraceRecord
  requiresDynamicTools: boolean
}

type EngineState = {
  kind: AgentRuntimeKind
  host: AppServerHost
  manager: CodexSessionManager
  attached: Set<string>
  attaching: Map<string, Promise<void>>
}

export const resolveRuntimeModel = (requested: ResolvedModelConfig, models: CodexModelOption[], configuredModel = '', configuredEffort = '', runtimeDefaultSource: ModelConfigSource = 'codex'): RuntimeResolvedModel => {
  const visible = models.filter(item => !item.hidden)
  const findModel = (value: string) => models.find(item => item.id === value || item.model === value)
  const accountDefault = findModel(configuredModel) ?? models.find(item => item.isDefault) ?? visible[0] ?? models[0]
  const selected = requested.model ? findModel(requested.model) : accountDefault
  let fallback = false
  let modelSource = requested.modelSource
  if (requested.model && !selected) {
    if (!requested.fallbackEnabled) throw new Error(`Model ${requested.model} is unavailable for the current Codex account`)
    fallback = true
    modelSource = runtimeDefaultSource
  }
  const actual = selected ?? accountDefault
  const model = actual?.id || actual?.model || requested.model || configuredModel
  let reasoningEffort = requested.reasoningEffort || configuredEffort || actual?.defaultReasoningEffort || ''
  let reasoningEffortSource: ModelConfigSource = requested.reasoningEffort ? requested.reasoningEffortSource : runtimeDefaultSource
  if (reasoningEffort && actual?.supportedReasoningEfforts.length && !actual.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort'])) {
    if (!requested.fallbackEnabled) throw new Error(`Reasoning effort ${reasoningEffort} is unsupported by model ${model}`)
    reasoningEffort = actual.defaultReasoningEffort || ''
    reasoningEffortSource = runtimeDefaultSource
    fallback = true
  }
  return { model, reasoningEffort, modelSource, reasoningEffortSource, fallback }
}

export const rankSkillCandidates = (skills: CodexSkillOption[], query: string, options: { tags?: Map<string, string[]>; boosts?: Array<{ keyword: string; weight: number }>; minimumScore?: number } = {}): CodexSkillOption[] => {
  const normalized = query.toLocaleLowerCase()
  const scored = skills.map(skill => {
    const searchable = `${skill.name} ${skill.displayName} ${skill.description} ${skill.path} ${(options.tags?.get(skill.path) ?? []).join(' ')}`
    const searchableNormalized = searchable.toLocaleLowerCase()
    let score = relevance(searchable, normalized)
    if (normalized.includes(skill.name.toLocaleLowerCase())) score += 30
    for (const boost of options.boosts ?? []) if (searchableNormalized.includes(boost.keyword.toLocaleLowerCase())) score += boost.weight
    const sourcePriority = skill.path.includes(`${path.sep}.codex${path.sep}skills${path.sep}`)
      ? 3
      : skill.path.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
        ? 2
        : 1
    return { skill, score, sourcePriority }
  })
  const ranked = scored
    .filter(item => item.score >= (options.minimumScore ?? 0))
    .sort((left, right) => right.score - left.score || right.sourcePriority - left.sourcePriority || left.skill.name.localeCompare(right.skill.name, 'zh-CN'))
  const unique = new Map<string, CodexSkillOption>()
  for (const item of ranked) {
    const key = item.skill.name.trim().toLocaleLowerCase()
    if (!unique.has(key)) unique.set(key, item.skill)
  }
  return [...unique.values()]
}

const skillSnapshot = (skill: CodexSkillOption): InvestigationSkillRecord => ({ name: skill.name, description: skill.description, path: skill.path })
const isWithin = (root: string, filename: string): boolean => {
  const relative = path.relative(root, filename)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export class CodyBotRuntime {
  private static readonly TOOL_CONTRACT_VERSION = 2
  private readonly engines = new Map<AgentRuntimeKind, EngineState>()
  private readonly resources = new WorkspaceResourceIndex()
  private readonly activeToolContexts = new Map<string, { sourceLogId: string; invocationAllowed: boolean }>()
  private readonly activeCopilotContexts = new Map<string, { sessionId: string; accountId: string; workspaceId: string }>()
  private toolInvoker: ((call: { callId: string; packageId: string; arguments: Record<string, unknown>; reason: string; sourceLogId: string }, binding: ThreadBinding) => Promise<Record<string, unknown>>) | null = null
  private copilotToolInvoker: ((call: { tool: string; arguments: Record<string, unknown>; sessionId: string; accountId: string; workspaceId: string }) => Promise<Record<string, unknown>>) | null = null

  constructor(
    private readonly store: HubStore,
    private readonly runtimeDirectory: string,
    private readonly commands: Partial<Record<AgentRuntimeKind, string>> = { codex: 'codex', traex: 'traex' },
    private readonly turnTimeoutMs = 15 * 60 * 1000,
  ) {}

  setToolPackageInvoker(invoker: (call: { callId: string; packageId: string; arguments: Record<string, unknown>; reason: string; sourceLogId: string }, binding: ThreadBinding) => Promise<Record<string, unknown>>): void {
    this.toolInvoker = invoker
  }

  setCopilotToolInvoker(invoker: (call: { tool: string; arguments: Record<string, unknown>; sessionId: string; accountId: string; workspaceId: string }) => Promise<Record<string, unknown>>): void {
    this.copilotToolInvoker = invoker
  }

  resetCopilotSession(sessionId: string): void {
    const bindingId = `copilot:${sessionId}`
    for (const engine of this.engines.values()) {
      if (engine.attached.has(bindingId)) engine.manager.detach(bindingId)
      engine.attached.delete(bindingId)
    }
    this.activeCopilotContexts.delete(bindingId)
  }

  async executeCopilot(input: CopilotExecutionInput): Promise<string> {
    const engine = await this.ensureEngine('codex'), manager = engine.manager, bindingId = `copilot:${input.sessionId}`
    const context = this.copilotContext(input)
    if (!engine.attached.has(bindingId)) {
      let threadId = input.coreThreadId
      if (input.coreThreadId) await manager.resume({ id: bindingId, threadId: input.coreThreadId }, context)
      else threadId = (await manager.create(bindingId, context)).threadId
      engine.attached.add(bindingId)
      if (threadId) input.onThreadResolved?.(threadId)
    } else manager.setContext(bindingId, context)
    const settings = this.store.getPlatformSettings()
    const model = await this.resolveModel(manager, { model: settings.defaultModel, reasoningEffort: settings.defaultReasoningEffort, modelSource: 'platform', reasoningEffortSource: 'platform', fallbackEnabled: settings.modelFallbackEnabled }, 'codex')
    let turnId = '', answer = ''
    const unsubscribe = manager.subscribe(event => {
      if (event.threadId !== (manager.snapshot(bindingId)?.threadId ?? input.coreThreadId) || (turnId && event.turnId && event.turnId !== turnId)) return
      const text = typeof event.data.text === 'string' ? event.data.text : ''
      if (event.type === 'assistant.delta' && text) answer += text
      if (event.type === 'assistant.completed' && text) answer = text
      if ((event.type === 'assistant.delta' || event.type === 'assistant.completed') && answer) input.onProgress?.(answer)
    })
    this.activeCopilotContexts.set(bindingId, { sessionId: input.sessionId, accountId: input.accountId, workspaceId: input.workspaceId })
    try {
      const submission = manager.submit(bindingId, {
        input: buildTurnUserInput({ text: input.content }), runtimeWorkspaceRoots: [realpathSync.native(input.workspacePath)], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
        ...(model.model ? { model: model.model } : {}), ...(model.reasoningEffort ? { effort: model.reasoningEffort as TurnInput['effort'] } : {}),
      }, 'queue', `copilot:${input.sessionId}:${Date.now()}`)
      turnId = (await submission.started).turnId
      const outcome = await this.waitForCompletion(manager, bindingId, submission.completed, 'codex')
      if (outcome.terminalEvent.type === 'turn.failed') throw new Error(String(outcome.terminalEvent.data.error || 'Copilot Turn failed'))
      return outcome.assistantText.trim() || answer.trim() || '任务已完成，但没有可显示的文本结果。'
    } finally {
      unsubscribe()
    }
  }

  async execute(route: ResolvedRoute, message: ChannelInboundMessage, attachments: RuntimeAttachment[] = [], onProgress?: (progress: RuntimeProgress) => void, onModelResolved?: (model: RuntimeResolvedModel) => void, onInvestigation?: (trace: InvestigationTraceRecord) => void, onThreadResolved?: (threadId: string) => void, sourceLogId = '', toolInvocationAllowed = true): Promise<string> {
    const channel = this.store.getThreadChannel(route.threadChannelId)
    if (channel.runtimeKind !== route.bot.runtimeKind) throw new Error(`Thread Channel runtime mismatch: ${channel.runtimeKind} != ${route.bot.runtimeKind}`)
    const engine = await this.ensureEngine(route.bot.runtimeKind)
    const manager = engine.manager
    const model = await this.resolveModel(manager, route.modelConfig, route.bot.runtimeKind)
    onModelResolved?.(model)
    const skillPlan = await this.resolveSkills(manager, route, message)
    onInvestigation?.(skillPlan.trace)
    const migrationContext = await this.ensureThreadChannel(engine, channel, route, skillPlan.instructions, skillPlan.requiresDynamicTools, sourceLogId)
    const activeThreadId = manager.snapshot(channel.id)?.threadId ?? channel.threadId
    if (activeThreadId) onThreadResolved?.(activeThreadId)
    const resourceInstructions = [skillPlan.instructions, migrationContext].filter(Boolean).join('\n\n')
    manager.setContext(channel.id, this.context(route, resourceInstructions))
    const localImages = attachments.filter(attachment => attachment.type === 'image').map(attachment => ({ path: attachment.path }))
    const turn: TurnInput = {
      input: buildTurnUserInput({
        text: this.messageText(message.text, attachments),
        ...(skillPlan.attached.length ? { skills: skillPlan.attached } : {}),
        ...(localImages.length ? { localImages } : {}),
      }),
      runtimeWorkspaceRoots: [realpathSync.native(route.workspace.path)],
      approvalPolicy: 'never',
      ...this.permissions(route),
      ...(model.model ? { model: model.model } : {}),
      ...(model.reasoningEffort ? { effort: model.reasoningEffort as TurnInput['effort'] } : {}),
    }
    let turnId = ''
    let reasoning = ''
    let answer = ''
    const toolTrace = new Map<string, InvestigationToolRecord>()
    const applyProgress = (event: CodexEvent): void => {
      if (event.threadId !== activeThreadId || (turnId && event.turnId && event.turnId !== turnId)) return
      const text = typeof event.data.text === 'string' ? event.data.text : ''
      if (event.type === 'reasoning.delta' && text) reasoning += text
      if (event.type === 'reasoning.break' && reasoning && !reasoning.endsWith('\n\n')) reasoning += '\n\n'
      if (event.type === 'assistant.delta' && text) answer += text
      if (event.type === 'assistant.completed' && text) answer = text
      if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') {
        const tool = event.data.tool && typeof event.data.tool === 'object' ? event.data.tool as Record<string, unknown> : null
        if (tool) {
          const item: InvestigationToolRecord = {
            kind: typeof tool.kind === 'string' ? tool.kind : 'tool',
            title: typeof tool.title === 'string' ? tool.title : '工具调用',
            summary: typeof tool.summary === 'string' ? tool.summary.slice(0, 2_000) : '',
            status: typeof tool.status === 'string' ? tool.status : event.type === 'tool.completed' ? 'completed' : 'running',
          }
          toolTrace.set(event.itemId || `${item.kind}:${item.summary}:${toolTrace.size}`, item)
          onInvestigation?.({ ...skillPlan.trace, tools: [...toolTrace.values()].slice(-100) })
        }
      }
      if ((event.type === 'reasoning.delta' || event.type === 'reasoning.break' || event.type === 'assistant.delta' || event.type === 'assistant.completed') && onProgress) {
        onProgress({ phase: answer ? 'answering' : 'thinking', reasoning, answer })
      }
    }
    const unsubscribe = manager.subscribe(applyProgress)
    if (sourceLogId) this.activeToolContexts.set(channel.id, { sourceLogId, invocationAllowed: toolInvocationAllowed })
    try {
      const submission = manager.submit(channel.id, turn, 'queue', channelCommandId(message))
      turnId = (await submission.started).turnId
      const outcome = await this.waitForCompletion(manager, channel.id, submission.completed, route.bot.runtimeKind)
      if (outcome.terminalEvent.type === 'turn.failed') throw new Error(String(outcome.terminalEvent.data.error || `${route.bot.runtimeKind === 'traex' ? 'TraeX' : 'Codex'} Turn failed`))
      return outcome.assistantText.trim() || answer.trim() || '任务已完成，但没有可显示的文本结果。'
    } finally {
      unsubscribe()
      if (this.activeToolContexts.get(channel.id)?.sourceLogId === sourceLogId) this.activeToolContexts.delete(channel.id)
    }
  }

  private waitForCompletion(manager: CodexSessionManager, bindingId: string, completed: Promise<TurnOutcome>, kind: AgentRuntimeKind): Promise<TurnOutcome> {
    const timeoutMs = Number.isFinite(this.turnTimeoutMs) && this.turnTimeoutMs > 0 ? this.turnTimeoutMs : 15 * 60 * 1000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void manager.interrupt(bindingId).catch(error => console.warn('[runtime] failed to interrupt timed out turn:', error))
        reject(new Error(`${kind === 'traex' ? 'TraeX' : 'Codex'} 执行超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已自动中断`))
      }, timeoutMs)
      timer.unref?.()
      void completed.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.engines.values()].map(async engine => {
      await engine.manager.dispose()
      await engine.host.dispose()
    }))
    this.engines.clear()
  }

  health(): { initialized: boolean; attachedChannels: number; engines: Array<{ kind: AgentRuntimeKind; label: string; initialized: boolean; attachedChannels: number; state: string; error: string }> } {
    const engines: AgentRuntimeKind[] = ['codex', 'traex']
    const rows = engines.map(kind => {
      const engine = this.engines.get(kind)
      const diagnostics = engine?.host.diagnostics()
      return { kind, label: kind === 'traex' ? 'TraeX' : 'Codex', initialized: Boolean(engine && diagnostics?.initialized), attachedChannels: engine?.attached.size ?? 0, state: diagnostics?.lifecycle ?? 'not_started', error: diagnostics?.unavailableReason ?? '' }
    })
    return { initialized: rows.some(item => item.initialized), attachedChannels: rows.reduce((sum, item) => sum + item.attachedChannels, 0), engines: rows }
  }

  async listSkills(workspacePath: string, kind: AgentRuntimeKind = 'codex'): Promise<CodexSkillOption[]> {
    const manager = (await this.ensureEngine(kind)).manager
    return manager.listSkills([realpathSync.native(workspacePath)], true)
  }

  async workspaceResources(workspacePath: string, query = '', kind: AgentRuntimeKind = 'codex'): Promise<RuntimeWorkspaceResources> {
    const codeRoot = realpathSync.native(workspacePath)
    const manager = (await this.ensureEngine(kind)).manager
    const [skills, knowledge, knowledgeRoots] = await Promise.all([
      manager.listSkills([codeRoot], true),
      this.resources.listKnowledge(codeRoot, query),
      this.resources.listRoots(codeRoot),
    ])
    return { codeRoot, skills, knowledge, knowledgeRoots }
  }

  async listModels(kind: AgentRuntimeKind = 'codex'): Promise<RuntimeModelCatalog> {
    const manager = (await this.ensureEngine(kind)).manager
    const [models, config] = await Promise.all([manager.listModels(), manager.readConfig()])
    const configuredModel = config.config.model ?? ''
    const selected = models.find(item => item.id === configuredModel || item.model === configuredModel) ?? models.find(item => item.isDefault) ?? models.find(item => !item.hidden) ?? models[0]
    const items = models.filter(item => !item.hidden || item === selected)
    return { items, defaultModel: selected?.id || selected?.model || configuredModel, defaultReasoningEffort: config.config.model_reasoning_effort ?? selected?.defaultReasoningEffort ?? '' }
  }

  async validateModelSelection(kind: AgentRuntimeKind, model: string, reasoningEffort: string): Promise<void> {
    if (!model && !reasoningEffort) return
    const catalog = await this.listModels(kind)
    const selected = model ? catalog.items.find(item => item.id === model || item.model === model) : undefined
    if (model && !selected) throw new Error(`Model ${model} is unavailable for the current Codex account`)
    if (reasoningEffort && selected?.supportedReasoningEfforts.length && !selected.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort'])) {
      throw new Error(`Reasoning effort ${reasoningEffort} is unsupported by model ${selected.id || selected.model}`)
    }
    if (reasoningEffort && !selected && !catalog.items.some(item => item.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort']))) throw new Error(`Reasoning effort ${reasoningEffort} is unavailable for the current Codex account`)
  }

  private async ensureEngine(kind: AgentRuntimeKind): Promise<EngineState> {
    const existing = this.engines.get(kind)
    if (existing) {
      await existing.host.ensureInitialized()
      return existing
    }
    const policy: ExecutionPolicyProvider = {
      evaluate: operation => /approval/iu.test(operation.method)
        ? ({ action: 'allow', reason: 'CodyBotHub YOLO mode automatically approves tool execution.' })
        : ({ action: 'deny', reason: 'CodyBotHub cannot answer interactive questions without a user response.' }),
    }
    const host = createRuntimeAppServerHost(kind, {
      command: this.commands[kind] || kind,
      cwd: this.runtimeDirectory,
      initializeParams: { clientInfo: { name: 'cody-bot-hub', title: 'CodyBotHub', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } },
    })
    const dynamicTools: DynamicToolProvider = { invoke: async (call, binding) => {
      const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {}
      if (call.namespace === 'codybothub_admin') {
        const active = this.activeCopilotContexts.get(binding.id)
        if (!active || !this.copilotToolInvoker) throw new Error('CodyBotHub admin Copilot context is unavailable')
        const result = await this.copilotToolInvoker({ tool: call.tool, arguments: args, ...active })
        return { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: true }
      }
      if (call.namespace !== 'codybothub' || call.tool !== 'invoke_tool_package') throw new Error(`Unknown CodyBotHub tool: ${call.namespace ?? ''}.${call.tool}`)
      if (!this.toolInvoker) throw new Error('CodyBotHub tool package service is unavailable')
      const packageId = typeof args.packageId === 'string' ? args.packageId : ''
      if (!packageId) throw new Error('packageId is required')
      const input = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {}
      const active = this.activeToolContexts.get(binding.id)
      const sourceLogId = active?.sourceLogId ?? ''
      if (!sourceLogId) throw new Error('Tool invocation is missing its source message context')
      if (!active?.invocationAllowed) throw new Error('Tool Package chaining is disabled while reporting a previous execution result')
      const result = await this.toolInvoker({ callId: call.callId, packageId, arguments: input, reason: typeof args.reason === 'string' ? args.reason : '', sourceLogId }, binding)
      return { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: result.status !== 'failed' }
    } }
    const manager = new CodexSessionManager({ host, policy, dynamicTools })
    const state: EngineState = { kind, host, manager, attached: new Set(), attaching: new Map() }
    this.engines.set(kind, state)
    try {
      await host.ensureInitialized()
      return state
    } catch (error) {
      throw new Error(`${kind === 'traex' ? 'TraeX' : 'Codex'} App Server 初始化失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async resolveModel(manager: CodexSessionManager, requested: ResolvedModelConfig, kind: AgentRuntimeKind): Promise<RuntimeResolvedModel> {
    const [models, config] = await Promise.all([manager.listModels(), manager.readConfig()])
    return resolveRuntimeModel(requested, models, config.config.model ?? '', config.config.model_reasoning_effort ?? '', kind === 'traex' ? 'runtime' : 'codex')
  }

  private async ensureThreadChannel(engine: EngineState, channel: { id: string; threadId: string; toolContractVersion: number }, route: ResolvedRoute, resourceInstructions: string, requiresDynamicTools: boolean, sourceLogId: string): Promise<string> {
    const manager = engine.manager
    const mustMigrate = Boolean(channel.threadId) && requiresDynamicTools && channel.toolContractVersion < CodyBotRuntime.TOOL_CONTRACT_VERSION
    if (engine.attached.has(channel.id) && !mustMigrate) return ''
    const pending = engine.attaching.get(channel.id)
    if (pending) { await pending; return '' }
    let migrationContext = ''
    const attach = (async (): Promise<void> => {
      if (mustMigrate) {
        migrationContext = this.store.threadChannelMigrationContext(channel.id, sourceLogId)
        if (engine.attached.has(channel.id)) manager.detach(channel.id)
        engine.attached.delete(channel.id)
        const migrationInstructions = migrationContext ? [resourceInstructions, [
          '## Thread 工具契约升级上下文',
          `原 Codex Thread ${channel.threadId} 创建于动态工具上线前，平台已自动切换到具备受控工具入口的新 Thread。`,
          '以下是同一 Thread Channel 最近已完成的用户消息与助手回复，仅用于延续当前对话事实。重新校验会变化的数据后再执行操作；不得把旧回复当作本轮已经执行成功。',
          migrationContext,
        ].join('\n\n')].filter(Boolean).join('\n\n') : resourceInstructions
        const binding = await manager.create(channel.id, this.context(route, migrationInstructions))
        this.store.setThreadChannelCoreThread(channel.id, binding.threadId, CodyBotRuntime.TOOL_CONTRACT_VERSION)
      } else if (channel.threadId) await manager.resume({ id: channel.id, threadId: channel.threadId }, this.context(route, resourceInstructions))
      else {
        const binding = await manager.create(channel.id, this.context(route, resourceInstructions))
        this.store.setThreadChannelCoreThread(channel.id, binding.threadId, CodyBotRuntime.TOOL_CONTRACT_VERSION)
      }
      engine.attached.add(channel.id)
    })().finally(() => engine.attaching.delete(channel.id))
    engine.attaching.set(channel.id, attach)
    await attach
    return migrationContext ? [
      '## Thread 工具契约升级上下文',
      `原 Codex Thread ${channel.threadId} 创建于动态工具上线前，平台已自动切换到具备受控工具入口的新 Thread。`,
      '以下是同一 Thread Channel 最近已完成的用户消息与助手回复，仅用于延续当前对话事实。重新校验会变化的数据后再执行操作；不得把旧回复当作本轮已经执行成功。',
      migrationContext,
    ].join('\n\n') : ''
  }

  private authorizedToolPackages(route: ResolvedRoute): ToolPackageRecord[] {
    return this.store.listToolPackages().filter(item => item.enabled
      && item.workspaceId === route.workspace.id
      && route.skillPackages.some(skillPackage => skillPackage.toolPackageIds.includes(item.id)))
  }

  private toolPackageContract(route: ResolvedRoute): string {
    const packages = this.authorizedToolPackages(route)
    if (!packages.length) return ''
    const rows = packages.map(item => [
      `- ${item.name}`,
      `  packageId: ${item.id}`,
      `  approval: ${item.approvalRequired ? 'required; invoking it creates a Feishu confirmation card and does not execute until an authorized user confirms' : 'not required'}`,
      item.description ? `  description: ${item.description}` : '',
      item.prompt ? `  policy: ${item.prompt}` : '',
    ].filter(Boolean).join('\n')).join('\n')
    return [
      '## CodyBotHub 受控业务操作契约',
      '下列工具包是本场景为对应业务动作提供的标准执行入口。需要执行已配置的业务动作时，应调用 `codybothub.invoke_tool_package`，并逐字使用列出的 UUID `packageId`。',
      '可以继续使用 shell、gdpa-cli、Bits RPC、HTTP、脚本和数据库查询搜集证据。工具包调用失败时，应根据返回的可用工具包修正调用；不得把失败的工具包申请描述成已经审批或执行成功。',
      rows,
    ].join('\n\n')
  }

  private context(route: ResolvedRoute, resourceInstructions = ''): ExecutionContext {
    const cwd = realpathSync.native(route.workspace.path)
    const toolContract = this.toolPackageContract(route)
    const developerInstructions = [route.turnInstructions, toolContract].filter(Boolean).join('\n\n')
    return {
      thread: {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        runtimeWorkspaceRoots: [cwd],
        baseInstructions: null,
        developerInstructions: developerInstructions || null,
        experimentalRawEvents: false,
        ephemeral: false,
        dynamicTools: [{
          type: 'namespace',
          name: 'codybothub',
          description: 'CodyBotHub 中由管理员注册、可审批、可审计的业务操作。',
          tools: [{
            type: 'function',
            name: 'invoke_tool_package',
            description: `在完成分析并有足够证据后，申请或执行当前技能包关联的工具包。需要审批时会发送飞书确认卡片。${toolContract ? ` 当前允许：${this.authorizedToolPackages(route).map(item => `${item.name}=${item.id}`).join('；')}` : ' 当前场景没有授权工具包。'}`,
            inputSchema: {
              type: 'object',
              properties: {
                packageId: { type: 'string', description: '工具包 ID，只能使用当前上下文列出的 ID' },
                arguments: { type: 'object', description: '工具包所需业务参数' },
                reason: { type: 'string', description: '执行原因、证据和预期影响' },
              },
              required: ['packageId', 'arguments', 'reason'], additionalProperties: false,
            },
          }],
        }],
      },
      turn: {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        summary: 'detailed',
        additionalContext: developerInstructions || resourceInstructions ? {
          'cody-bot-hub-route': { kind: 'application', value: [developerInstructions, resourceInstructions].filter(Boolean).join('\n\n') },
        } : null,
      },
    }
  }

  private copilotContext(input: CopilotExecutionInput): ExecutionContext {
    const cwd = realpathSync.native(input.workspacePath)
    const instructions = [
      '你是 CodyBotHub 平台管理员 Copilot。使用简洁中文帮助管理员查询平台、查找飞书人员和生成配置草稿。',
      '所有平台事实必须通过 codybothub_admin 工具查询，不要猜测 ID、配置或人员信息。',
      '你运行在只读沙箱中。不得直接编辑工作区、数据库或平台配置。需要创建托管脚本时，先完成脚本、参数和 Schema 设计，再调用 propose_managed_script 生成待确认草稿。需要调整 Bot 操作人时，先确认唯一人员 Open ID 和 Bot，再调用 propose_bot_operator。所有草稿只有管理员点击应用后才会生效。',
      '查找人员时调用 search_feishu_user；同名命中多条时列出姓名、企业邮箱、部门和 Open ID，让管理员自行确认。',
      '生成脚本时使用参数 argv，不把用户输入拼进 shell 命令；给出明确错误、超时和 JSON 输出。',
      `当前账号：${input.accountId}；当前工作区：${input.workspaceName}（${input.workspaceId}）。`,
      `平台概览：${input.platformContext}`,
    ].join('\n\n')
    return {
      thread: {
        cwd, approvalPolicy: 'never', sandbox: 'read-only', runtimeWorkspaceRoots: [cwd], baseInstructions: null, developerInstructions: instructions, experimentalRawEvents: false, ephemeral: false,
        dynamicTools: [{
          type: 'namespace', name: 'codybothub_admin', description: 'CodyBotHub 平台管理查询与可确认草稿工具。', tools: [
            { type: 'function', name: 'inspect_platform', description: '查询平台工作区、Bot、场景、技能包、工具和工具包。', inputSchema: { type: 'object', properties: { resource: { type: 'string', enum: ['all', 'workspaces', 'bots', 'scenes', 'skillPackages', 'tools', 'toolPackages'] }, query: { type: 'string' } }, additionalProperties: false } },
            { type: 'function', name: 'search_feishu_user', description: '按姓名或邮箱搜索飞书员工并返回 Open ID、邮箱和部门。', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
            { type: 'function', name: 'propose_managed_script', description: '创建平台托管脚本草稿。只生成待确认提案，不直接保存工具。', inputSchema: { type: 'object', properties: {
              name: { type: 'string' }, description: { type: 'string' }, language: { type: 'string', enum: ['python', 'shell', 'node'] }, scriptContent: { type: 'string' },
              argumentsTemplate: { type: 'array', items: { type: 'string' } }, inputSchema: { type: 'object' }, timeoutSeconds: { type: 'number' },
            }, required: ['name', 'description', 'language', 'scriptContent', 'argumentsTemplate', 'inputSchema'], additionalProperties: false } },
            { type: 'function', name: 'propose_bot_operator', description: '创建添加或移除 Bot 操作人的配置草稿。调用前必须已确认准确的 Bot ID 和人员 Open ID。', inputSchema: { type: 'object', properties: {
              botId: { type: 'string', description: 'inspect_platform 返回的 Bot ID' }, openId: { type: 'string', description: 'search_feishu_user 返回的 ou_ Open ID' }, personName: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove'] },
            }, required: ['botId', 'openId', 'action'], additionalProperties: false } },
          ],
        }],
      },
      turn: { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, summary: 'concise', additionalContext: { 'cody-bot-hub-admin': { kind: 'application', value: instructions } } },
    }
  }

  private permissions(_route: ResolvedRoute): Pick<TurnInput, 'sandboxPolicy'> {
    return { sandboxPolicy: { type: 'dangerFullAccess' } }
  }

  private async resolveSkills(manager: CodexSessionManager, route: ResolvedRoute, message: ChannelInboundMessage): Promise<RuntimeSkillPlan> {
    const codeRoot = realpathSync.native(route.workspace.path)
    const catalog = (await manager.listSkills([codeRoot], true)).filter(skill => skill.enabled)
    const requested = route.skillPackages.flatMap(item => item.skills)
    const primary = requested.flatMap(name => {
      const catalogItem = catalog.find(item => item.name === name || item.displayName === name || item.path === name || path.basename(path.dirname(item.path)) === name)
      if (catalogItem) return [catalogItem]
      const candidates = path.isAbsolute(name) ? [name] : [
        path.join(codeRoot, '.agents', 'skills', name, 'SKILL.md'),
        path.join(codeRoot, '.codex', 'skills', name, 'SKILL.md'),
        path.join(codeRoot, 'skills', name, 'SKILL.md'),
      ]
      const skillPath = candidates.find(existsSync)
      return skillPath ? [{ name: path.basename(path.dirname(skillPath)), displayName: name, description: '', path: skillPath, scope: 'repo' as const, enabled: true, brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [] }] : []
    })
    const uniquePrimary = [...new Map(primary.map(item => [item.path, item])).values()]
    const primaryPaths = new Set(uniquePrimary.map(item => item.path))
    const primaryNames = new Set(uniquePrimary.flatMap(item => [item.name, item.displayName, path.basename(path.dirname(item.path))]).filter(Boolean).map(item => item.trim().toLocaleLowerCase()))
    const mode: InvestigationTraceRecord['mode'] = route.skillPackages.some(item => item.fallbackMode === 'package_only')
      ? 'package_only'
      : route.skillPackages.some(item => item.fallbackMode === 'mixed')
        ? 'mixed'
        : requested.length ? 'package_first' : 'workspace'
    const query = [message.content?.title, message.text, route.scene?.name, route.scene?.prompt, ...route.skillPackages.flatMap(item => [item.name, item.description, item.prompt])].filter(Boolean).join('\n')
    const retrieval = route.scene?.retrieval ?? { skillBoosts: [], skillCandidateLimit: 12, knowledgeCandidateLimit: 12, minimumScore: 1 }
    const retrievalQuery = [query, ...retrieval.skillBoosts.map(item => item.keyword)].filter(Boolean).join('\n')
    const workspaceSkills = catalog.filter(skill => isWithin(codeRoot, skill.path)
      && !primaryPaths.has(skill.path)
      && ![skill.name, skill.displayName, path.basename(path.dirname(skill.path))].filter(Boolean).some(name => primaryNames.has(name.trim().toLocaleLowerCase())))
    const skillTags = new Map(await Promise.all(workspaceSkills.map(async skill => [skill.path, await readSkillSearchTags(skill.path)] as const)))
    const ranked = rankSkillCandidates(workspaceSkills, retrievalQuery, { tags: skillTags, boosts: retrieval.skillBoosts, minimumScore: retrieval.minimumScore }).slice(0, retrieval.skillCandidateLimit)
    const knowledge = mode === 'package_only' ? [] : await this.resources.listKnowledge(codeRoot, retrievalQuery, retrieval.knowledgeCandidateLimit, retrieval.minimumScore)
    const knowledgeRoots = mode === 'package_only' ? [] : await this.resources.listRoots(codeRoot)
    const primaryTrace = uniquePrimary.map(skillSnapshot)
    const candidateTrace = mode === 'package_only' ? [] : ranked.map(skillSnapshot)
    const trace: InvestigationTraceRecord = {
      mode, primarySkills: primaryTrace, candidateSkills: candidateTrace,
      knowledgeResources: knowledge.map(item => ({ title: item.title, path: item.path })), knowledgeRoots,
      codeRoot, tools: [],
    }
    const attachedCatalog = mode === 'mixed' || mode === 'workspace' || (mode === 'package_first' && uniquePrimary.length === 0) ? ranked.slice(0, 4) : []
    const attached = [...new Map([...uniquePrimary, ...attachedCatalog].map(item => [item.path, { name: item.name, path: item.path }])).values()]
    const missing = requested.filter(name => !uniquePrimary.some(skill => skill.name === name || skill.displayName === name || path.basename(path.dirname(skill.path)) === name))
    const skillLines = candidateTrace.map(item => `- ${item.name}：${item.description || '未提供描述'}\n  SKILL.md：${item.path}`).join('\n')
    const knowledgeLines = knowledge.map(item => `- ${item.title}：${item.path}${item.description ? `\n  ${item.description}` : ''}`).join('\n')
    const toolPackages = this.authorizedToolPackages(route)
    const toolPackageLines = toolPackages.map(item => [
      `- ${item.name}（packageId: ${item.id}）${item.approvalRequired ? '，需要人工确认' : '，可直接执行'}`,
      `  说明：${item.description || '未提供说明'}`,
      item.prompt ? `  使用规则：${item.prompt}` : '',
      `  步骤：${item.steps.map(step => `${step.phase}:${step.toolName}`).join(' → ') || '未配置'}`,
    ].filter(Boolean).join('\n')).join('\n')
    const policy = mode === 'package_only'
      ? '本轮为 package_only：只使用首选 Skill，不得读取或启用候选 Skill、知识库或其他工作区能力。'
      : mode === 'package_first'
        ? '先执行首选 Skill。若其中没有直接适用的 SOP、无法获得必要证据或明确表示不覆盖当前问题，必须从候选目录选择相关 Skill，读取对应 SKILL.md 后继续调查，不得因为没有现成 SOP 而停止。'
        : mode === 'mixed'
          ? '本轮为 mixed：应根据问题组合首选 Skill 与候选 Skill，不要求先后串行。'
          : '当前没有场景技能包。应从工作区候选 Skill、知识库和代码中选择完成任务所需的能力。'
    const instructions = [
      '# 工作区调查与能力发现', policy,
      missing.length ? `以下技能包 Skill 未在当前索引中找到：${missing.join('、')}。请从候选能力中寻找替代项。` : '',
      mode === 'package_only' ? '' : `## 候选 Skill\n以下是关键词召回结果，不代表全部适用。请先按当前任务语义选择必要的少量 Skill，再读取对应 SKILL.md。\n${skillLines || '当前没有达到相关度门槛的额外工作区 Skill。'}`,
      mode === 'package_only' ? '' : `## 知识资源\n知识根目录：${knowledgeRoots.join('、') || '未识别'}\n${knowledgeLines || '当前没有识别到知识文件；仍可在工作区内搜索 README、文档和 Skill references。'}`,
      mode === 'package_only' ? '' : `## 代码\n代码根目录：${codeRoot}\n允许使用 rg 搜索代码、配置和 Git 历史，以确认当前实现。`,
      mode === 'package_only' ? '' : '## 调查要求\n对告警、故障和数据差异任务，应提取关键 ID、时间、地区、服务和链接；交叉验证知识、代码、配置、数据库与日志；建立时间线并主动排除主要反例。没有实际查询证据时只能标记为“初判”。只有样本、规则或配置、运行事实和排除证据相互闭合时才可输出确定根因。遇到权限、工具或数据阻塞时，列出已经执行的查询和具体阻塞。',
      toolPackageLines ? `## 可执行工具包\n分析完成后，执行这里已经配置的业务动作时，应调用 codybothub.invoke_tool_package。必须使用这里列出的 packageId，并传入完整业务参数与可审计的执行理由。若返回 awaiting_approval，告诉用户审批卡片已发出，本轮不要假设动作已执行。通用接口、脚本和查询工具仍可用于搜集调查证据。\n${toolPackageLines}` : '',
    ].filter(Boolean).join('\n\n')
    return { attached, instructions, trace, requiresDynamicTools: toolPackages.length > 0 }
  }

  private messageText(text: string, attachments: RuntimeAttachment[]): string {
    const files = attachments.filter(attachment => attachment.type !== 'image')
    if (!files.length) return text
    const manifest = files.map(attachment => [
      `- ${attachment.type}：${attachment.name}`,
      `  本地路径：${attachment.path}`,
      `  大小：${attachment.sizeBytes} 字节`,
    ].join('\n')).join('\n')
    return [text, `以下飞书附件已经下载到本机。需要读取内容时，请直接读取列出的本地路径：\n${manifest}`].filter(Boolean).join('\n\n')
  }
}
