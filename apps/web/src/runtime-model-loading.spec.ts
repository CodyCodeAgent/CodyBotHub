import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { useRuntimeModels } from './composables/useRuntimeModels'
import type { ModelCatalog } from './types'

const result = (name: string): ModelCatalog => ({ items: [], defaultModel: name, defaultReasoningEffort: '' })
afterEach(() => vi.restoreAllMocks())

describe('isolated runtime model loading', () => {
  it('ignores a slow response from the engine that was previously selected', async () => {
    let finish!: (value: ModelCatalog) => void
    vi.spyOn(api, 'models').mockImplementation(kind => kind === 'codex' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(result('traex-default')))
    const state = useRuntimeModels()
    const old = state.load('codex')
    await state.load('traex')
    finish(result('codex-default')); await old
    expect(state.catalog.value.defaultModel).toBe('traex-default')
    expect(state.loading.value).toBe(false)
  })

  it('clears the previous engine catalog immediately, including when the next engine fails', async () => {
    vi.spyOn(api, 'models').mockResolvedValueOnce(result('traex-default')).mockRejectedValueOnce(new Error('not installed'))
    const state = useRuntimeModels()
    await state.load('traex')
    const failed = state.load('codex')
    expect(state.catalog.value.defaultModel).toBe('')
    await failed
    expect(state.error.value).toContain('Codex')
    expect(state.catalog.value.items).toEqual([])
  })
})
