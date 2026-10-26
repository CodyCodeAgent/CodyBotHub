import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { ResolvedRoute } from '../types.js'

export const shouldAcceptRoutedMessage = (
  message: ChannelInboundMessage,
  options: { hasScene: boolean; independentlyMatches: boolean; ownSender: boolean; requireMention?: boolean; botMessagePolicy?: ResolvedRoute['bot']['botMessagePolicy']; botSourceAllowlist?: string[]; botReplyDepth?: number; maxBotReplyDepth?: number },
): boolean => {
  if (options.ownSender) return false
  if (message.conversation.scope !== 'private' && options.requireMention && !message.addressedToAgent) return false
  if (message.sender.type !== 'user') {
    const policy = options.botMessagePolicy ?? 'mentioned_or_scene'
    if (policy === 'reject') return false
    const senderIds = new Set([message.sender.id, ...(message.sender.identities ?? []).map(identity => identity.id)])
    if (options.botSourceAllowlist?.length && !options.botSourceAllowlist.some(id => senderIds.has(id))) return false
    if ((options.botReplyDepth ?? 1) > (options.maxBotReplyDepth ?? 1)) return false
    if (policy === 'mentioned') return message.addressedToAgent
    return message.addressedToAgent || (options.hasScene && options.independentlyMatches)
  }
  if (message.conversation.scope !== 'private' && !message.addressedToAgent && !options.independentlyMatches) return false
  return true
}

export type ReplyMentionSelection = { openIds: string[]; targetsBot: boolean }

export const shouldSendTaskStatistics = (route: ResolvedRoute, message: ChannelInboundMessage): boolean => Boolean(
  route.scene?.completionStatisticsEnabled && message.sender.type === 'user'
  && message.addressedToAgent && message.mentions?.some(mention => mention.isAgent)
)

export const senderOpenId = (message: ChannelInboundMessage): string => (
  message.sender.idType === 'open_id' || (!message.sender.idType && message.sender.id.startsWith('ou_'))
    ? message.sender.id
    : message.sender.identities?.find(identity => identity.idType === 'open_id')?.id ?? ''
)

/** Select visible reply recipients without guessing from display names. A user
 * who explicitly mentions peer Bots is orchestrating collaboration, so those
 * Bots take precedence over the human sender. Other mentioned humans are not
 * propagated. Bot-authored turns continue to address their source Bot when the
 * Bot policy enables it. */
export const selectReplyMentions = (
  message: ChannelInboundMessage,
  peerBotOpenIds: ReadonlySet<string>,
  mentionSourceBot: boolean,
): ReplyMentionSelection => {
  if (message.conversation.scope === 'private' || !message.addressedToAgent) return { openIds: [], targetsBot: false }
  if (message.sender.type !== 'user') {
    if (!mentionSourceBot) return { openIds: [], targetsBot: false }
    const openId = senderOpenId(message)
    return { openIds: openId ? [openId] : [], targetsBot: Boolean(openId) }
  }
  const collaborators = [...new Set((message.mentions ?? [])
    .filter(mention => !mention.isAgent && mention.idType === 'open_id' && peerBotOpenIds.has(mention.id))
    .map(mention => mention.id))]
  if (collaborators.length) return { openIds: collaborators, targetsBot: true }
  const openId = senderOpenId(message)
  return { openIds: openId ? [openId] : [], targetsBot: false }
}
