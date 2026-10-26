type SceneMatcher = {
  chatIds: string[]
  messageTypes: string[]
  textIncludes: string[]
  cardTitleIncludes: string[]
}

type MatchableMessage = {
  conversation: { id: string }
  content?: { type?: string; title?: string }
  text: string
}

const includesText = (values: string[], target: string) => {
  if (values.length === 0) return true
  const normalizedTarget = target.toLocaleLowerCase()
  return values.some(value => normalizedTarget.includes(value.toLocaleLowerCase()))
}

export const sceneMatches = (matcher: SceneMatcher, message: MatchableMessage): boolean => {
  if (matcher.chatIds.length > 0 && !matcher.chatIds.includes(message.conversation.id)) return false
  if (matcher.messageTypes.length > 0 && !matcher.messageTypes.includes(message.content?.type ?? '')) return false
  if (!includesText(matcher.textIncludes, message.text)) return false
  return includesText(matcher.cardTitleIncludes, message.content?.title ?? '')
}

export const hasSceneMatcher = (matcher: SceneMatcher): boolean =>
  matcher.chatIds.length > 0 ||
  matcher.messageTypes.length > 0 ||
  matcher.textIncludes.length > 0 ||
  matcher.cardTitleIncludes.length > 0
