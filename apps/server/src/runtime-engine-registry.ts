import type { AppServerHost } from '@codycodeagent/cody-web-core/runtime'
import type { CodexSessionManager } from '@codycodeagent/cody-web-core/session'
import type { AgentRuntimeKind } from './types.js'
import type { TaskTokenUsage } from './task-statistics.js'

export type EngineState = {
  kind: AgentRuntimeKind
  host: AppServerHost
  manager: CodexSessionManager
  attached: Set<string>
  attaching: Map<string, Promise<void>>
  tokenTotals: Map<string, TaskTokenUsage>
}

export class EngineRegistry {
  private readonly states = new Map<AgentRuntimeKind, EngineState>()
  private readonly initializing = new Map<AgentRuntimeKind, Promise<EngineState>>()
  private readonly failures = new Map<AgentRuntimeKind, string>()

  values(): IterableIterator<EngineState> { return this.states.values() }

  async ensure(kind: AgentRuntimeKind, create: () => Promise<EngineState>): Promise<EngineState> {
    const existing = this.states.get(kind)
    if (existing) {
      try { await existing.host.ensureInitialized(); this.failures.delete(kind) }
      catch (error) { this.failures.set(kind, error instanceof Error ? error.message : String(error)); throw error }
      return existing
    }
    const pending = this.initializing.get(kind)
    if (pending) return pending
    const created = create().then(state => {
      this.states.set(kind, state)
      this.failures.delete(kind)
      return state
    }).catch(error => {
      this.failures.set(kind, error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => { this.initializing.delete(kind) })
    this.initializing.set(kind, created)
    return created
  }

  health(): { initialized: boolean; attachedChannels: number; engines: Array<{ kind: AgentRuntimeKind; label: string; initialized: boolean; attachedChannels: number; state: string; error: string }> } {
    const kinds: AgentRuntimeKind[] = ['codex', 'traex']
    const engines = kinds.map(kind => {
      const engine = this.states.get(kind)
      const diagnostics = engine?.host.diagnostics()
      const failure = this.failures.get(kind) || diagnostics?.unavailableReason || ''
      return { kind, label: kind === 'traex' ? 'TraeX' : 'Codex', initialized: Boolean(engine && diagnostics?.initialized), attachedChannels: engine?.attached.size ?? 0, state: this.initializing.has(kind) ? 'initializing' : failure ? 'failed' : diagnostics?.lifecycle ?? 'not_started', error: failure }
    })
    return { initialized: engines.some(item => item.initialized), attachedChannels: engines.reduce((sum, item) => sum + item.attachedChannels, 0), engines }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.initializing.values()])
    await Promise.all([...this.states.values()].map(async engine => {
      await engine.manager.dispose()
      await engine.host.dispose()
    }))
    this.states.clear()
    this.failures.clear()
  }
}
