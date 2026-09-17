<script setup lang="ts">
import { Save, Settings } from 'lucide-vue-next'
import { onMounted, ref } from 'vue'
import { api } from '../api'
const basePrompt = ref(''), saving = ref(false), saved = ref(false), error = ref('')
onMounted(async () => { basePrompt.value = (await api.settings()).basePrompt })
const save = async () => { saving.value = true; saved.value = false; error.value = ''; try { await api.saveSettings(basePrompt.value); saved.value = true; setTimeout(() => { saved.value = false }, 1800) } catch (e) { error.value = e instanceof Error ? e.message : '保存失败' } finally { saving.value = false } }
</script>
<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Global policy</p><h1>平台设置</h1><p class="page-description">平台基础 Prompt 会注入到每一次 Codex 会话，是所有工作区、Bot 和场景共同遵守的顶层规则。</p></div></header>
    <form class="panel" @submit.prevent="save"><div class="panel-header"><h2><Settings :size="16" style="vertical-align:-3px;margin-right:8px" />基础 Prompt</h2><span class="badge green">第 1 层</span></div><div class="dialog-body"><div class="field"><label for="base-prompt">平台基础 Prompt</label><textarea id="base-prompt" v-model="basePrompt" rows="16" placeholder="定义平台级安全边界、统一行为和输出规范…" /><small>最终顺序：平台基础 → 工作区 → Bot → 场景 → 技能包。</small></div><div v-if="error" class="error-banner" role="alert">{{ error }}</div><div v-if="saved" class="notice" role="status">设置已保存，新建和后续消息会使用最新 Prompt。</div></div><footer class="dialog-actions"><button class="button" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : '保存设置' }}</button></footer></form>
  </div>
</template>
