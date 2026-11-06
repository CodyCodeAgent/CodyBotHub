import type { AgentRuntimeKind, ModelCatalog, ModelOption } from './types'

export const runtimeDisplayName = (kind: AgentRuntimeKind): string => kind === 'traex' ? 'TraeX' : 'Codex'

export const modelDefaultMarker = (catalog: ModelCatalog, item: ModelOption, kind: AgentRuntimeKind): string => {
  const effectiveDefault = catalog.defaultModel && (item.id === catalog.defaultModel || item.model === catalog.defaultModel)
  if (effectiveDefault) return `${runtimeDisplayName(kind)} 当前默认`
  if (item.isDefault) return `${runtimeDisplayName(kind)} 内置默认`
  return ''
}

export const modelCatalogHint = (kind: AgentRuntimeKind): string => `模型列表来自当前服务器的 ${runtimeDisplayName(kind)} 账号。`
