import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { api } from '../api'
import type { AgentRuntimeKind, ModelCatalog } from '../types'

const emptyCatalog = (): ModelCatalog => ({ items: [], defaultModel: '', defaultReasoningEffort: '' })

export function useRuntimeModels() {
  const catalog = ref<ModelCatalog>(emptyCatalog()), loading = ref(false), error = ref('')
  let revision = 0
  if (getCurrentScope()) onScopeDispose(() => { revision++ })
  async function load(kind: AgentRuntimeKind): Promise<boolean> {
    const request = ++revision
    catalog.value = emptyCatalog(); loading.value = true; error.value = ''
    try {
      const result = await api.models(kind)
      if (request !== revision) return false
      catalog.value = result
    } catch (cause) {
      if (request !== revision) return false
      error.value = `${kind === 'traex' ? 'TraeX' : 'Codex'} 运行时暂不可用：${cause instanceof Error ? cause.message : '无法读取模型'}`
    } finally { if (request === revision) loading.value = false }
    return true
  }
  return { catalog, loading, error, load }
}
