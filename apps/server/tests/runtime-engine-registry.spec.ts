import { describe, expect, it, vi } from 'vitest'
import { EngineRegistry } from '../src/runtime-engine-registry.js'

describe('EngineRegistry', () => {
  it('allows retry after failed initialization', async () => {
    const registry = new EngineRegistry()
    await expect(registry.ensure('codex', async () => { throw new Error('unavailable') })).rejects.toThrow('unavailable')
    expect(registry.health().engines.find(engine => engine.kind === 'codex')).toMatchObject({ state: 'failed', error: 'unavailable' })
    expect(registry.health().engines.find(engine => engine.kind === 'traex')).toMatchObject({ state: 'not_started', error: '' })
    const state = { kind: 'codex', host: { ensureInitialized: async () => {}, diagnostics: () => ({ initialized: true }) }, manager: {}, attached: new Set(), attaching: new Map(), tokenTotals: new Map() }
    await expect(registry.ensure('codex', async () => state as never)).resolves.toBe(state)
    expect(registry.health().engines.find(engine => engine.kind === 'codex')?.error).toBe('')
  })

  it('shares concurrent initialization and disposes every initialized engine', async () => {
    const registry = new EngineRegistry()
    const host = { ensureInitialized: vi.fn(async () => {}), dispose: vi.fn(async () => {}), diagnostics: vi.fn(() => ({ initialized: true, lifecycle: 'ready', unavailableReason: '' })) }
    const manager = { dispose: vi.fn(async () => {}) }
    const create = vi.fn(async () => ({ kind: 'codex' as const, host, manager, attached: new Set<string>(), attaching: new Map(), tokenTotals: new Map() }))
    const [first, second] = await Promise.all([registry.ensure('codex', create as never), registry.ensure('codex', create as never)])
    expect(first).toBe(second)
    expect(create).toHaveBeenCalledOnce()
    expect(registry.health().initialized).toBe(true)
    await registry.dispose()
    expect(manager.dispose).toHaveBeenCalledOnce()
    expect(host.dispose).toHaveBeenCalledOnce()
  })
})
