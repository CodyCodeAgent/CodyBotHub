<script setup lang="ts">
import { BrainCircuit, Edit3, Layers3, ListChecks, RefreshCw, Route, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { PlatformSettings, ThreadChannel, ThreadJob, ThreadProfile, ThreadRoutingDecisionRecord, ThreadRoutingRule } from '../types'

const rules = ref<ThreadRoutingRule[]>([])
const profiles = ref<ThreadProfile[]>([])
const decisions = ref<ThreadRoutingDecisionRecord[]>([])
const channels = ref<ThreadChannel[]>([])
const jobs = ref<ThreadJob[]>([])
const settings = ref<PlatformSettings | null>(null)
const loading = ref(false), saving = ref(false), error = ref(''), dialogOpen = ref(false)
const form = reactive({ sceneId: '', sceneName: '', enabled: false, reuseThreshold: 0.85, experienceThreshold: 0.55, timeWindowHours: 72, maxCandidates: 100, structuredWeight: 0.7, textWeight: 0.3 })
const enabledCount = computed(() => rules.value.filter(item => item.enabled).length)
const bindingCount = computed(() => channels.value.reduce((sum, item) => sum + item.bindingCount, 0))
const activeJobCount = computed(() => jobs.value.filter(item => item.status === 'queued' || item.status === 'processing').length)
const latestProfileAt = computed(() => profiles.value.map(item => item.updatedAt).filter(Boolean).sort().at(-1) ?? '')
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '—'
const score = (value: number) => value ? value.toFixed(3) : '—'
const typeLabel = (value: ThreadRoutingDecisionRecord['type']) => ({ fixed: '会话固定', new: '新建', reused: '复用 Thread', experience: '引用经验' }[value])
const typeClass = (value: ThreadRoutingDecisionRecord['type']) => value === 'reused' ? 'green' : value === 'experience' ? '' : 'gray'
const jobLabel = (value: ThreadJob['status']) => ({ queued: '排队中', processing: '执行中', completed: '已完成', failed: '失败' }[value])
const jobClass = (value: ThreadJob['status']) => value === 'completed' ? 'green' : value === 'failed' ? 'red' : 'gray'

const load = async () => {
  loading.value = true; error.value = ''
  try { [rules.value, profiles.value, decisions.value, channels.value, jobs.value, settings.value] = await Promise.all([api.threadRoutingRules(), api.threadProfiles(), api.threadRoutingDecisions(), api.threadChannels(), api.threadJobs(), api.settings()]) }
  catch (value) { error.value = value instanceof Error ? value.message : '读取失败' }
  finally { loading.value = false }
}
onMounted(load)
const edit = (rule: ThreadRoutingRule) => { Object.assign(form, rule); dialogOpen.value = true }
const save = async () => {
  saving.value = true; error.value = ''
  try {
    await api.saveThreadRoutingRule(form.sceneId, { enabled: form.enabled, reuseThreshold: form.reuseThreshold, experienceThreshold: form.experienceThreshold, timeWindowHours: form.timeWindowHours, maxCandidates: form.maxCandidates, structuredWeight: form.structuredWeight, textWeight: form.textWeight })
    dialogOpen.value = false; await load()
  } catch (value) { error.value = value instanceof Error ? value.message : '保存失败' }
  finally { saving.value = false }
}
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Thread intelligence</p><h1>Thread 路由</h1><p class="page-description">Thread Channel 把多个相似会话汇入同一个 Codex Thread，并通过持久队列保证同一 Thread 串行处理。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button></header>
    <section class="routing-overview">
      <article><Route :size="19" /><div><strong>{{ enabledCount }} / {{ rules.length }} 个场景已启用</strong><span>只在同一 Bot、工作区和场景内检索</span></div></article>
      <article><Layers3 :size="19" /><div><strong>{{ channels.length }} 个 Channel · {{ bindingCount }} 个会话</strong><span>多个群或话题可以共享一个 Thread</span></div></article>
      <article><ListChecks :size="19" /><div><strong>{{ activeJobCount }} 个待处理任务</strong><span>排队与执行状态已持久化</span></div></article>
      <article><BrainCircuit :size="19" /><div><strong>{{ profiles.length }} 个经验画像</strong><span>每 {{ settings?.threadProfileRefreshIntervalSeconds ?? '—' }} 秒更新 · 最近 {{ formatTime(latestProfileAt) }}</span></div></article>
    </section>
    <section class="route-rules" aria-label="路由流程">
      <div class="route-rule"><strong>1. 在线路由</strong><code>会话固定 · 高分共享 · 中分引用</code></div>
      <div class="route-rule"><strong>2. Channel 入队</strong><code>持久记录 · 同 Channel 串行</code></div>
      <div class="route-rule"><strong>3. 画像沉淀</strong><code>结构化特征 + 文本 + 结论</code></div>
    </section>
    <div v-if="error" class="error-banner" role="alert" style="margin-bottom:16px">{{ error }}</div>
    <section class="panel"><div class="panel-header"><div><h2>场景规则</h2><p class="panel-description">规则关闭时仍按 Bot 的群 / 话题会话边界创建 Thread。</p></div><span class="badge gray">{{ rules.length }} 个场景</span></div>
      <div class="table-wrap"><table class="message-table"><thead><tr><th>场景 / 范围</th><th>状态</th><th>阈值</th><th>候选窗口</th><th>画像</th><th></th></tr></thead><tbody><tr v-for="item in rules" :key="item.sceneId"><td><div class="entity-title">{{ item.sceneName }}</div><div class="entity-subtitle">{{ item.botName }} · {{ item.workspaceName }}</div></td><td><span class="badge" :class="item.enabled ? 'green' : 'gray'">{{ item.enabled ? '已启用' : '未启用' }}</span></td><td><div>复用 ≥ {{ item.reuseThreshold.toFixed(2) }}</div><div class="entity-subtitle">经验 ≥ {{ item.experienceThreshold.toFixed(2) }}</div></td><td><div>{{ item.timeWindowHours }} 小时</div><div class="entity-subtitle">最多 {{ item.maxCandidates }} 个</div></td><td>{{ item.profileCount }}</td><td><button class="ghost-button compact" @click="edit(item)"><Edit3 :size="14" />配置</button></td></tr></tbody></table></div>
    </section>
    <section class="panel"><div class="panel-header"><div><h2>Thread Channels</h2><p class="panel-description">一个 Channel 独占一个 Codex Thread，并可承载多个飞书群或话题。</p></div><span class="badge gray">{{ channels.length }} 个</span></div>
      <div v-if="!channels.length" class="empty"><Layers3 :size="32" /><strong>还没有 Thread Channel</strong><span>第一条可处理消息进入后会自动创建。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>最后活跃</th><th>Bot</th><th>会话绑定</th><th>任务</th><th>Thread Channel / Codex Thread</th></tr></thead><tbody><tr v-for="item in channels" :key="item.id"><td class="mono">{{ formatTime(item.updatedAt) }}</td><td>{{ item.botName }}</td><td>{{ item.bindingCount }}</td><td><span v-if="item.processingJobs" class="badge">执行 {{ item.processingJobs }}</span><span v-if="item.queuedJobs" class="badge gray">排队 {{ item.queuedJobs }}</span><span v-if="!item.processingJobs && !item.queuedJobs" class="entity-subtitle">空闲</span></td><td><code class="thread-id">channel: {{ item.id }}</code><div class="entity-subtitle mono">thread: {{ item.coreThreadId || '尚未创建' }}</div></td></tr></tbody></table></div>
    </section>
    <section class="panel"><div class="panel-header"><div><h2>任务队列</h2><p class="panel-description">消息先写入任务队列，再按 Thread Channel 顺序提交给 Codex。</p></div><span class="badge gray">最近 {{ jobs.length }} 条</span></div>
      <div v-if="!jobs.length" class="empty"><ListChecks :size="32" /><strong>还没有队列任务</strong><span>收到消息后会显示排队、执行与完成状态。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>创建时间</th><th>状态</th><th>尝试</th><th>消息 / 记录</th><th>Thread Channel</th></tr></thead><tbody><tr v-for="item in jobs" :key="item.id"><td class="mono">{{ formatTime(item.createdAt) }}</td><td><span class="badge" :class="jobClass(item.status)">{{ jobLabel(item.status) }}</span><div v-if="item.error" class="entity-subtitle decision-reason">{{ item.error }}</div></td><td class="mono">{{ item.attempts }}</td><td><code class="thread-id">message: {{ item.messageId }}</code><div class="entity-subtitle mono">log: {{ item.logId }}</div></td><td><code class="thread-id">{{ item.threadChannelId }}</code></td></tr></tbody></table></div>
    </section>
    <section class="panel"><div class="panel-header"><div><h2>最近路由结果</h2><p class="panel-description">每条消息保留最终决策、候选 Thread、分数和匹配依据。</p></div><span class="badge gray">{{ decisions.length }} 条</span></div>
      <div v-if="!decisions.length" class="empty"><Route :size="32" /><strong>还没有路由记录</strong><span>场景消息处理后会显示在这里。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>时间</th><th>场景</th><th>结果</th><th>分数 / 依据</th><th>Thread Channel / Codex Thread</th></tr></thead><tbody><tr v-for="item in decisions" :key="item.logId"><td class="mono">{{ formatTime(item.receivedAt) }}</td><td>{{ item.sceneName }}</td><td><span class="badge" :class="typeClass(item.type)">{{ typeLabel(item.type) }}</span></td><td><div class="mono">{{ score(item.score) }}</div><div class="entity-subtitle decision-reason">{{ item.reason || '—' }}</div></td><td><code class="thread-id">channel: {{ item.threadChannelId || '—' }}</code><div class="entity-subtitle mono">thread: {{ item.coreThreadId || item.matchedThreadId || '—' }}</div></td></tr></tbody></table></div>
    </section>

    <div v-if="dialogOpen" class="dialog-backdrop" @mousedown.self="dialogOpen = false"><form class="dialog large" @submit.prevent="save"><header class="dialog-header"><div><h2>配置 Thread 路由</h2><p>{{ form.sceneName }}</p></div><button type="button" class="icon-button" aria-label="关闭" @click="dialogOpen = false"><X :size="19" /></button></header><div class="dialog-body">
      <label class="check-card"><input v-model="form.enabled" type="checkbox" /><span><strong>启用相似 Thread 路由</strong><small>候选严格限制在同一 Bot、工作区和场景。</small></span></label>
      <div class="field-grid"><div class="field"><label>复用阈值</label><input v-model.number="form.reuseThreshold" type="number" min="0" max="1" step="0.01" /><small>达到后直接继续历史 Thread。</small></div><div class="field"><label>经验阈值</label><input v-model.number="form.experienceThreshold" type="number" min="0" max="1" step="0.01" /><small>达到后创建新 Thread，并注入历史经验。</small></div></div>
      <div class="field-grid"><div class="field"><label>时间窗口（小时）</label><input v-model.number="form.timeWindowHours" type="number" min="1" max="8760" /></div><div class="field"><label>最多候选数</label><input v-model.number="form.maxCandidates" type="number" min="10" max="1000" /></div></div>
      <div class="field-grid"><div class="field"><label>结构化特征权重</label><input v-model.number="form.structuredWeight" type="number" min="0" max="1" step="0.05" /></div><div class="field"><label>文本特征权重</label><input v-model.number="form.textWeight" type="number" min="0" max="1" step="0.05" /></div></div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="dialogOpen = false">取消</button><button class="button" :disabled="saving">{{ saving ? '保存中…' : '保存规则' }}</button></footer></form></div>
  </div>
</template>

<style scoped>
.routing-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.routing-overview article{display:flex;align-items:center;gap:12px;padding:18px;border:1px solid var(--border);border-radius:16px;background:var(--surface)}.routing-overview svg{flex:0 0 auto;color:var(--primary)}.routing-overview div{display:flex;min-width:0;flex-direction:column;gap:4px}.routing-overview span{font-size:13px;color:var(--muted)}.decision-reason{max-width:440px;white-space:normal}.panel+.panel{margin-top:16px}@media(max-width:1200px){.routing-overview{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.routing-overview{grid-template-columns:1fr}}
</style>
