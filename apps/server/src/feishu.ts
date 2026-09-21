import { createHash } from 'node:crypto'
import path from 'node:path'
import { FeishuProvider, feishuMarkdownCards, feishuSelectionCard, feishuStreamingCard, feishuTextCard, type FeishuCard, type FeishuCardAction } from '@codycodeagent/cody-web-core/feishu'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { SecretVault } from './crypto.js'
import type { HubStore } from './db.js'
import type { CodyBotRuntime, RuntimeAttachment, RuntimeProgress, RuntimeResolvedModel } from './runtime.js'
import type { FeishuManagerHealthRecord, ResolvedRoute } from './types.js'
import { ToolPackageRunner } from './tool-execution.js'

type ManagedProvider = { provider: FeishuProvider; fingerprint: string; botName: string; state: string; error: string }

export const shouldAcceptRoutedMessage = (
  message: ChannelInboundMessage,
  options: { hasScene: boolean; independentlyMatches: boolean; ownSender: boolean },
): boolean => {
  if (message.sender.type !== 'user') return !options.ownSender && options.hasScene && options.independentlyMatches
  if (message.conversation.scope !== 'private' && !message.addressedToAgent && !options.independentlyMatches) return false
  return true
}

export class FeishuBotManager {
  private readonly providers = new Map<string, ManagedProvider>()
  private readonly channelQueues = new Map<string, Promise<void>>()
  private readonly scheduledJobs = new Set<string>()
  private readonly pendingReceipts = new Set<string>()
  private reloadTail = Promise.resolve()
  private queueTimer: ReturnType<typeof setInterval> | null = null
  private lastQueueScanAt = ''
  private lastError = ''
  private draining = false
  private drainStartedAt = ''
  private readonly toolRunner: ToolPackageRunner

  constructor(
    private readonly store: HubStore,
    private readonly vault: SecretVault,
    private readonly runtime: CodyBotRuntime,
    private readonly attachmentRoot: string,
  ) { this.toolRunner = new ToolPackageRunner(store) }

  reload(): Promise<void> {
    this.reloadTail = this.reloadTail.then(() => this.reloadNow()).catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.error('[feishu] reload failed:', error)
    })
    return this.reloadTail
  }

  start(): Promise<void> {
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => { this.resumeQueuedJobs(3_000); this.resumeToolExecutions() }, 2_000)
      this.queueTimer.unref?.()
    }
    return this.reload().then(() => { this.resumeToolExecutions() })
  }

  stop(): void {
    if (this.queueTimer) clearInterval(this.queueTimer)
    this.queueTimer = null
    for (const managed of this.providers.values()) managed.provider.stop()
    this.providers.clear()
  }

  beginDrain(): void {
    if (this.draining) return
    this.draining = true
    this.drainStartedAt = new Date().toISOString()
    console.info(`[feishu] drain started; active=${this.scheduledJobs.size} pendingReceipts=${this.pendingReceipts.size}`)
  }

  cancelDrain(): void {
    if (!this.draining) return
    this.draining = false
    this.drainStartedAt = ''
    console.info('[feishu] drain cancelled; queued jobs will resume')
    this.resumeQueuedJobs()
    this.resumeToolExecutions()
  }

  async invokeToolPackage(call: { callId: string; packageId: string; arguments: Record<string, unknown>; reason: string; sourceLogId: string }, binding: { id: string; threadId: string }): Promise<Record<string, unknown>> {
    const duplicate = this.store.findToolPackageExecution(binding.id, call.callId)
    if (duplicate) return { status: duplicate.status, executionId: duplicate.id, toolPackage: duplicate.toolPackageName }
    const log = this.store.getMessageLogForToolInvocation(call.sourceLogId, binding.id)
    const pack = this.store.getToolPackage(call.packageId)
    if (!pack.enabled) throw new Error(`Tool Package ${pack.name} is disabled`)
    if (pack.workspaceId !== log.workspaceId) throw new Error('Tool Package belongs to another Workspace')
    const allowed = this.store.listSkillPackages().some(item => log.skillPackages.some(link => link.id === item.id) && item.toolPackageIds.includes(pack.id))
    if (!allowed) throw new Error('Tool Package is not attached to the active Skill Package')
    if (!pack.steps.length) throw new Error('Tool Package has no executable steps')
    const provider = this.providers.get(log.botId)?.provider
    if (!provider) throw new Error('Feishu Bot is not connected')
    const execution = this.store.createToolPackageExecution({
      callId: call.callId, toolPackageId: pack.id, botId: log.botId, sceneId: log.sceneId, chatId: log.chatId, topicId: log.topicId,
      threadChannelId: binding.id, coreThreadId: binding.threadId, sourceMessageId: log.messageId, arguments: call.arguments,
      reason: call.reason, requestedBy: 'Codex', status: pack.approvalRequired ? 'awaiting_approval' : 'queued',
    })
    const card = pack.approvalRequired
      ? feishuTextCard(pack.cardTitle || `确认执行：${pack.name}`, [pack.cardDescription, `**执行原因**\n${call.reason || '未提供'}`, `**参数**\n\`\`\`json\n${JSON.stringify(call.arguments, null, 2).slice(0, 8_000)}\n\`\`\``].filter(Boolean).join('\n\n'), {
        color: 'orange', note: `执行 ID：${execution.id}`,
        actions: [
          { text: '确认执行', type: 'primary', value: { action: 'tool_package_approve', botId: log.botId, executionId: execution.id } },
          { text: '拒绝', type: 'danger', value: { action: 'tool_package_reject', botId: log.botId, executionId: execution.id } },
        ],
      })
      : feishuTextCard(`工具包已进入队列：${pack.name}`, `**执行原因**\n${call.reason || '未提供'}\n\n系统会在当前 Codex Thread 空闲后串行执行。`, { color: 'blue', note: `执行 ID：${execution.id}` })
    let cardMessageId = ''
    try { cardMessageId = await this.replyCard(provider, log.messageId, card, Boolean(log.topicId), `tool-package:${execution.id}`) }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.store.updateToolPackageExecution(execution.id, { status: 'failed', error: `无法发送工具包卡片：${detail}`, completedAt: new Date().toISOString() })
      throw error
    }
    this.store.updateToolPackageExecution(execution.id, { cardMessageId })
    if (!pack.approvalRequired) this.scheduleToolExecution(execution.id)
    return { status: pack.approvalRequired ? 'awaiting_approval' : 'queued', executionId: execution.id, toolPackage: pack.name }
  }

  private resumeToolExecutions(): void {
    for (const execution of this.store.listQueuedToolPackageExecutions(500)) this.scheduleToolExecution(execution.id)
  }

  private scheduleToolExecution(executionId: string): void {
    const execution = this.store.getToolPackageExecution(executionId)
    if (this.draining || execution.status !== 'queued') return
    const key = `tool:${executionId}`
    if (this.scheduledJobs.has(key)) return
    this.scheduledJobs.add(key)
    const previous = this.channelQueues.get(execution.threadChannelId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.runToolExecution(executionId))
    this.channelQueues.set(execution.threadChannelId, current)
    const cleanup = () => {
      this.scheduledJobs.delete(key)
      if (this.channelQueues.get(execution.threadChannelId) === current) this.channelQueues.delete(execution.threadChannelId)
    }
    void current.then(cleanup, cleanup)
  }

  private async runToolExecution(executionId: string): Promise<void> {
    let execution = this.store.getToolPackageExecution(executionId)
    if (execution.status !== 'queued') return
    const pack = this.store.getToolPackage(execution.toolPackageId)
    const workspace = this.store.getWorkspace(pack.workspaceId)
    const provider = this.providers.get(execution.botId)?.provider
    if (!provider) throw new Error('Feishu Bot is not connected')
    execution = this.store.updateToolPackageExecution(execution.id, { status: 'running' })
    if (execution.cardMessageId) await this.retryDelivery(provider, () => provider.updateCard(execution.cardMessageId, feishuTextCard(`正在执行：${pack.name}`, `已通过确认，正在按顺序执行 ${pack.steps.length} 个步骤。`, { color: 'blue', note: `执行 ID：${execution.id}` }))).catch(() => undefined)
    try {
      const sourceLog = this.store.getMessageLogByBotMessage(execution.botId, execution.sourceMessageId)
      const stillAuthorized = this.store.listSkillPackages().some(item => sourceLog.skillPackages.some(link => link.id === item.id) && item.toolPackageIds.includes(pack.id))
      if (!stillAuthorized) throw new Error('工具包已从本次消息使用的技能包中移除，已拒绝执行；请让 AI 基于最新配置重新发起申请')
      const requestedAt = Date.parse(execution.createdAt)
      const configurationChanged = Date.parse(pack.updatedAt) > requestedAt || pack.steps.some(step => Date.parse(this.store.getTool(step.toolId).updatedAt) > requestedAt)
      if (configurationChanged) throw new Error('工具包或工具配置在本次申请后发生变化，已拒绝执行；请让 AI 基于最新配置重新发起申请')
      const results = await this.toolRunner.run(pack, execution.arguments, workspace.path)
      execution = this.store.updateToolPackageExecution(execution.id, { status: 'completed', result: results, completedAt: new Date().toISOString() })
      if (execution.cardMessageId) await this.retryDelivery(provider, () => provider.updateCard(execution.cardMessageId, feishuTextCard(`执行完成：${pack.name}`, results.map(item => `- ${item.phase} · ${item.toolName}：成功（${item.durationMs}ms）`).join('\n'), { color: 'green', note: `执行 ID：${execution.id}` }))).catch(error => console.warn('[feishu] failed to patch completed tool card:', error))
      await this.continueAfterToolExecution(execution, provider).catch(error => console.error('[feishu] failed to continue completed tool execution:', error))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const partialResults = error && typeof error === 'object' && 'partialResults' in error && Array.isArray(error.partialResults) ? error.partialResults : []
      execution = this.store.updateToolPackageExecution(execution.id, { status: 'failed', result: partialResults, error: detail, completedAt: new Date().toISOString() })
      if (execution.cardMessageId) await this.retryDelivery(provider, () => provider.updateCard(execution.cardMessageId, feishuTextCard(`执行失败：${pack.name}`, `**错误**\n${detail}`, { color: 'red', note: `执行 ID：${execution.id}` }))).catch(() => undefined)
      await this.continueAfterToolExecution(execution, provider).catch(continuationError => console.error('[feishu] failed to continue tool execution:', continuationError))
    }
  }

  private async continueAfterToolExecution(execution: ReturnType<HubStore['getToolPackageExecution']>, provider: FeishuProvider): Promise<void> {
    const scene = this.store.listScenes().find(item => item.id === execution.sceneId)
    const message: ChannelInboundMessage = {
      provider: 'feishu', accountId: execution.botId, eventId: `tool-package:${execution.id}`, messageId: execution.sourceMessageId,
      conversation: { id: execution.chatId, scope: execution.topicId ? 'topic' : 'group', ...(execution.topicId ? { rootId: execution.topicId } : {}) },
      sender: { id: 'codybothub-tool-runner', type: 'app' }, content: { type: 'tool_result', title: scene?.matcher.cardTitleIncludes[0] ?? '' },
      text: [scene?.matcher.textIncludes[0] ?? '', `工具包“${execution.toolPackageName}”执行结果如下。`, `执行状态：${execution.status}`, execution.error ? `错误：${execution.error}` : '', Array.isArray(execution.result) && execution.result.length ? `已成功步骤：${JSON.stringify(execution.result, null, 2)}` : execution.error ? '' : `结果：${JSON.stringify(execution.result, null, 2)}`, '请根据原任务和本次真实执行结果继续处理，并向用户说明最终状态。'].filter(Boolean).join('\n\n'),
      attachments: [], addressedToAgent: true, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const base = this.store.resolveRoute(execution.botId, message)
    const route: ResolvedRoute = { ...base, threadChannelId: execution.threadChannelId, threadRouting: { type: 'fixed', matchedThreadId: execution.coreThreadId, score: 1, reason: '工具包执行结果续写原 Thread Channel' } }
    const originalLog = this.store.getMessageLogByBotMessage(execution.botId, execution.sourceMessageId)
    const sourceLog = this.store.getMessageLogForToolInvocation(originalLog.id, execution.threadChannelId)
    const answer = await this.runtime.execute(route, message, [], undefined, undefined, undefined, undefined, sourceLog.id, false)
    const cards = feishuMarkdownCards(answer, { note: `工具包：${execution.toolPackageName}  |  Thread：${execution.coreThreadId}` })
    for (let index = 0; index < cards.length; index += 1) await this.replyCard(provider, execution.sourceMessageId, cards[index]!, Boolean(execution.topicId), `tool-package:${execution.id}:answer:${index}`)
  }

  deploymentStatus(): { draining: boolean; drainStartedAt: string; activeJobs: number; pendingReceipts: number; activeChannels: number } {
    return {
      draining: this.draining,
      drainStartedAt: this.drainStartedAt,
      activeJobs: this.scheduledJobs.size,
      pendingReceipts: this.pendingReceipts.size,
      activeChannels: this.channelQueues.size,
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.scheduledJobs.size || this.pendingReceipts.size) await new Promise(resolve => setTimeout(resolve, 200))
  }

  health(): FeishuManagerHealthRecord {
    const configured = this.store.listBots().filter(bot => bot.appId && bot.hasAppSecret)
    const providers = configured.map(bot => {
      const managed = this.providers.get(bot.id)
      return { botId: bot.id, botName: bot.name, state: managed?.state ?? 'disconnected', error: managed?.error ?? '' }
    })
    return {
      ...this.deploymentStatus(),
      configuredBots: configured.length,
      activeProviders: this.providers.size,
      connectedProviders: providers.filter(item => !['failed', 'disconnected', 'stopped'].includes(item.state)).length,
      scheduledJobs: this.scheduledJobs.size + this.pendingReceipts.size,
      activeChannels: this.channelQueues.size,
      lastQueueScanAt: this.lastQueueScanAt,
      lastError: this.lastError,
      providers,
    }
  }

  private async reloadNow(): Promise<void> {
    const configured = new Map(this.store.listBots().filter(bot => bot.appId && bot.hasAppSecret).map(bot => [bot.id, bot]))
    for (const [botId, managed] of this.providers) {
      const bot = configured.get(botId)
      const fingerprint = bot ? `${bot.appId}:${bot.updatedAt}` : ''
      if (!bot || fingerprint !== managed.fingerprint) { managed.provider.stop(); this.providers.delete(botId) }
    }
    for (const [botId, bot] of configured) {
      if (this.providers.has(botId)) continue
      const encrypted = this.store.getBotSecret(botId)
      const provider = new FeishuProvider({ accountId: botId, appId: bot.appId, appSecret: this.vault.decrypt(encrypted), privateConversationMode: 'chat' })
      const managed: ManagedProvider = { provider, fingerprint: `${bot.appId}:${bot.updatedAt}`, botName: bot.name, state: 'starting', error: '' }
      this.providers.set(botId, managed)
      try {
        await provider.identity()
        await provider.start({
          onMessage: message => this.acceptMessage(botId, provider, message),
          onAction: action => this.onAction(botId, provider, action),
          onState: (state, error) => {
            managed.state = String(state)
            managed.error = error?.message ?? ''
            if (state === 'failed') this.lastError = managed.error || `${bot.name} connection failed`
            console[state === 'failed' ? 'error' : 'info'](`[feishu:${bot.name}] ${state}${error ? `: ${error.message}` : ''}`)
          },
        })
        if (managed.state === 'starting') managed.state = 'connected'
        void this.refreshKnownChats(botId, provider).catch(error => console.warn(`[feishu:${bot.name}] chat metadata refresh failed:`, error))
      } catch (error) {
        managed.state = 'failed'
        managed.error = error instanceof Error ? error.message : String(error)
        this.lastError = managed.error
        this.providers.delete(botId)
        provider.stop()
        console.error(`[feishu:${bot.name}] start failed:`, error)
      }
    }
    this.resumeQueuedJobs()
  }

  private async acceptMessage(botId: string, provider: FeishuProvider, message: ChannelInboundMessage): Promise<void> {
    let conversationName = message.conversation.name ?? ''
    if (!conversationName && message.conversation.scope === 'private' && message.sender.type === 'user') {
      try { conversationName = (await provider.userMetadata(message.sender.id)).name }
      catch (error) { console.warn(`[feishu] failed to resolve user ${message.sender.id}:`, provider.classifyError(error).message) }
    }
    if (conversationName || message.conversation.scope === 'private') this.store.upsertChatMetadata(botId, {
      chatId: message.conversation.id,
      name: conversationName,
      mode: message.conversation.scope === 'topic' ? 'topic' : message.conversation.scope === 'private' ? 'p2p' : 'group',
    })
    const route = this.prepareRoute(botId, provider, message)
    if (!route) return
    const accepted = this.store.acceptInboundMessage(botId, route, message)
    if (!accepted) return
    this.pendingReceipts.add(accepted.job.id)
    let receiptReactionId = ''
    try {
      receiptReactionId = await provider.addReaction(message.messageId, 'GoGoGo')
      this.store.setThreadJobReceiptReaction(accepted.job.id, receiptReactionId)
    }
    catch (error) { console.warn('[feishu] failed to add receipt reaction:', provider.classifyError(error).message) }
    finally { this.pendingReceipts.delete(accepted.job.id) }
    return this.scheduleJob(accepted.job.id, accepted.log.id, botId, provider, route, message, receiptReactionId)
  }

  private prepareRoute(botId: string, provider: FeishuProvider, message: ChannelInboundMessage): ResolvedRoute | null {
    const baseRoute = this.store.resolveRoute(botId, message)
    const independentlyMatches = baseRoute.scene ? this.store.messageMatchesScene(baseRoute.scene.id, message) : false
    if (!shouldAcceptRoutedMessage(message, {
      hasScene: Boolean(baseRoute.scene),
      independentlyMatches,
      ownSender: provider.isOwnSenderId(message.sender.id),
    })) return null
    if (baseRoute.scene && baseRoute.routeSource === 'matcher' && baseRoute.topicId) this.store.rememberTopicRoute(botId, message.conversation.id, baseRoute.topicId, baseRoute.scene.id)
    return this.store.resolveThreadRouting(baseRoute, message)
  }

  resumeQueuedJobs(minimumAgeMs = 0): void {
    if (this.draining) return
    this.lastQueueScanAt = new Date().toISOString()
    for (const { job, message } of this.store.listQueuedThreadJobs()) {
      const provider = this.providers.get(job.botId)?.provider
      if (!provider || this.scheduledJobs.has(job.id) || this.pendingReceipts.has(job.id)) continue
      if (minimumAgeMs > 0 && Date.now() - Date.parse(job.createdAt) < minimumAgeMs) continue
      try {
        const baseRoute = this.store.resolveRoute(job.botId, message)
        const route = job.attempts > 0
          ? { ...baseRoute, threadChannelId: job.threadChannelId, threadRouting: { type: 'fixed' as const, matchedThreadId: this.store.getThreadChannel(job.threadChannelId).threadId, score: 1, reason: '管理员手动重试，沿用原 Thread Channel' } }
          : this.store.resolveThreadRouting(baseRoute, message)
        void this.scheduleJob(job.id, job.logId, job.botId, provider, route, message, job.receiptReactionId)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.lastError = detail
        try { this.store.failThreadJob(job.id, detail) }
        catch (persistError) { console.error(`[feishu] failed to persist restore error for Thread job ${job.id}:`, persistError) }
        void this.finishReaction(provider, message.messageId, job.receiptReactionId, 'ERROR')
        console.error(`[feishu] failed to restore Thread job ${job.id}:`, error)
      }
    }
  }

  private scheduleJob(jobId: string, logId: string, botId: string, provider: FeishuProvider, route: ResolvedRoute, message: ChannelInboundMessage, receiptReactionId: string): Promise<void> {
    if (this.draining) return Promise.resolve()
    if (this.scheduledJobs.has(jobId)) return Promise.resolve()
    this.scheduledJobs.add(jobId)
    const channelId = route.threadChannelId
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      if (!this.store.startThreadJob(jobId)) return
      try {
        const result = await this.onMessage(botId, provider, route, message, logId, receiptReactionId)
        this.store.finishThreadJob(jobId, result.ok ? 'completed' : 'failed', result.error)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.store.failThreadJob(jobId, detail)
        await this.finishReaction(provider, message.messageId, receiptReactionId, 'ERROR')
      }
    })
    this.channelQueues.set(channelId, current)
    const cleanup = () => {
      this.scheduledJobs.delete(jobId)
      if (this.channelQueues.get(channelId) === current) this.channelQueues.delete(channelId)
    }
    void current.then(cleanup, cleanup)
    return current
  }

  private async refreshKnownChats(botId: string, provider: FeishuProvider): Promise<void> {
    const chatIds = this.store.listChatIdsForMetadataSync(botId)
    for (let offset = 0; offset < chatIds.length; offset += 5) {
      const batch = chatIds.slice(offset, offset + 5)
      await Promise.all(batch.map(async chatId => {
        try {
          const metadata = await provider.chatMetadata(chatId)
          let name = metadata.name
          if (!name && metadata.mode === 'p2p') {
            const senderId = this.store.latestSenderIdForChat(botId, chatId)
            if (senderId) name = (await provider.userMetadata(senderId)).name
          }
          this.store.upsertChatMetadata(botId, { chatId, name, mode: metadata.mode })
        } catch (error) {
          console.warn(`[feishu] failed to resolve chat ${chatId}:`, provider.classifyError(error).message)
        }
      }))
    }
  }

  private async onMessage(botId: string, provider: FeishuProvider, route: ResolvedRoute, message: ChannelInboundMessage, logId: string, existingReceiptReactionId: string): Promise<{ ok: boolean; error: string }> {
    const log = this.store.getMessageLog(logId)
    let receiptReactionId = existingReceiptReactionId
    if (!receiptReactionId) {
      try { receiptReactionId = await provider.addReaction(message.messageId, 'GoGoGo') }
      catch (error) { console.warn('[feishu] failed to add receipt reaction:', provider.classifyError(error).message) }
    }
    if (!route.scene && message.conversation.scope !== 'private' && this.store.claimScenePicker(botId, message.conversation.id)) await this.sendScenePicker(botId, provider, message).catch(error => console.warn('[feishu] failed to send scene picker:', provider.classifyError(error).message))
    let note = this.responseNote(route)
    let streamMessageId = ''
    try {
      streamMessageId = await this.replyCard(provider, message.messageId, feishuStreamingCard({ state: 'received', note }), route.replyInTopic, `${message.eventId}:answer`)
    } catch (error) {
      console.warn('[feishu] failed to create streaming card:', provider.classifyError(error).message)
    }
    let patchTimer: ReturnType<typeof setTimeout> | null = null
    let latestProgress: RuntimeProgress = { phase: 'thinking', reasoning: '', answer: '' }
    let patchTail = Promise.resolve()
    const enqueuePatch = () => {
      if (!streamMessageId) return
      const snapshot = latestProgress
      patchTail = patchTail.then(() => this.retryDelivery(provider, () => provider.updateCard(streamMessageId, feishuStreamingCard({
        state: snapshot.phase === 'answering' ? 'answering' : 'thinking',
        answer: snapshot.answer,
        note,
      })))).catch(error => console.warn('[feishu] streaming card update failed:', provider.classifyError(error).message))
    }
    const schedulePatch = (progress: RuntimeProgress) => {
      latestProgress = progress
      if (patchTimer) return
      patchTimer = setTimeout(() => { patchTimer = null; enqueuePatch() }, 450)
      patchTimer.unref?.()
    }
    try {
      const attachments = await this.downloadAttachments(botId, provider, message)
      const text = await this.runtime.execute(
        route,
        message,
        attachments,
        schedulePatch,
        model => {
          this.store.setMessageLogModel(log.id, model)
          note = this.responseNote(route, model)
        },
        trace => this.store.setMessageLogInvestigation(log.id, trace),
        threadId => this.store.setMessageLogThread(log.id, threadId),
        log.id,
      )
      if (patchTimer) { clearTimeout(patchTimer); patchTimer = null }
      await patchTail
      const cards = feishuMarkdownCards(text, { note })
      if (streamMessageId) {
        await this.retryDelivery(provider, () => provider.updateCard(streamMessageId, cards[0]!))
        for (let index = 1; index < cards.length; index += 1) {
          await this.replyCard(provider, message.messageId, cards[index]!, route.replyInTopic, `${message.eventId}:answer:${index}`)
        }
      } else {
        for (let index = 0; index < cards.length; index += 1) {
          await this.replyCard(provider, message.messageId, cards[index]!, route.replyInTopic, `${message.eventId}:answer:${index}`)
        }
      }
      this.store.finishMessageLog(log.id, { responseContent: text })
      await this.finishReaction(provider, message.messageId, receiptReactionId, 'DONE')
      return { ok: true, error: '' }
    } catch (error) {
      if (patchTimer) clearTimeout(patchTimer)
      await patchTail
      const detail = error instanceof Error ? error.message : String(error)
      const errorCard = feishuStreamingCard({ state: 'failed', error: detail, note })
      const sendError = streamMessageId
        ? this.retryDelivery(provider, () => provider.updateCard(streamMessageId, errorCard))
        : this.replyCard(provider, message.messageId, errorCard, route.replyInTopic, `${message.eventId}:error`).then(() => undefined)
      await sendError.catch(deliveryError => console.error('[feishu] failed to send error card:', deliveryError))
      this.store.finishMessageLog(log.id, { responseContent: latestProgress.answer, error: detail })
      await this.finishReaction(provider, message.messageId, receiptReactionId, 'ERROR')
      return { ok: false, error: detail }
    }
  }

  private async finishReaction(provider: FeishuProvider, messageId: string, receiptReactionId: string, finalEmoji: 'DONE' | 'ERROR'): Promise<void> {
    if (receiptReactionId) await provider.removeReaction(messageId, receiptReactionId).catch(error => console.warn('[feishu] failed to remove receipt reaction:', provider.classifyError(error).message))
    await provider.addReaction(messageId, finalEmoji).catch(error => console.warn('[feishu] failed to add final reaction:', provider.classifyError(error).message))
  }

  private async downloadAttachments(botId: string, provider: FeishuProvider, message: ChannelInboundMessage): Promise<RuntimeAttachment[]> {
    if (!message.attachments.length) return []
    const messageKey = createHash('sha256').update(message.messageId).digest('hex').slice(0, 24)
    const directory = path.join(this.attachmentRoot, botId, messageKey)
    return Promise.all(message.attachments.map(async attachment => {
      const downloaded = await provider.downloadAttachment(message.messageId, attachment, directory)
      return { ...attachment, ...downloaded }
    }))
  }

  private responseNote(route: ResolvedRoute, resolvedModel?: RuntimeResolvedModel): string {
    const model = resolvedModel?.model || route.modelConfig.model || 'Codex 默认'
    const reasoningEffort = resolvedModel?.reasoningEffort || route.modelConfig.reasoningEffort
    const modelLabel = `${model}${reasoningEffort ? ` · ${reasoningEffort}` : ''}${resolvedModel?.fallback ? ' · 已回退' : ''}`
    return [
      `工作区：${route.workspace.name}`,
      `场景：${route.scene?.name ?? '默认路由'}`,
      `引擎：${route.bot.runtimeKind === 'traex' ? 'TraeX' : 'Codex'}`,
      `技能包：${route.skillPackages.map(item => item.name).join('、') || '无'}`,
      `模型：${modelLabel}`,
      '权限：YOLO · 允许网络与工具',
    ].join('  |  ')
  }

  private async sendScenePicker(botId: string, provider: FeishuProvider, message: ChannelInboundMessage): Promise<void> {
    const scenes = this.store.listScenes().filter(scene => scene.botId === botId && scene.enabled)
    if (!scenes.length || message.conversation.scope === 'private') return
    const card = feishuSelectionCard('选择群场景', '这条消息已经在默认工作区中处理。选择后，它会作为这个群的默认场景；匹配到更具体的场景时仍会按消息动态路由。', scenes.map(scene => ({ text: scene.name, value: { action: 'bind_scene', botId, chatId: message.conversation.id, sceneId: scene.id } })), '只在群首次接入时提示。只有 Bot 管理员或平台中配置的操作人可以保存绑定。')
    await this.replyCard(provider, message.messageId, card, false, `${message.eventId}:scene-picker`)
  }

  private async onAction(botId: string, provider: FeishuProvider, action: FeishuCardAction): Promise<Record<string, unknown>> {
    if (['tool_package_approve', 'tool_package_reject'].includes(String(action.value.action))) return this.onToolPackageAction(botId, provider, action)
    if (action.value.action !== 'bind_scene' || action.value.botId !== botId) return { toast: { type: 'warning', content: '这个操作已失效' } }
    const bot = this.store.listBots().find(item => item.id === botId)
    if (!bot) return { toast: { type: 'error', content: 'Bot 不存在' } }
    let allowed = bot.operatorIds.includes(action.actorId)
    if (!bot.operatorIds.length) {
      try { allowed = (await provider.applicationAdministrators()).administratorIds.includes(action.actorId) }
      catch { allowed = false }
    }
    if (!allowed) return { toast: { type: 'error', content: '你没有绑定群场景的权限' } }
    const chatId = String(action.value.chatId ?? ''), sceneId = String(action.value.sceneId ?? '')
    if (!chatId || !sceneId) return { toast: { type: 'error', content: '场景参数不完整' } }
    this.store.bindGroupScene(botId, chatId, sceneId, action.actorId)
    const scene = this.store.listScenes().find(item => item.id === sceneId)
    if (action.remoteMessageId) await this.retryDelivery(provider, () => provider.updateCard(action.remoteMessageId, feishuTextCard('群默认场景已绑定', `未命中更具体规则时，将使用场景：**${scene?.name ?? sceneId}**`, { color: 'green' })))
    return { toast: { type: 'success', content: '场景已绑定' } }
  }

  private async onToolPackageAction(botId: string, provider: FeishuProvider, action: FeishuCardAction): Promise<Record<string, unknown>> {
    if (action.value.botId !== botId) return { toast: { type: 'warning', content: '这个操作已失效' } }
    const executionId = String(action.value.executionId ?? '')
    const execution = this.store.getToolPackageExecution(executionId)
    if (execution.botId !== botId) return { toast: { type: 'warning', content: '这个操作不属于当前 Bot' } }
    if (execution.status !== 'awaiting_approval') return { toast: { type: 'info', content: `当前状态：${execution.status}` } }
    const pack = this.store.getToolPackage(execution.toolPackageId)
    const bot = this.store.listBots().find(item => item.id === botId)
    let allowed = pack.approverIds.includes(action.actorId) || Boolean(bot?.operatorIds.includes(action.actorId))
    if (!pack.approverIds.length && !bot?.operatorIds.length) {
      try {
        const administrators = await Promise.race([
          provider.applicationAdministrators(),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('administrator lookup timed out')), 1_200)),
        ])
        allowed = administrators.administratorIds.includes(action.actorId)
      } catch { allowed = false }
    }
    if (!allowed) return { toast: { type: 'error', content: '你没有确认这个工具包的权限' } }
    if (action.value.action === 'tool_package_reject') {
      const rejected = this.store.transitionToolPackageExecution(execution.id, 'awaiting_approval', 'rejected', action.actorId, new Date().toISOString())
      if (!rejected) return { toast: { type: 'info', content: '这个请求已经被处理' } }
      if (action.remoteMessageId) void this.retryDelivery(provider, () => provider.updateCard(action.remoteMessageId, feishuTextCard(`已拒绝：${pack.name}`, `操作人 ${action.actorId} 拒绝了本次执行。`, { color: 'red', note: `执行 ID：${execution.id}` }))).catch(error => console.warn('[feishu] failed to patch rejected tool card:', error))
      this.scheduleToolContinuation(rejected, provider)
      return { toast: { type: 'success', content: '已拒绝执行' } }
    }
    const queued = this.store.transitionToolPackageExecution(execution.id, 'awaiting_approval', 'queued', action.actorId)
    if (!queued) return { toast: { type: 'info', content: '这个请求已经被处理' } }
    if (action.remoteMessageId) void this.retryDelivery(provider, () => provider.updateCard(action.remoteMessageId, feishuTextCard(`已确认：${pack.name}`, '已进入当前 Thread Channel 的串行执行队列。', { color: 'blue', note: `执行 ID：${execution.id}` }))).catch(error => console.warn('[feishu] failed to patch approved tool card:', error))
    this.scheduleToolExecution(execution.id)
    return { toast: { type: 'success', content: '已确认，开始执行' } }
  }

  private scheduleToolContinuation(execution: ReturnType<HubStore['getToolPackageExecution']>, provider: FeishuProvider): void {
    const key = `tool-continuation:${execution.id}`
    if (this.draining || this.scheduledJobs.has(key)) return
    this.scheduledJobs.add(key)
    const previous = this.channelQueues.get(execution.threadChannelId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.continueAfterToolExecution(execution, provider))
    this.channelQueues.set(execution.threadChannelId, current)
    const cleanup = () => { this.scheduledJobs.delete(key); if (this.channelQueues.get(execution.threadChannelId) === current) this.channelQueues.delete(execution.threadChannelId) }
    void current.then(cleanup, error => { console.error('[feishu] failed to continue rejected tool execution:', error); cleanup() })
  }

  private replyCard(provider: FeishuProvider, messageId: string, card: FeishuCard, replyInThread: boolean, uuid: string): Promise<string> {
    return this.retryDelivery(provider, () => provider.replyCard(messageId, card, replyInThread, uuid))
  }

  private async retryDelivery<T>(provider: FeishuProvider, operation: () => Promise<T>): Promise<T> {
    const delays = [0, 250, 1_000]
    let lastError: unknown
    for (const delay of delays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try { return await operation() }
      catch (error) {
        lastError = error
        if (!provider.classifyError(error).retryable) throw error
      }
    }
    throw lastError
  }
}
