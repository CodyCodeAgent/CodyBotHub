import { describe, expect, it } from 'vitest'
import { readRuntimeConfig } from '../src/runtime-config.js'

describe('runtime service configuration', () => {
  it('supports a TraeX-only Linux deployment without probing Codex', () => {
    expect(readRuntimeConfig({ CODY_BOT_HUB_DEFAULT_RUNTIME: 'traex', CODY_BOT_HUB_TRAEX_COMMAND: '/srv/ai/bin/traex' }, 'linux')).toEqual({
      initialRuntime: 'traex', commands: { codex: 'codex', traex: '/srv/ai/bin/traex' },
    })
  })
  it('preserves explicit command overrides and ignores blank environment values', () => {
    expect(readRuntimeConfig({ CODY_BOT_HUB_CODEX_COMMAND: ' /srv/codex ', CODEX_CLI_PATH: '/other/codex', CODY_BOT_HUB_TRAEX_COMMAND: ' ' }, 'linux').commands).toEqual({ codex: '/srv/codex', traex: 'traex' })
    expect(readRuntimeConfig({ CODEX_CLI_PATH: '/other/codex' }, 'linux').commands.codex).toBe('/other/codex')
  })
  it('rejects a misspelled initial engine instead of silently selecting Codex', () => {
    expect(() => readRuntimeConfig({ CODY_BOT_HUB_DEFAULT_RUNTIME: 'trae' }, 'linux')).toThrow('must be codex or traex')
    expect(readRuntimeConfig({}, 'linux').initialRuntime).toBe('')
  })
})
