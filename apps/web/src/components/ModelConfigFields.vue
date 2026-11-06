<script setup lang="ts">
import { computed, useId } from 'vue'
import { modelCatalogHint, modelDefaultMarker } from '../model-display'
import type { AgentRuntimeKind, ModelCatalog } from '../types'

const props = withDefaults(defineProps<{ catalog: ModelCatalog; model: string; reasoningEffort: string; inheritLabel: string; inheritedModel?: string; runtimeKind?: AgentRuntimeKind; disabled?: boolean }>(), { runtimeKind: 'codex' })
const fieldId = useId()
const effectiveModel = computed(() => props.model || props.inheritedModel || props.catalog.defaultModel)
const emit = defineEmits<{ 'update:model': [value: string]; 'update:reasoningEffort': [value: string] }>()
const selected = computed(() => {
  const value = props.model || props.inheritedModel || props.catalog.defaultModel
  return props.catalog.items.find(item => item.id === value || item.model === value)
})
const efforts = computed(() => selected.value?.supportedReasoningEfforts ?? [])
const changeModel = (value: string) => {
  emit('update:model', value)
  const option = props.catalog.items.find(item => item.id === value || item.model === value)
  if (props.reasoningEffort && option?.supportedReasoningEfforts.length && !option.supportedReasoningEfforts.includes(props.reasoningEffort)) emit('update:reasoningEffort', '')
}
</script>

<template>
  <div class="model-configuration"><div class="field-grid">
    <div class="field"><label :for="`${fieldId}-model`">模型</label><select :id="`${fieldId}-model`" :disabled="disabled" :value="model" @change="changeModel(($event.target as HTMLSelectElement).value)"><option value="">{{ inheritLabel }}</option><option v-if="model && !catalog.items.some(item => item.id === model || item.model === model)" :value="model">{{ model }}（已配置）</option><option v-for="item in catalog.items" :key="item.id" :value="item.id">{{ item.label || item.id }}{{ modelDefaultMarker(catalog, item, runtimeKind) ? `（${modelDefaultMarker(catalog, item, runtimeKind)}）` : '' }}</option></select><small>{{ selected?.description || modelCatalogHint(runtimeKind) }}</small></div>
    <div class="field"><label :for="`${fieldId}-effort`">推理强度</label><select :id="`${fieldId}-effort`" :disabled="disabled" :value="reasoningEffort" @change="emit('update:reasoningEffort', ($event.target as HTMLSelectElement).value)"><option value="">继承上一级 / 模型默认</option><option v-if="reasoningEffort && !efforts.includes(reasoningEffort)" :value="reasoningEffort">{{ reasoningEffort }}（已配置）</option><option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option></select><small>可选值随当前生效模型变化。</small></div>
  </div><div class="model-effective"><span>{{ runtimeKind === 'traex' ? 'TraeX' : 'Codex' }}</span><div><small>{{ model ? '单独指定模型' : inheritLabel }}</small><strong>{{ effectiveModel || '由引擎账户决定' }}</strong></div></div></div>
</template>
<style scoped>
.model-effective { display:flex; gap:12px; align-items:center; border:1px solid var(--border); border-radius:9px; padding:12px 14px; margin:0 0 16px; background:var(--surface-raised); min-width:0 }
.model-effective>span { padding:4px 8px; border-radius:6px; border:1px solid var(--border-strong); font-size:12px; font-weight:600 }
.model-effective div { min-width:0 }
.model-effective small,.model-effective strong { display:block; line-height:1.6; overflow-wrap:anywhere }
.model-effective small { color:var(--text-soft); font-size:12px }
.model-effective strong { font-size:13px }
</style>
