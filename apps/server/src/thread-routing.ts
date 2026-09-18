export type ThreadFeatures = {
  normalizedText: string
  tokens: Set<string>
  fields: Record<string, string>
}

export type ThreadSimilarity = {
  score: number
  structuredScore: number
  textScore: number
  sameEvent: boolean
  matchedFields: string[]
}

const fieldPatterns: Array<[string, RegExp]> = [
  ['service', /(?:\*{0,2}(?:服务|psm)\*{0,2})\s*[:：=]\s*\*{0,2}([a-z][a-z0-9_.-]+)/iu],
  ['event', /(?:\*{0,2}event\*{0,2})\s*[:：=]\s*\*{0,2}([a-z0-9_.-]+)/iu],
  ['group', /(?:\*{0,2}(?:group|consumer[_ ]?group)\*{0,2})\s*[:：=]\s*\*{0,2}([a-z0-9_.-]+)/iu],
  ['partition', /(?:\*{0,2}(?:mq[_ ]?partition|partition)\*{0,2})\s*[:：=]\s*\*{0,2}([a-z0-9_.:-]+)/iu],
  ['task_id', /(?:任务\s*(?:id)?|task[_ ]?id)\s*[:：=#]\s*([a-z0-9_.:-]+)/iu],
  ['check_index', /check_?index\s*[:：=#]\s*([a-z0-9_.:-]+)/iu],
  ['warn_id', /warn_?id\s*[:：=#]\s*([a-z0-9_.:-]+)/iu],
  ['alarm_rule', /\/alarm\/detail\/(\d{5,})/iu],
]

const fieldWeights: Record<string, number> = {
  service: 2, event: 3, group: 3, partition: 3, task_id: 5, check_index: 5, warn_id: 5, alarm_rule: 4, title: 2,
}

export const extractThreadFeatures = (text: string, raw?: unknown): ThreadFeatures => {
  const rawText = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)
  const combined = `${text}\n${rawText}`
  const fields: Record<string, string> = {}
  for (const [name, pattern] of fieldPatterns) {
    const value = combined.match(pattern)?.[1]?.trim().toLocaleLowerCase()
    if (value) fields[name] = value
  }
  const title = text.split('\n').map(value => value.trim()).find(Boolean)
  if (title) fields.title = normalizeText(title).slice(0, 300)
  const normalizedText = normalizeText(combined)
  return { normalizedText, tokens: tokenize(normalizedText), fields }
}

export const scoreThreadSimilarity = (current: ThreadFeatures, previous: ThreadFeatures, options: { structuredWeight: number; textWeight: number }): ThreadSimilarity => {
  let matchedWeight = 0
  let availableWeight = 0
  const matchedFields: string[] = []
  for (const [name, value] of Object.entries(current.fields)) {
    const weight = fieldWeights[name] ?? 1
    availableWeight += weight
    if (previous.fields[name] && previous.fields[name] === value) {
      matchedWeight += weight
      matchedFields.push(name)
    }
  }
  const structuredScore = availableWeight ? matchedWeight / availableWeight : 0
  const textScore = dice(current.tokens, previous.tokens)
  const uniqueMatch = ['task_id', 'check_index', 'warn_id'].some(name => current.fields[name] && current.fields[name] === previous.fields[name])
  const composite = ['service', 'event', 'group', 'partition'].filter(name => current.fields[name]).every(name => current.fields[name] === previous.fields[name])
    && ['service', 'event', 'group', 'partition'].filter(name => current.fields[name]).length >= 3
  const sameEvent = uniqueMatch || composite
  const totalWeight = Math.max(0.0001, options.structuredWeight + options.textWeight)
  let score = (structuredScore * options.structuredWeight + textScore * options.textWeight) / totalWeight
  if (sameEvent) score = Math.max(score, 0.98)
  return { score: Math.min(1, Math.max(0, score)), structuredScore, textScore, sameEvent, matchedFields }
}

export const normalizeText = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/https?:\/\/\S+/gu, ' ')
  .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
  .replace(/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[ t]\d{1,2}:\d{2}(?::\d{2})?)?\b/gu, ' ')
  .replace(/\b(?:om_|ou_|oc_|logid[:：=]?\s*)[a-z0-9_-]{12,}\b/giu, ' ')
  .replace(/\b\d+(?:\.\d+)?\b/gu, ' ')
  .replace(/[^a-z0-9_.\p{Script=Han}-]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()

const tokenize = (value: string): Set<string> => {
  const words = value.match(/[a-z0-9_.-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []
  const tokens = words.flatMap(word => /[\p{Script=Han}]/u.test(word) && word.length > 3
    ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))]
    : [word])
  return new Set(tokens)
}

const dice = (left: Set<string>, right: Set<string>): number => {
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}
