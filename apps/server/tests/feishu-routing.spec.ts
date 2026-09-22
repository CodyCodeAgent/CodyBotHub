import { describe, expect, it } from 'vitest'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { shouldAcceptRoutedMessage } from '../src/feishu.js'

const message = (input: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage => ({
  provider: 'feishu', accountId: 'bot-1', eventId: 'event-1', messageId: 'message-1',
  conversation: { id: 'oc_group', scope: 'group' },
  sender: { id: 'ou_user', type: 'user' },
  content: { type: 'text' }, text: '普通群聊', attachments: [],
  addressedToAgent: false, mentionsOtherRecipient: true,
  createdAtIso: new Date().toISOString(),
  ...input,
})

describe('Feishu group message trigger policy', () => {
  it('ignores ordinary group chat even when the group is bound to a Scene', () => {
    expect(shouldAcceptRoutedMessage(message(), {
      hasScene: true, independentlyMatches: false, ownSender: false,
    })).toBe(false)
  })

  it('accepts a group message that explicitly addresses the agent', () => {
    expect(shouldAcceptRoutedMessage(message({ addressedToAgent: true }), {
      hasScene: true, independentlyMatches: false, ownSender: false,
    })).toBe(true)
  })

  it('accepts an unaddressed message only when it independently matches a Scene', () => {
    expect(shouldAcceptRoutedMessage(message({ text: 'Argos-CRITICAL alarm' }), {
      hasScene: true, independentlyMatches: true, ownSender: false,
    })).toBe(true)
  })

  it('continues to accept direct messages without requiring an at-mention', () => {
    expect(shouldAcceptRoutedMessage(message({ conversation: { id: 'ou_user', scope: 'private' } }), {
      hasScene: false, independentlyMatches: false, ownSender: false,
    })).toBe(true)
  })

  it('accepts another bot only when the configured policy allows its trigger', () => {
    const fromBot = message({ sender: { id: 'cli_source', type: 'app', idType: 'app_id' } })
    expect(shouldAcceptRoutedMessage(fromBot, {
      hasScene: true, independentlyMatches: true, ownSender: false, botMessagePolicy: 'reject', botReplyDepth: 1, maxBotReplyDepth: 1,
    })).toBe(false)
    expect(shouldAcceptRoutedMessage({ ...fromBot, addressedToAgent: true }, {
      hasScene: true, independentlyMatches: false, ownSender: false, botMessagePolicy: 'mentioned', botReplyDepth: 1, maxBotReplyDepth: 1,
    })).toBe(true)
    expect(shouldAcceptRoutedMessage(fromBot, {
      hasScene: true, independentlyMatches: true, ownSender: false, botMessagePolicy: 'mentioned_or_scene', botReplyDepth: 1, maxBotReplyDepth: 1,
    })).toBe(true)
  })

  it('enforces source allowlists, loop depth, and own-sender rejection', () => {
    const fromBot = message({ sender: { id: 'ou_source', type: 'app', idType: 'open_id', identities: [{ id: 'ou_source', idType: 'open_id' }, { id: 'cli_source', idType: 'app_id' }] }, addressedToAgent: true })
    const base = { hasScene: true, independentlyMatches: true, botMessagePolicy: 'mentioned_or_scene' as const, botReplyDepth: 1, maxBotReplyDepth: 1 }
    expect(shouldAcceptRoutedMessage(fromBot, { ...base, ownSender: false, botSourceAllowlist: ['cli_other'] })).toBe(false)
    expect(shouldAcceptRoutedMessage(fromBot, { ...base, ownSender: false, botSourceAllowlist: ['cli_source'], botReplyDepth: 2 })).toBe(false)
    expect(shouldAcceptRoutedMessage(fromBot, { ...base, ownSender: true })).toBe(false)
  })
})
