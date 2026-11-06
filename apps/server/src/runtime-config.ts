import { existsSync } from 'node:fs'
import type { AgentRuntimeKind } from './types.js'

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const value = (key: string) => env[key]?.trim() || ''
  const initialRuntime = value('CODY_BOT_HUB_DEFAULT_RUNTIME')
  if (initialRuntime && initialRuntime !== 'codex' && initialRuntime !== 'traex') throw new Error('CODY_BOT_HUB_DEFAULT_RUNTIME must be codex or traex')
  const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex'
  return {
    commands: {
      codex: value('CODY_BOT_HUB_CODEX_COMMAND') || value('CODEX_CLI_PATH') || (platform === 'darwin' && existsSync(bundledCodex) ? bundledCodex : 'codex'),
      traex: value('CODY_BOT_HUB_TRAEX_COMMAND') || 'traex',
    },
    initialRuntime: initialRuntime as AgentRuntimeKind | '',
  }
}
