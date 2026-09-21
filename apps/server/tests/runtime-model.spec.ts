import { describe, expect, it } from 'vitest'
import type { CodexModelOption } from '@codycodeagent/cody-web-core/session'
import { isGovernedReadOnlyCommand, rankSkillCandidates, resolveRuntimeModel } from '../src/runtime.js'

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

  it('uses generic lexical relevance and excludes candidates below the configured threshold', () => {
    const ranked = rankSkillCandidates([
      skill('imagegen', '生成图片'),
      skill('rds', '只读查询线上数据库和业务流水'),
      skill('argos-query', '根据 LogID 和时间查询运行日志'),
    ], '查询线上数据库和运行日志', { minimumScore: 1 })
    expect(ranked.map(item => item.name)).toEqual(expect.arrayContaining(['rds', 'argos-query']))
    expect(ranked.map(item => item.name)).not.toContain('imagegen')
  })

  it('applies Scene boosts and Skill-declared tags without domain rules in code', () => {
    const argos = skill('observability', '通用观测能力')
    const ranked = rankSkillCandidates([argos, skill('imagegen', '生成图片')], '线上问题', {
      tags: new Map([[argos.path, ['argos', '日志']]]), boosts: [{ keyword: 'argos', weight: 20 }], minimumScore: 1,
    })
    expect(ranked).toEqual([argos])
  })

  it('deduplicates skills by name and prefers the installed workspace copy', () => {
    const installed = skill('argos-query', '安装后的日志查询能力')
    const source = { ...skill('argos-query', '源码目录中的日志查询能力'), path: '/workspace/skills/argos-query/SKILL.md' }
    const ranked = rankSkillCandidates([source, installed, skill('rds', '只读数据库查询')], '告警日志排查')
    expect(ranked.filter(item => item.name === 'argos-query')).toEqual([installed])
  })
})

describe('governed command policy', () => {
  it('allows known read-only production queries', () => {
    expect(isGovernedReadOnlyCommand('gdpa-cli run rds --query "select * from budget_manager limit 1"')).toBe(true)
    expect(isGovernedReadOnlyCommand('gdpa-cli run argos --log-id 123')).toBe(true)
  })

  it('blocks write and unclassified commands from bypassing Tool Packages', () => {
    expect(isGovernedReadOnlyCommand('gdpa-cli run bam-query EnsureBudget --vdc lf')).toBe(false)
    expect(isGovernedReadOnlyCommand('gdpa-cli run rds --query "update budget_manager set c_extra=1"')).toBe(false)
    expect(isGovernedReadOnlyCommand('python3 /tmp/call-production-api.py')).toBe(false)
    expect(isGovernedReadOnlyCommand('curl -X POST https://example.com/action')).toBe(false)
  })
})
