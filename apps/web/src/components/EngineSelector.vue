<script setup lang="ts">
import { Check, Cpu } from 'lucide-vue-next'
import { useId } from 'vue'
import type { AgentRuntimeKind } from '../types'
defineProps<{ modelValue: AgentRuntimeKind }>()
const emit = defineEmits<{ 'update:modelValue': [value: AgentRuntimeKind] }>()
const name = useId()
const engines: Array<{ kind: AgentRuntimeKind; label: string; description: string }> = [
  { kind: 'codex', label: 'Codex', description: '使用 Codex 的模型与会话' },
  { kind: 'traex', label: 'TraeX', description: '使用 TraeX 的模型与会话' },
]
</script>
<template>
  <fieldset class="engine-picker">
    <legend>AI 引擎</legend>
    <div class="engine-picker-options">
      <label v-for="engine in engines" :key="engine.kind" class="engine-choice" :class="{ selected: modelValue === engine.kind }">
        <input :name="name" type="radio" :value="engine.kind" :checked="modelValue === engine.kind" @change="emit('update:modelValue', engine.kind)" />
        <Cpu :size="19" aria-hidden="true" /><span><strong>{{ engine.label }}</strong><small>{{ engine.description }}</small></span><Check v-if="modelValue === engine.kind" :size="17" aria-hidden="true" />
      </label>
    </div>
    <p>模型与会话按引擎独立管理。<RouterLink to="/engines">管理平台引擎默认值</RouterLink></p>
  </fieldset>
</template>
<style scoped>
.engine-picker { border:0; padding:0; margin:0 0 20px; min-width:0 }
legend { font-size:13px; font-weight:600; margin-bottom:10px }
.engine-picker-options { display:grid; grid-template-columns:1fr 1fr; gap:12px }
.engine-choice { position:relative; display:flex; align-items:center; gap:12px; min-height:76px; padding:14px; border:1px solid var(--border-strong); border-radius:12px; background:var(--surface-raised); cursor:pointer; transition:border-color .18s,background .18s }
.engine-choice.selected { border-color:var(--green); background:color-mix(in srgb,var(--green) 6%,var(--surface)) }
.engine-choice:focus-within { outline:2px solid var(--green); outline-offset:3px }
.engine-choice input { position:absolute; opacity:0; width:1px; height:1px }
.engine-choice span { flex:1 }
.engine-choice strong,.engine-choice small { display:block }
.engine-choice small,p { margin:5px 0 0; font-size:12px; line-height:1.6; color:var(--text-soft) }
p { margin-top:10px } p a { text-decoration:underline; text-underline-offset:3px }
@media(max-width:480px) { .engine-picker-options { grid-template-columns:1fr } }
@media(prefers-reduced-motion:reduce) { .engine-choice { transition:none } }
</style>
