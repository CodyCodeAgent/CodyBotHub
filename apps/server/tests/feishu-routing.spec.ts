import { describe, expect, it } from 'vitest'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import { selectReplyMentions, shouldAcceptRoutedMessage } from '../src/feishu.js'

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

describe('Feishu reply mention routing', () => {
  it('addresses an explicitly mentioned peer Bot instead of the human orchestrator', () => {
    const input = message({
      addressedToAgent: true,
      sender: { id: 'ou_human', type: 'user', idType: 'open_id' },
      mentions: [
        { id: 'ou_self', idType: 'open_id', type: 'user', name: '当前 Bot', isAgent: true },
        { id: 'ou_peer', idType: 'open_id', type: 'user', name: '协作 Bot', isAgent: false },
      ],
    })
    expect(selectReplyMentions(input, new Set(['ou_self', 'ou_peer']), true)).toEqual({ openIds: ['ou_peer'], targetsBot: true })
  })

  it('does not propagate mentions of other humans', () => {
    const input = message({
      addressedToAgent: true,
      sender: { id: 'ou_sender', type: 'user', idType: 'open_id' },
      mentions: [{ id: 'ou_colleague', idType: 'open_id', type: 'user', name: '同事', isAgent: false }],
    })
    expect(selectReplyMentions(input, new Set(['ou_self']), true)).toEqual({ openIds: ['ou_sender'], targetsBot: false })
  })

  it('addresses the source Bot only when Bot replies are configured to do so', () => {
    const input = message({ addressedToAgent: true, sender: { id: 'ou_source_bot', type: 'app', idType: 'open_id' } })
    expect(selectReplyMentions(input, new Set(), true)).toEqual({ openIds: ['ou_source_bot'], targetsBot: true })
    expect(selectReplyMentions(input, new Set(), false)).toEqual({ openIds: [], targetsBot: false })
  })
})
