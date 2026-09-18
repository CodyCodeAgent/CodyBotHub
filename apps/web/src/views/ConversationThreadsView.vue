<script setup lang="ts">
import { ChevronLeft, ChevronRight, GitBranch, RefreshCw, Search, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { Bot, ConversationThread } from '../types'

const pageSize = 50
const items = ref<ConversationThread[]>([])
const bots = ref<Bot[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const error = ref('')
const selected = ref<ConversationThread | null>(null)
const filters = reactive({ botId: '', query: '' })
const page = computed(() => Math.floor(offset.value / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const result = await api.conversationThreads({ ...filters, limit: pageSize, offset: offset.value })
    items.value = result.items
    total.value = result.total
  } catch (value) {
    error.value = value instanceof Error ? value.message : '读取失败'
  } finally { loading.value = false }
}
onMounted(async () => { bots.value = await api.bots(); await load() })
const search = async () => { offset.value = 0; await load() }
const move = async (delta: number) => { offset.value = Math.max(0, offset.value + delta * pageSize); await load() }
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '—'
const modeLabel = (item: ConversationThread) => item.conversationMode === 'topic' ? '按话题' : '按群'
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Conversation bindings</p><h1>会话线程</h1><p class="page-description">群或话题先绑定到 Thread Channel；同一场景中的相似事件可以共享一个 Channel 和 Codex Thread。场景、工作区与技能包仍按每条消息动态计算。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button></header>
    <section class="route-rules" aria-label="线程映射规则">
      <div class="route-rule"><strong>会话边界</strong><code>Bot + 群 / 话题 → 会话绑定</code></div>
      <div class="route-rule"><strong>经验复用</strong><code>多个会话绑定 → Thread Channel</code></div>
      <div class="route-rule"><strong>串行执行</strong><code>Thread Channel → Codex Thread + 队列</code></div>
    </section>
    <form class="filter-bar thread-filter" @submit.prevent="search">
      <select v-model="filters.botId" aria-label="Bot"><option value="">全部 Bot</option><option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.name }}</option></select>
      <div class="filter-search"><Search :size="15" /><input v-model.trim="filters.query" placeholder="搜索 Thread、群名、群 ID、话题…" /></div>
      <button class="button">查询</button>
    </form>
    <div v-if="error" class="error-banner" role="alert" style="margin-bottom:16px">{{ error }}</div>
    <section class="panel"><div class="panel-header"><h2>线程映射</h2><span class="badge gray">{{ total }} 条</span></div>
      <div v-if="!loading && !items.length" class="empty"><GitBranch :size="32" /><strong>还没有会话线程</strong><span>Bot 第一次处理飞书消息后，映射会出现在这里。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>最后活跃</th><th>Bot / 会话模式</th><th>群 / 话题</th><th>Thread Channel / Codex Thread</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" tabindex="0" @click="selected = item" @keydown.enter="selected = item"><td class="mono">{{ formatTime(item.updatedAt) }}</td><td><div class="entity-title">{{ item.botName }}</div><div class="entity-subtitle"><span class="badge gray">{{ modeLabel(item) }}</span></div></td><td><div class="entity-title">{{ item.chatName || item.chatId }}</div><div v-if="item.chatName" class="entity-subtitle mono">{{ item.chatId }}</div><div class="entity-subtitle mono">topic: {{ item.topicId || '—' }}</div></td><td><code class="thread-id">channel: {{ item.threadChannelId }}</code><div class="entity-subtitle mono">thread: {{ item.coreThreadId || '尚未创建' }}</div></td></tr></tbody></table></div>
      <footer class="pagination"><span>第 {{ page }} / {{ pageCount }} 页</span><div><button class="ghost-button compact" :disabled="offset === 0 || loading" @click="move(-1)"><ChevronLeft :size="15" />上一页</button><button class="ghost-button compact" :disabled="offset + pageSize >= total || loading" @click="move(1)">下一页<ChevronRight :size="15" /></button></div></footer>
    </section>
    <div v-if="selected" class="dialog-backdrop" @mousedown.self="selected = null"><section class="dialog large"><header class="dialog-header"><div><h2>会话线程详情</h2><p>{{ selected.botName }} · {{ modeLabel(selected) }}</p></div><button class="icon-button" aria-label="关闭" @click="selected = null"><X :size="19" /></button></header><div class="dialog-body">
      <div class="detail-grid"><div><span>Bot</span><strong>{{ selected.botName }}</strong></div><div><span>会话模式</span><strong>{{ modeLabel(selected) }}</strong></div><div><span>群</span><strong>{{ selected.chatName || selected.chatId }}</strong></div><div><span>话题</span><strong>{{ selected.topicId || '—' }}</strong></div><div><span>最后活跃</span><strong>{{ formatTime(selected.updatedAt) }}</strong></div><div><span>群类型</span><strong>{{ selected.chatMode || '—' }}</strong></div></div>
      <div class="record-content"><h3>Thread Channel ID</h3><pre>{{ selected.threadChannelId }}</pre></div><div class="record-content"><h3>Codex Thread ID</h3><pre>{{ selected.coreThreadId || '尚未创建' }}</pre></div>
      <div class="record-content"><h3>内部会话 Key</h3><pre>{{ selected.id }}</pre></div>
      <div class="record-meta mono">bot: {{ selected.botId }}<br />chat: {{ selected.chatId }}<br />topic: {{ selected.topicId || '—' }}<br />created: {{ formatTime(selected.createdAt) }}</div>
    </div></section></div>
  </div>
</template>
