import type { AgentRuntimeKind, ResolvedRoute } from './types.js'

// Keep the Bot's stored configuration separate from the engine selected for a turn.
export const routeRuntimeKind = (route: Pick<ResolvedRoute, 'bot' | 'runtimeKind'>): AgentRuntimeKind => route.runtimeKind ?? route.bot.runtimeKind
