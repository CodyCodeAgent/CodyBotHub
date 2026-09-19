import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { channelCommandId, type ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { createAppServerHost, type AppServerHost } from '@codycodeagent/cody-web-core/runtime'
import { buildTurnUserInput, CodexSessionManager, type CodexModelOption, type CodexSkillOption, type ExecutionContext, type ExecutionPolicyProvider, type TurnInput, type TurnInputSkill, type TurnOutcome } from '@codycodeagent/cody-web-core/session'
import type { HubStore } from './db.js'
import { readSkillSearchTags, relevance, WorkspaceResourceIndex, type KnowledgeResource } from './resources.js'
import type { InvestigationSkillRecord, InvestigationTraceRecord, InvestigationToolRecord, ModelConfigSource, ResolvedModelConfig, ResolvedRoute } from './types.js'

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

type RuntimeSkillPlan = {
  attached: TurnInputSkill[]
  instructions: string
  trace: InvestigationTraceRecord
}

export const resolveRuntimeModel = (requested: ResolvedModelConfig, models: CodexModelOption[], configuredModel = '', configuredEffort = ''): RuntimeResolvedModel => {
  const visible = models.filter(item => !item.hidden)
  const findModel = (value: string) => models.find(item => item.id === value || item.model === value)
  const accountDefault = findModel(configuredModel) ?? models.find(item => item.isDefault) ?? visible[0] ?? models[0]
  const selected = requested.model ? findModel(requested.model) : accountDefault
  let fallback = false
  let modelSource = requested.modelSource
  if (requested.model && !selected) {
    if (!requested.fallbackEnabled) throw new Error(`Model ${requested.model} is unavailable for the current Codex account`)
    fallback = true
    modelSource = 'codex'
  }
  const actual = selected ?? accountDefault
  const model = actual?.id || actual?.model || requested.model || configuredModel
  let reasoningEffort = requested.reasoningEffort || configuredEffort || actual?.defaultReasoningEffort || ''
  let reasoningEffortSource = requested.reasoningEffort ? requested.reasoningEffortSource : 'codex'
  if (reasoningEffort && actual?.supportedReasoningEfforts.length && !actual.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort'])) {
    if (!requested.fallbackEnabled) throw new Error(`Reasoning effort ${reasoningEffort} is unsupported by model ${model}`)
    reasoningEffort = actual.defaultReasoningEffort || ''
    reasoningEffortSource = 'codex'
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
  private host: AppServerHost | null = null
  private manager: CodexSessionManager | null = null
  private readonly attached = new Set<string>()
  private readonly attaching = new Map<string, Promise<void>>()
  private readonly resources = new WorkspaceResourceIndex()

  constructor(
    private readonly store: HubStore,
    private readonly runtimeDirectory: string,
    private readonly codexCommand = 'codex',
    private readonly turnTimeoutMs = 15 * 60 * 1000,
  ) {}

  async execute(route: ResolvedRoute, message: ChannelInboundMessage, attachments: RuntimeAttachment[] = [], onProgress?: (progress: RuntimeProgress) => void, onModelResolved?: (model: RuntimeResolvedModel) => void, onInvestigation?: (trace: InvestigationTraceRecord) => void, onThreadResolved?: (threadId: string) => void): Promise<string> {
    const channel = this.store.getThreadChannel(route.threadChannelId)
    const manager = await this.ensureManager()
    const model = await this.resolveModel(manager, route.modelConfig)
    onModelResolved?.(model)
    const skillPlan = await this.resolveSkills(manager, route, message)
    onInvestigation?.(skillPlan.trace)
    await this.ensureThreadChannel(manager, channel, route, skillPlan.instructions)
    const activeThreadId = manager.snapshot(channel.id)?.threadId ?? channel.threadId
    if (activeThreadId) onThreadResolved?.(activeThreadId)
    manager.setContext(channel.id, this.context(route, skillPlan.instructions))
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
    try {
      const submission = manager.submit(channel.id, turn, 'queue', channelCommandId(message))
      turnId = (await submission.started).turnId
      const outcome = await this.waitForCompletion(manager, channel.id, submission.completed)
      if (outcome.terminalEvent.type === 'turn.failed') throw new Error(String(outcome.terminalEvent.data.error || 'Codex Turn failed'))
      return outcome.assistantText.trim() || answer.trim() || '任务已完成，但没有可显示的文本结果。'
    } finally {
      unsubscribe()
    }
  }

  private waitForCompletion(manager: CodexSessionManager, bindingId: string, completed: Promise<TurnOutcome>): Promise<TurnOutcome> {
    const timeoutMs = Number.isFinite(this.turnTimeoutMs) && this.turnTimeoutMs > 0 ? this.turnTimeoutMs : 15 * 60 * 1000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void manager.interrupt(bindingId).catch(error => console.warn('[runtime] failed to interrupt timed out turn:', error))
        reject(new Error(`Codex 执行超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已自动中断`))
      }, timeoutMs)
      timer.unref?.()
      void completed.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  async dispose(): Promise<void> {
    await this.manager?.dispose()
    await this.host?.dispose()
    this.manager = null
    this.host = null
    this.attached.clear()
  }

  health(): { initialized: boolean; attachedChannels: number } {
    return { initialized: Boolean(this.manager && this.host), attachedChannels: this.attached.size }
  }

  async listSkills(workspacePath: string): Promise<CodexSkillOption[]> {
    const manager = await this.ensureManager()
    return manager.listSkills([realpathSync.native(workspacePath)], true)
  }

  async workspaceResources(workspacePath: string, query = ''): Promise<RuntimeWorkspaceResources> {
    const codeRoot = realpathSync.native(workspacePath)
    const manager = await this.ensureManager()
    const [skills, knowledge, knowledgeRoots] = await Promise.all([
      manager.listSkills([codeRoot], true),
      this.resources.listKnowledge(codeRoot, query),
      this.resources.listRoots(codeRoot),
    ])
    return { codeRoot, skills, knowledge, knowledgeRoots }
  }

  async listModels(): Promise<RuntimeModelCatalog> {
    const manager = await this.ensureManager()
    const [models, config] = await Promise.all([manager.listModels(), manager.readConfig()])
    const configuredModel = config.config.model ?? ''
    const selected = models.find(item => item.id === configuredModel || item.model === configuredModel) ?? models.find(item => item.isDefault) ?? models.find(item => !item.hidden) ?? models[0]
    const items = models.filter(item => !item.hidden || item === selected)
    return { items, defaultModel: selected?.id || selected?.model || configuredModel, defaultReasoningEffort: config.config.model_reasoning_effort ?? selected?.defaultReasoningEffort ?? '' }
  }

  async validateModelSelection(model: string, reasoningEffort: string): Promise<void> {
    const catalog = await this.listModels()
    const selected = model ? catalog.items.find(item => item.id === model || item.model === model) : undefined
    if (model && !selected) throw new Error(`Model ${model} is unavailable for the current Codex account`)
    if (reasoningEffort && selected?.supportedReasoningEfforts.length && !selected.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort'])) {
      throw new Error(`Reasoning effort ${reasoningEffort} is unsupported by model ${selected.id || selected.model}`)
    }
    if (reasoningEffort && !selected && !catalog.items.some(item => item.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort']))) throw new Error(`Reasoning effort ${reasoningEffort} is unavailable for the current Codex account`)
  }

  private async ensureManager(): Promise<CodexSessionManager> {
    if (this.manager) return this.manager
    const policy: ExecutionPolicyProvider = {
      evaluate: operation => /approval/iu.test(operation.method)
        ? ({ action: 'allow', reason: 'CodyBotHub YOLO mode automatically approves tool execution.' })
        : ({ action: 'deny', reason: 'CodyBotHub cannot answer interactive questions without a user response.' }),
    }
    this.host = createAppServerHost({
      command: /(?:^|\s)app-server(?:\s|$)/u.test(this.codexCommand) ? this.codexCommand : `"${this.codexCommand}" app-server --stdio`,
      cwd: this.runtimeDirectory,
      initializeParams: { clientInfo: { name: 'cody-bot-hub', title: 'CodyBotHub', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } },
    })
    this.manager = new CodexSessionManager({ host: this.host, policy })
    await this.host.ensureInitialized()
    return this.manager
  }

  private async resolveModel(manager: CodexSessionManager, requested: ResolvedModelConfig): Promise<RuntimeResolvedModel> {
    const [models, config] = await Promise.all([manager.listModels(), manager.readConfig()])
    return resolveRuntimeModel(requested, models, config.config.model ?? '', config.config.model_reasoning_effort ?? '')
  }

  private async ensureThreadChannel(manager: CodexSessionManager, channel: { id: string; threadId: string }, route: ResolvedRoute, resourceInstructions: string): Promise<void> {
    if (this.attached.has(channel.id)) return
    const pending = this.attaching.get(channel.id)
    if (pending) return pending
    const attach = (async () => {
      if (channel.threadId) await manager.resume({ id: channel.id, threadId: channel.threadId }, this.context(route, resourceInstructions))
      else {
        const binding = await manager.create(channel.id, this.context(route, resourceInstructions))
        this.store.setThreadChannelCoreThread(channel.id, binding.threadId)
      }
      this.attached.add(channel.id)
    })().finally(() => this.attaching.delete(channel.id))
    this.attaching.set(channel.id, attach)
    return attach
  }

  private context(route: ResolvedRoute, resourceInstructions = ''): ExecutionContext {
    const cwd = realpathSync.native(route.workspace.path)
    return {
      thread: {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        runtimeWorkspaceRoots: [cwd],
        baseInstructions: null,
        experimentalRawEvents: false,
        ephemeral: false,
      },
      turn: {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        summary: 'detailed',
        additionalContext: route.turnInstructions || resourceInstructions ? {
          'cody-bot-hub-route': { kind: 'application', value: [route.turnInstructions, resourceInstructions].filter(Boolean).join('\n\n') },
        } : null,
      },
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
    ].filter(Boolean).join('\n\n')
    return { attached, instructions, trace }
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
