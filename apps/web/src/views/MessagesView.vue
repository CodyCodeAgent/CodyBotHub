<script setup lang="ts">
import { ChevronLeft, ChevronRight, MessageSquareText, RefreshCw, Search, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { Bot, MessageLog, Scene } from '../types'

const pageSize = 50
const items = ref<MessageLog[]>([])
const bots = ref<Bot[]>([])
const scenes = ref<Scene[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const error = ref('')
const selected = ref<MessageLog | null>(null)
const filters = reactive({ botId: '', sceneId: '', status: '', query: '' })
const page = computed(() => Math.floor(offset.value / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const result = await api.messageLogs({ ...filters, limit: pageSize, offset: offset.value })
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
const formatDuration = (value: number | null) => value === null ? '处理中' : value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`
const excerpt = (value: string) => value.replace(/\s+/gu, ' ').trim().slice(0, 120) || '（空内容）'
const statusLabel = (value: MessageLog['status']) => value === 'completed' ? '已完成' : value === 'failed' ? '失败' : '处理中'
const sourceLabel = (value: MessageLog['modelSource']) => ({ scene: '场景', bot: 'Bot', platform: '平台', codex: 'Codex 默认' }[value])
const modeLabel = (value: MessageLog['investigation']['mode']) => ({ package_only: '仅技能包', package_first: '技能包优先', mixed: '混合检索', workspace: '工作区自主选择' }[value])
const threadRouteLabel = (value: MessageLog['threadRouting']['type']) => ({ fixed: '会话固定', new: '新建 Thread', reused: '复用历史 Thread', experience: '引用历史经验' }[value])
const prettyJson = (value: unknown) => { try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Conversation audit</p><h1>消息记录</h1><p class="page-description">保留每次处理的入站内容、回复、路由快照与耗时，用于效果复盘和故障排查。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button></header>
    <form class="filter-bar" @submit.prevent="search">
      <select v-model="filters.botId" aria-label="Bot"><option value="">全部 Bot</option><option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.name }}</option></select>
      <select v-model="filters.sceneId" aria-label="场景"><option value="">全部场景</option><option v-for="scene in scenes" :key="scene.id" :value="scene.id">{{ scene.name }}</option></select>
      <select v-model="filters.status" aria-label="状态"><option value="">全部状态</option><option value="processing">处理中</option><option value="completed">已完成</option><option value="failed">失败</option></select>
      <div class="filter-search"><Search :size="15" /><input v-model.trim="filters.query" placeholder="搜索记录、消息、Channel、Thread、内容或回复…" /></div>
      <button class="button">查询</button>
    </form>
    <div v-if="error" class="error-banner" role="alert" style="margin-bottom:16px">{{ error }}</div>
    <section class="panel"><div class="panel-header"><h2>处理记录</h2><span class="badge gray">{{ total }} 条</span></div>
      <div v-if="!loading && !items.length" class="empty"><MessageSquareText :size="32" /><strong>还没有消息记录</strong><span>Bot 开始处理飞书消息后，记录会出现在这里。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>时间</th><th>消息 / Codex Thread</th><th>Bot / 路由</th><th>状态</th><th>耗时</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" tabindex="0" @click="selected = item" @keydown.enter="selected = item"><td class="mono">{{ formatTime(item.receivedAt) }}</td><td><div class="entity-title">{{ excerpt(item.inboundContent) }}</div><div class="entity-subtitle">{{ item.messageType }} · message: {{ item.messageId }}</div><div class="entity-subtitle mono">log: {{ item.id }}</div><div class="entity-subtitle mono">channel: {{ item.threadChannelId || '—' }}</div><div class="entity-subtitle mono">thread: {{ item.coreThreadId || '—' }}</div></td><td><div>{{ item.botName }}</div><div class="entity-subtitle">{{ item.sceneName || '默认路由' }} · {{ item.workspaceName }}</div><div v-if="item.model" class="entity-subtitle mono">{{ item.model }}<template v-if="item.reasoningEffort"> · {{ item.reasoningEffort }}</template></div></td><td><span class="badge" :class="item.status === 'completed' ? 'green' : item.status === 'failed' ? 'red' : 'gray'">{{ statusLabel(item.status) }}</span></td><td class="mono">{{ formatDuration(item.durationMs) }}</td></tr></tbody></table></div>
      <footer class="pagination"><span>第 {{ page }} / {{ pageCount }} 页</span><div><button class="ghost-button compact" :disabled="offset === 0 || loading" @click="move(-1)"><ChevronLeft :size="15" />上一页</button><button class="ghost-button compact" :disabled="offset + pageSize >= total || loading" @click="move(1)">下一页<ChevronRight :size="15" /></button></div></footer>
    </section>
    <div v-if="selected" class="dialog-backdrop" @mousedown.self="selected = null"><section class="dialog large"><header class="dialog-header"><div><h2>消息处理详情</h2><p class="mono">log: {{ selected.id }}</p><p>message: {{ selected.messageId }} · {{ formatTime(selected.receivedAt) }}</p></div><button class="icon-button" aria-label="关闭" @click="selected = null"><X :size="19" /></button></header><div class="dialog-body">
      <div class="detail-grid"><div><span>Bot</span><strong>{{ selected.botName }}</strong></div><div><span>消息类型</span><strong>{{ selected.messageType }}</strong></div><div><span>工作区</span><strong>{{ selected.workspaceName }}</strong></div><div><span>场景</span><strong>{{ selected.sceneName || '默认路由' }}</strong></div><div><span>Thread Channel</span><strong class="mono">{{ selected.threadChannelId || '—' }}</strong></div><div><span>Codex Thread</span><strong class="mono">{{ selected.coreThreadId || '—' }}</strong></div><div><span>Thread 路由</span><strong>{{ threadRouteLabel(selected.threadRouting.type) }}</strong></div><div><span>匹配分数</span><strong class="mono">{{ selected.threadRouting.score ? selected.threadRouting.score.toFixed(3) : '—' }}</strong></div><div><span>匹配 Thread</span><strong class="mono">{{ selected.threadRouting.matchedThreadId || '—' }}</strong></div><div><span>耗时</span><strong>{{ formatDuration(selected.durationMs) }}</strong></div><div><span>状态</span><strong>{{ statusLabel(selected.status) }}</strong></div><div><span>实际模型</span><strong class="mono">{{ selected.model || '—' }}</strong></div><div><span>模型来源</span><strong>{{ sourceLabel(selected.modelSource) }}<template v-if="selected.modelFallback"> · 已回退</template></strong></div><div><span>推理强度</span><strong class="mono">{{ selected.reasoningEffort || '模型默认' }} · {{ sourceLabel(selected.reasoningEffortSource) }}</strong></div></div>
      <div class="record-content"><h3>Thread 路由依据</h3><pre>{{ selected.threadRouting.reason || '当前记录没有路由说明' }}</pre></div>
      <div class="field"><span class="field-label">技能包</span><div class="tag-list"><span v-if="!selected.skillPackages.length" class="badge gray">无</span><span v-for="item in selected.skillPackages" :key="item.id" class="badge">{{ item.name }}</span></div></div>
      <div class="field"><span class="field-label">调查策略</span><div class="tag-list"><span class="badge">{{ modeLabel(selected.investigation.mode) }}</span><span v-for="item in selected.investigation.primarySkills" :key="`primary:${item.path}`" class="badge green" :title="item.path">首选 · {{ item.name }}</span><span v-for="item in selected.investigation.candidateSkills" :key="`candidate:${item.path}`" class="badge gray" :title="`${item.description}\n${item.path}`">候选 · {{ item.name }}</span></div></div>
      <div v-if="selected.investigation.knowledgeResources.length" class="field"><span class="field-label">知识资源</span><div class="tag-list"><span v-for="item in selected.investigation.knowledgeResources" :key="item.path" class="badge gray" :title="item.path">{{ item.title }}</span></div></div>
      <div v-if="selected.investigation.tools.length" class="record-content"><h3>实际工具调用</h3><div class="tool-trace"><div v-for="(tool, index) in selected.investigation.tools" :key="`${index}:${tool.kind}:${tool.summary}`" class="tool-trace-item"><span class="badge" :class="tool.status.includes('fail') ? 'red' : tool.status.includes('complete') ? 'green' : 'gray'">{{ tool.status }}</span><strong>{{ tool.title }}</strong><code class="mono">{{ tool.summary || tool.kind }}</code></div></div></div>
      <div class="record-content"><h3>收到的内容</h3><pre>{{ selected.inboundContent }}</pre></div>
      <details v-if="selected.inboundRaw !== null && selected.inboundRaw !== undefined" class="record-content"><summary>原始结构化内容</summary><pre>{{ prettyJson(selected.inboundRaw) }}</pre></details>
      <div class="record-content"><h3>回复内容</h3><pre>{{ selected.responseContent || '（尚未生成回复）' }}</pre></div>
      <div v-if="selected.error" class="error-banner"><strong>错误</strong><br />{{ selected.error }}</div>
      <div class="record-meta mono">log: {{ selected.id }}<br />channel: {{ selected.threadChannelId || '—' }}<br />thread: {{ selected.coreThreadId || '—' }}<br />event: {{ selected.eventId }}<br />message: {{ selected.messageId }}<br />chat: {{ selected.chatId }}<br />topic: {{ selected.topicId || '—' }}<br />sender: {{ selected.senderId || '—' }}<br />code root: {{ selected.investigation.codeRoot || '—' }}</div>
    </div></section></div>
  </div>
</template>
