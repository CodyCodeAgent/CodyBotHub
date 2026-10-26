import { FeishuProvider, feishuCardMention, type FeishuCard } from '@codycodeagent/cody-web-core/feishu'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { RuntimeResolvedModel } from '../runtime.js'
import type { ResolvedRoute } from '../types.js'
import { selectReplyMentions } from './ingress.js'

export class FeishuPresentation {
  async replyMention(provider: FeishuProvider, route: ResolvedRoute, message: ChannelInboundMessage): Promise<{ markdown: string; targetsBot: boolean }> {
    let peerBotOpenIds = new Set<string>()
    if (message.sender.type === 'user' && message.mentionsOtherRecipient) {
      try { peerBotOpenIds = new Set((await provider.chatBots(message.conversation.id)).map(bot => bot.id)) }
      catch (error) { console.warn('[feishu] failed to resolve peer Bot mentions:', provider.classifyError(error).message) }
    }
    const selection = selectReplyMentions(message, peerBotOpenIds, route.bot.mentionSourceBot)
    return { markdown: selection.openIds.map(feishuCardMention).filter(Boolean).join(' '), targetsBot: selection.targetsBot }
  }

  async finishReaction(provider: FeishuProvider, messageId: string, receiptReactionId: string, finalEmoji: 'DONE' | 'ERROR'): Promise<void> {
    if (receiptReactionId) await provider.removeReaction(messageId, receiptReactionId).catch(error => console.warn('[feishu] failed to remove receipt reaction:', provider.classifyError(error).message))
    await provider.addReaction(messageId, finalEmoji).catch(error => console.warn('[feishu] failed to add final reaction:', provider.classifyError(error).message))
  }

  responseNote(route: ResolvedRoute, resolvedModel?: RuntimeResolvedModel): string {
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

  replyCard(provider: FeishuProvider, messageId: string, card: FeishuCard, replyInThread: boolean, uuid: string): Promise<string> {
    return this.retryDelivery(provider, () => provider.replyCard(messageId, card, replyInThread, uuid))
  }

  async retryDelivery<T>(provider: FeishuProvider, operation: () => Promise<T>): Promise<T> {
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
