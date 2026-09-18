import { describe, expect, it } from 'vitest'
import type { CodexModelOption } from '@codycodeagent/cody-web-core/session'
import { resolveRuntimeModel } from '../src/runtime.js'

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
