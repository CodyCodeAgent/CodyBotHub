import { describe, expect, it } from 'vitest'
import { hasSceneMatcher, sceneMatches } from '../src/scene-matching.js'

const matcher = (overrides: Partial<{
  chatIds: string[]
  messageTypes: string[]
  textIncludes: string[]
  cardTitleIncludes: string[]
}> = {}) => ({
  chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [], ...overrides
})

const message = (overrides: Partial<{
  chatId: string
  type: string
  text: string
  title: string
}> = {}) => ({
  conversation: { id: overrides.chatId ?? 'chat-1' },
  content: { type: overrides.type ?? 'text', title: overrides.title ?? '' },
  text: overrides.text ?? 'Production Alert'
})

describe('scene matching', () => {
  it('ANDs populated matcher categories and ORs values within each category', () => {
    const rule = matcher({
      chatIds: ['chat-1'],
      messageTypes: ['text', 'post'],
      textIncludes: ['incident', 'production'],
      cardTitleIncludes: ['urgent', 'alert']
    })
    expect(sceneMatches(rule, message({ title: 'Alert details' }))).toBe(true)
    expect(sceneMatches(rule, message({ chatId: 'chat-2', title: 'Alert details' }))).toBe(false)
    expect(sceneMatches(rule, message({ title: 'Routine details' }))).toBe(false)
  })

  it('matches textual categories case-insensitively', () => {
    const rule = matcher({ textIncludes: ['PRODUCTION'], cardTitleIncludes: ['ALERT'] })
    expect(sceneMatches(rule, message({ text: 'production issue', title: 'alert details' }))).toBe(true)
  })

  it('distinguishes a fallback scene from a specifically matched scene', () => {
    expect(hasSceneMatcher(matcher())).toBe(false)
    expect(hasSceneMatcher(matcher({ chatIds: ['chat-1'] }))).toBe(true)
  })
})
