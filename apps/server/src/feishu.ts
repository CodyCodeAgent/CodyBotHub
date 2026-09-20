import { createHash } from 'node:crypto'
import path from 'node:path'
import { FeishuProvider, feishuMarkdownCards, feishuSelectionCard, feishuStreamingCard, feishuTextCard, type FeishuCard, type FeishuCardAction } from '@codycodeagent/cody-web-core/feishu'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { SecretVault } from './crypto.js'
import type { HubStore } from './db.js'
import type { CodyBotRuntime, RuntimeAttachment, RuntimeProgress, RuntimeResolvedModel } from './runtime.js'
import type { FeishuManagerHealthRecord, ResolvedRoute } from './types.js'

type ManagedProvider = { provider: FeishuProvider; fingerprint: string; botName: string; state: string; error: string }

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

  constructor(
    private readonly store: HubStore,
    private readonly vault: SecretVault,
    private readonly runtime: CodyBotRuntime,
    private readonly attachmentRoot: string,
  ) {}

  reload(): Promise<void> {
    this.reloadTail = this.reloadTail.then(() => this.reloadNow()).catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.error('[feishu] reload failed:', error)
    })
    return this.reloadTail
  }

  start(): Promise<void> {
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => this.resumeQueuedJobs(3_000), 2_000)
      this.queueTimer.unref?.()
    }
    return this.reload()
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
    if (message.conversation.name) this.store.upsertChatMetadata(botId, {
      chatId: message.conversation.id,
      name: message.conversation.name,
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
    if (message.sender.type !== 'user' && (provider.isOwnSenderId(message.sender.id) || !baseRoute.scene || !independentlyMatches)) return null
    if (message.sender.type === 'user' && baseRoute.routeSource === 'topic_context' && !message.addressedToAgent && !independentlyMatches) return null
    if (!baseRoute.scene && message.conversation.scope !== 'private' && !message.addressedToAgent) return null
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
          this.store.upsertChatMetadata(botId, { chatId, name: metadata.name, mode: metadata.mode })
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
