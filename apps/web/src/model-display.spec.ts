import { describe, expect, it } from 'vitest'
import { modelCatalogHint, modelDefaultMarker } from './model-display'
import type { ModelCatalog, ModelOption } from './types'

const option = (id: string, isDefault = false): ModelOption => ({
  id, model: id, label: id, description: '', hidden: false, isDefault,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium'],
})

describe('runtime-aware model display', () => {
  it('distinguishes the configured TraeX default from the built-in default', () => {
    const configured = option('configured')
    const builtIn = option('built-in', true)
    const catalog: ModelCatalog = { items: [configured, builtIn], defaultModel: configured.id, defaultReasoningEffort: 'medium' }
    expect(modelDefaultMarker(catalog, configured, 'traex')).toBe('TraeX 当前默认')
    expect(modelDefaultMarker(catalog, builtIn, 'traex')).toBe('TraeX 内置默认')
  })

  it('uses the selected runtime in catalog copy', () => {
    expect(modelCatalogHint('traex')).toContain('TraeX 账号')
    expect(modelCatalogHint('codex')).toContain('Codex 账号')
  })
})
