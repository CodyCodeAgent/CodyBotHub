import path from 'node:path'
import type { CodexModelOption, CodexSkillOption } from '@codycodeagent/cody-web-core/session'
import { relevance } from './resources.js'
import type { ModelConfigSource, ResolvedModelConfig } from './types.js'

export type RuntimeResolvedModel = {
  model: string
  reasoningEffort: string
  modelSource: ModelConfigSource
  reasoningEffortSource: ModelConfigSource
  fallback: boolean
}

export const resolveRuntimeModel = (
  requested: ResolvedModelConfig,
  models: CodexModelOption[],
  configuredModel = '',
  configuredEffort = '',
  runtimeDefaultSource: ModelConfigSource = 'codex'
): RuntimeResolvedModel => {
  const visible = models.filter(item => !item.hidden)
  const findModel = (value: string) => models.find(item => item.id === value || item.model === value)
  const accountDefault = findModel(configuredModel) ?? models.find(item => item.isDefault) ?? visible[0] ?? models[0]
  const selected = requested.model ? findModel(requested.model) : accountDefault
  let fallback = false
  let modelSource = requested.modelSource
  if (requested.model && !selected) {
    if (!requested.fallbackEnabled) throw new Error(`Model ${requested.model} is unavailable for the current Codex account`)
    fallback = true
    modelSource = runtimeDefaultSource
  }
  const actual = selected ?? accountDefault
  const model = actual?.id || actual?.model || requested.model || configuredModel
  let reasoningEffort = requested.reasoningEffort || configuredEffort || actual?.defaultReasoningEffort || ''
  let reasoningEffortSource: ModelConfigSource = requested.reasoningEffort
    ? requested.reasoningEffortSource
    : runtimeDefaultSource
  if (
    reasoningEffort &&
    actual?.supportedReasoningEfforts.length &&
    !actual.supportedReasoningEfforts.includes(reasoningEffort as CodexModelOption['defaultReasoningEffort'])
  ) {
    if (!requested.fallbackEnabled) throw new Error(`Reasoning effort ${reasoningEffort} is unsupported by model ${model}`)
    reasoningEffort = actual.defaultReasoningEffort || ''
    reasoningEffortSource = runtimeDefaultSource
    fallback = true
  }
  return { model, reasoningEffort, modelSource, reasoningEffortSource, fallback }
}

export const rankSkillCandidates = (
  skills: CodexSkillOption[],
  query: string,
  options: {
    tags?: Map<string, string[]>
    boosts?: Array<{ keyword: string; weight: number }>
    minimumScore?: number
  } = {}
): CodexSkillOption[] => {
  const normalized = query.toLocaleLowerCase()
  const scored = skills.map(skill => {
    const searchable = `${skill.name} ${skill.displayName} ${skill.description} ${skill.path} ${(options.tags?.get(skill.path) ?? []).join(' ')}`
    const searchableNormalized = searchable.toLocaleLowerCase()
    let score = relevance(searchable, normalized)
    if (normalized.includes(skill.name.toLocaleLowerCase())) score += 30
    for (const boost of options.boosts ?? []) {
      if (searchableNormalized.includes(boost.keyword.toLocaleLowerCase())) score += boost.weight
    }
    const sourcePriority = skill.path.includes(`${path.sep}.codex${path.sep}skills${path.sep}`)
      ? 3
      : skill.path.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
        ? 2
        : 1
    return { skill, score, sourcePriority }
  })
  const ranked = scored
    .filter(item => item.score >= (options.minimumScore ?? 0))
    .sort((left, right) =>
      right.score - left.score ||
      right.sourcePriority - left.sourcePriority ||
      left.skill.name.localeCompare(right.skill.name, 'zh-CN')
    )
  const unique = new Map<string, CodexSkillOption>()
  for (const item of ranked) {
    const key = item.skill.name.trim().toLocaleLowerCase()
    if (!unique.has(key)) unique.set(key, item.skill)
  }
  return [...unique.values()]
}
