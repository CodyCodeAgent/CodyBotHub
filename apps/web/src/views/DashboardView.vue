<script setup lang="ts">
import { Bot, Boxes, Layers3, MessageSquareText, Puzzle, Workflow } from 'lucide-vue-next'
import { onMounted, ref } from 'vue'
import { api } from '../api'
const stats = ref({ workspaces: 0, bots: 0, scenes: 0, skillPackages: 0, messageLogs: 0 })
onMounted(async () => { stats.value = await api.dashboard() })
const metrics = [
  { key: 'workspaces' as const, label: '工作区', icon: Boxes },
  { key: 'bots' as const, label: '飞书 Bot', icon: Bot },
  { key: 'scenes' as const, label: '启用场景', icon: Workflow },
  { key: 'skillPackages' as const, label: '技能包', icon: Puzzle },
  { key: 'messageLogs' as const, label: '消息记录', icon: MessageSquareText },
]
</script>
<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Control Center</p><h1>运行总览</h1><p class="page-description">从飞书入口到 Codex 会话，用一个清晰的配置链路管理所有 Bot。</p></div></header>
    <section class="metric-grid" aria-label="资源统计">
      <article v-for="metric in metrics" :key="metric.key" class="metric"><div class="metric-icon"><component :is="metric.icon" :size="18" /></div><strong>{{ stats[metric.key] }}</strong><span>{{ metric.label }}</span></article>
    </section>
    <section class="callout">
      <div><p class="eyebrow">Prompt composition</p><h2>每次运行都能解释上下文来源</h2><p class="page-description">平台按固定顺序合并 Prompt。场景和技能包只增加当前消息需要的上下文，工作区仍是文件与会话的边界。</p></div>
      <div class="prompt-stack"><div class="prompt-layer"><Layers3 :size="12" /> 平台基础 Prompt</div><div class="prompt-layer">+ 工作区 Prompt</div><div class="prompt-layer">+ Bot Prompt</div><div class="prompt-layer">+ 场景 Prompt</div><div class="prompt-layer">+ 技能包 Prompt</div></div>
    </section>
  </div>
</template>
