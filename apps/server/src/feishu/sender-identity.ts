import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { FeishuProvider } from '@codycodeagent/cody-web-core/feishu'
import { senderOpenId } from './ingress.js'

export type SenderIdentity = { openId: string; name?: string; email?: string }

/** Use the Bot application's Open ID namespace. Contact access is optional. */
export async function resolveSenderIdentity(
  provider: Pick<FeishuProvider, 'userMetadata'>,
  message: ChannelInboundMessage,
): Promise<SenderIdentity | undefined> {
  if (message.sender.type !== 'user') return undefined
  const openId = senderOpenId(message)
  if (!openId) return undefined
  const fallbackName = message.sender.name?.trim() || undefined
  try {
    const profile = await provider.userMetadata(openId)
    const name = profile.name || fallbackName
    return { openId, ...(name ? { name } : {}), ...(profile.email ? { email: profile.email } : {}) }
  } catch {
    return { openId, ...(fallbackName ? { name: fallbackName } : {}) }
  }
}
