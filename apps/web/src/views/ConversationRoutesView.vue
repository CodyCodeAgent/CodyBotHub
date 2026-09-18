<script setup lang="ts">
import { ChevronLeft, ChevronRight, GitBranch, RefreshCw, Search, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { Bot, ConversationRoute, Scene } from '../types'

const pageSize = 50
const items = ref<ConversationRoute[]>([])
const bots = ref<Bot[]>([])
const scenes = ref<Scene[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const error = ref('')
const selected = ref<ConversationRoute | null>(null)
const filters = reactive({ botId: '', sceneId: '', query: '' })
const page = computed(() => Math.floor(offset.value / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const availableScenes = computed(() => filters.botId ? scenes.value.filter(item => item.botId === filters.botId) : scenes.value)

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const result = await api.conversationRoutes({ ...filters, limit: pageSize, offset: offset.value })
    items.value = result.items
    total.value = result.total
  } catch (value) {
    error.value = value instanceof Error ? value.message : '读取失败'
  } finally { loading.value = false }
}
onMounted(async () => {
  ;[bots.value, scenes.value] = await Promise.all([api.bots(), api.scenes()])
  await load()
})
const search = async () => { offset.value = 0; await load() }
const move = async (delta: number) => { offset.value = Math.max(0, offset.value + delta * pageSize); await load() }
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '—'
const routeType = (item: ConversationRoute) => item.sceneId ? '场景路由' : item.topicId ? '默认话题' : '默认路由'
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Conversation threads</p><h1>会话线程</h1><p class="page-description">查看飞书消息路由与 CodyWebCore Codex Thread 的实际对应关系，确认同一群后续消息会复用哪个上下文。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button></header>
    <section class="route-rules" aria-label="线程映射规则">
      <div class="route-rule"><strong>有场景</strong><code>Bot + 场景 + 群 → Thread</code></div>
      <div class="route-rule"><strong>无场景</strong><code>Bot + 群 → Thread</code></div>
      <div class="route-rule"><strong>无场景且话题模式</strong><code>Bot + 群 + 话题 → Thread</code></div>
    </section>
    <form class="filter-bar thread-filter" @submit.prevent="search">
      <select v-model="filters.botId" aria-label="Bot" @change="filters.sceneId = ''"><option value="">全部 Bot</option><option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.name }}</option></select>
      <select v-model="filters.sceneId" aria-label="场景"><option value="">全部场景</option><option v-for="scene in availableScenes" :key="scene.id" :value="scene.id">{{ scene.name }}</option></select>
      <div class="filter-search"><Search :size="15" /><input v-model.trim="filters.query" placeholder="搜索 Thread、群、话题、路由 ID…" /></div>
      <button class="button">查询</button>
    </form>
    <div v-if="error" class="error-banner" role="alert" style="margin-bottom:16px">{{ error }}</div>
    <section class="panel"><div class="panel-header"><h2>线程映射</h2><span class="badge gray">{{ total }} 条</span></div>
      <div v-if="!loading && !items.length" class="empty"><GitBranch :size="32" /><strong>还没有会话线程</strong><span>Bot 第一次处理飞书消息后，映射会出现在这里。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>最后活跃</th><th>Bot / 路由</th><th>群 / 话题</th><th>工作区</th><th>Codex Thread</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" tabindex="0" @click="selected = item" @keydown.enter="selected = item"><td class="mono">{{ formatTime(item.updatedAt) }}</td><td><div class="entity-title">{{ item.botName }}</div><div class="entity-subtitle"><span class="badge" :class="item.sceneId ? '' : 'gray'">{{ routeType(item) }}</span> {{ item.sceneName }}</div></td><td><div class="mono">{{ item.chatId }}</div><div class="entity-subtitle mono">topic: {{ item.topicId || '—' }}</div></td><td><div>{{ item.workspaceName }}</div><div class="entity-subtitle mono">{{ item.workspaceId }}</div></td><td><code class="thread-id">{{ item.coreThreadId || '尚未创建' }}</code></td></tr></tbody></table></div>
      <footer class="pagination"><span>第 {{ page }} / {{ pageCount }} 页</span><div><button class="ghost-button compact" :disabled="offset === 0 || loading" @click="move(-1)"><ChevronLeft :size="15" />上一页</button><button class="ghost-button compact" :disabled="offset + pageSize >= total || loading" @click="move(1)">下一页<ChevronRight :size="15" /></button></div></footer>
    </section>
    <div v-if="selected" class="dialog-backdrop" @mousedown.self="selected = null"><section class="dialog large"><header class="dialog-header"><div><h2>会话线程详情</h2><p>{{ selected.botName }} · {{ routeType(selected) }}</p></div><button class="icon-button" aria-label="关闭" @click="selected = null"><X :size="19" /></button></header><div class="dialog-body">
      <div class="detail-grid"><div><span>Bot</span><strong>{{ selected.botName }}</strong></div><div><span>场景</span><strong>{{ selected.sceneName || '默认路由' }}</strong></div><div><span>工作区</span><strong>{{ selected.workspaceName }}</strong></div><div><span>首次创建</span><strong>{{ formatTime(selected.createdAt) }}</strong></div><div><span>最后活跃</span><strong>{{ formatTime(selected.updatedAt) }}</strong></div><div><span>路由类型</span><strong>{{ routeType(selected) }}</strong></div></div>
      <div class="record-content"><h3>Codex Thread ID</h3><pre>{{ selected.coreThreadId || '尚未创建' }}</pre></div>
      <div class="record-content"><h3>内部路由 Key</h3><pre>{{ selected.id }}</pre></div>
      <div class="record-meta mono">bot: {{ selected.botId }}<br />scene: {{ selected.sceneId || '—' }}<br />workspace: {{ selected.workspaceId }}<br />chat: {{ selected.chatId }}<br />topic: {{ selected.topicId || '—' }}</div>
    </div></section></div>
  </div>
</template>
