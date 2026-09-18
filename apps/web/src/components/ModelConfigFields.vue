<script setup lang="ts">
import { computed } from 'vue'
import type { ModelCatalog } from '../types'

const props = defineProps<{ catalog: ModelCatalog; model: string; reasoningEffort: string; inheritLabel: string; inheritedModel?: string }>()
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
  <div class="field-grid">
    <div class="field"><label>模型</label><select :value="model" @change="changeModel(($event.target as HTMLSelectElement).value)"><option value="">{{ inheritLabel }}</option><option v-for="item in catalog.items" :key="item.id" :value="item.id">{{ item.label || item.id }}{{ item.isDefault ? '（Codex 默认）' : '' }}</option></select><small>{{ selected?.description || '模型列表来自当前服务器的 Codex 账号。' }}</small></div>
    <div class="field"><label>推理强度</label><select :value="reasoningEffort" @change="emit('update:reasoningEffort', ($event.target as HTMLSelectElement).value)"><option value="">继承上一级 / 模型默认</option><option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option></select><small>可选值随当前生效模型变化。</small></div>
  </div>
</template>
