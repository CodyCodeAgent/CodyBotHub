import { describe, expect, it } from 'vitest'
import type { CodexModelOption } from '@codycodeagent/cody-web-core/session'
import { rankSkillCandidates, resolveRuntimeModel } from '../src/runtime.js'

const model = (id: string, efforts: string[], isDefault = false): CodexModelOption => ({
  id, model: id, label: id, description: '', hidden: false, isDefault,
  defaultReasoningEffort: efforts[0] as CodexModelOption['defaultReasoningEffort'],
  supportedReasoningEfforts: efforts as CodexModelOption['supportedReasoningEfforts'],
})

describe('model resolution', () => {
  const models = [model('default-model', ['medium', 'high'], true), model('fast-model', ['low', 'medium'])]

  it('keeps the requested source when the model and effort are supported', () => {
    expect(resolveRuntimeModel({ model: 'fast-model', reasoningEffort: 'low', modelSource: 'bot', reasoningEffortSource: 'scene', fallbackEnabled: true }, models)).toEqual({
      model: 'fast-model', reasoningEffort: 'low', modelSource: 'bot', reasoningEffortSource: 'scene', fallback: false,
    })
  })

  it('falls back to the Codex default and records the fallback', () => {
    expect(resolveRuntimeModel({ model: 'removed-model', reasoningEffort: 'ultra', modelSource: 'platform', reasoningEffortSource: 'platform', fallbackEnabled: true }, models)).toEqual({
      model: 'default-model', reasoningEffort: 'medium', modelSource: 'codex', reasoningEffortSource: 'codex', fallback: true,
    })
  })

  it('rejects an unavailable model when fallback is disabled', () => {
    expect(() => resolveRuntimeModel({ model: 'removed-model', reasoningEffort: '', modelSource: 'scene', reasoningEffortSource: 'codex', fallbackEnabled: false }, models)).toThrow('unavailable')
  })
})

describe('workspace Skill ranking', () => {
  const skill = (name: string, description: string): CodexSkillOption => ({
    name, displayName: name, description, path: `/workspace/.codex/skills/${name}/SKILL.md`, scope: 'repo', enabled: true,
    brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [],
  })

  it('promotes database and log capabilities for an unknown alert investigation', () => {
    const ranked = rankSkillCandidates([
      skill('imagegen', '生成图片'),
      skill('rds', '只读查询线上数据库和业务流水'),
      skill('argos-query', '根据 LogID 和时间查询运行日志'),
    ], '券使用更新时间异常，需要排查实时对账告警根因')
    expect(ranked.slice(0, 2).map(item => item.name)).toEqual(expect.arrayContaining(['rds', 'argos-query']))
  })
})
