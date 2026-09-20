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
})
