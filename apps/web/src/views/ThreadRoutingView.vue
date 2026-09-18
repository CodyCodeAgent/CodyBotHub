<script setup lang="ts">
import { BrainCircuit, DatabaseZap, Edit3, RefreshCw, Route, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { PlatformSettings, ThreadProfile, ThreadRoutingDecisionRecord, ThreadRoutingRule } from '../types'

const rules = ref<ThreadRoutingRule[]>([])
const profiles = ref<ThreadProfile[]>([])
const decisions = ref<ThreadRoutingDecisionRecord[]>([])
const settings = ref<PlatformSettings | null>(null)
const loading = ref(false), saving = ref(false), error = ref(''), dialogOpen = ref(false)
const form = reactive({ sceneId: '', sceneName: '', enabled: false, reuseThreshold: 0.85, experienceThreshold: 0.55, timeWindowHours: 72, maxCandidates: 100, structuredWeight: 0.7, textWeight: 0.3 })
const enabledCount = computed(() => rules.value.filter(item => item.enabled).length)
const latestProfileAt = computed(() => profiles.value.map(item => item.updatedAt).filter(Boolean).sort().at(-1) ?? '')
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '—'
const score = (value: number) => value ? value.toFixed(3) : '—'
const typeLabel = (value: ThreadRoutingDecisionRecord['type']) => ({ fixed: '会话固定', new: '新建', reused: '复用 Thread', experience: '引用经验' }[value])
const typeClass = (value: ThreadRoutingDecisionRecord['type']) => value === 'reused' ? 'green' : value === 'experience' ? '' : 'gray'

const load = async () => {
  loading.value = true; error.value = ''
  try { [rules.value, profiles.value, decisions.value, settings.value] = await Promise.all([api.threadRoutingRules(), api.threadProfiles(), api.threadRoutingDecisions(), api.settings()]) }
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
    <header class="page-header"><div><p class="eyebrow">Thread intelligence</p><h1>Thread 路由</h1><p class="page-description">按场景维护历史 Thread 画像，让重复事件复用上下文，相似问题带入已验证经验。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button></header>
    <section class="routing-overview">
      <article><Route :size="19" /><div><strong>{{ enabledCount }} / {{ rules.length }} 个场景已启用</strong><span>只在同一 Bot、工作区和场景内检索</span></div></article>
      <article><DatabaseZap :size="19" /><div><strong>{{ profiles.length }} 个 Thread 画像</strong><span>最近更新 {{ formatTime(latestProfileAt) }}</span></div></article>
      <article><BrainCircuit :size="19" /><div><strong>异步更新</strong><span>每 {{ settings?.threadProfileRefreshIntervalSeconds ?? '—' }} 秒，每批 {{ settings?.threadProfileBatchSize ?? '—' }} 条</span></div></article>
    </section>
    <section class="route-rules" aria-label="路由流程">
      <div class="route-rule"><strong>1. 消息完成</strong><code>写入异步更新队列</code></div>
      <div class="route-rule"><strong>2. 画像沉淀</strong><code>结构化特征 + 文本 + 结论</code></div>
      <div class="route-rule"><strong>3. 在线路由</strong><code>高分复用 · 中分引用经验</code></div>
    </section>
    <div v-if="error" class="error-banner" role="alert" style="margin-bottom:16px">{{ error }}</div>
    <section class="panel"><div class="panel-header"><div><h2>场景规则</h2><p class="panel-description">规则关闭时仍按 Bot 的群 / 话题会话边界创建 Thread。</p></div><span class="badge gray">{{ rules.length }} 个场景</span></div>
      <div class="table-wrap"><table class="message-table"><thead><tr><th>场景 / 范围</th><th>状态</th><th>阈值</th><th>候选窗口</th><th>画像</th><th></th></tr></thead><tbody><tr v-for="item in rules" :key="item.sceneId"><td><div class="entity-title">{{ item.sceneName }}</div><div class="entity-subtitle">{{ item.botName }} · {{ item.workspaceName }}</div></td><td><span class="badge" :class="item.enabled ? 'green' : 'gray'">{{ item.enabled ? '已启用' : '未启用' }}</span></td><td><div>复用 ≥ {{ item.reuseThreshold.toFixed(2) }}</div><div class="entity-subtitle">经验 ≥ {{ item.experienceThreshold.toFixed(2) }}</div></td><td><div>{{ item.timeWindowHours }} 小时</div><div class="entity-subtitle">最多 {{ item.maxCandidates }} 个</div></td><td>{{ item.profileCount }}</td><td><button class="ghost-button compact" @click="edit(item)"><Edit3 :size="14" />配置</button></td></tr></tbody></table></div>
    </section>
    <section class="panel"><div class="panel-header"><div><h2>最近路由结果</h2><p class="panel-description">每条消息保留最终决策、候选 Thread、分数和匹配依据。</p></div><span class="badge gray">{{ decisions.length }} 条</span></div>
      <div v-if="!decisions.length" class="empty"><Route :size="32" /><strong>还没有路由记录</strong><span>场景消息处理后会显示在这里。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>时间</th><th>场景</th><th>结果</th><th>分数 / 依据</th><th>Codex Thread</th></tr></thead><tbody><tr v-for="item in decisions" :key="item.logId"><td class="mono">{{ formatTime(item.receivedAt) }}</td><td>{{ item.sceneName }}</td><td><span class="badge" :class="typeClass(item.type)">{{ typeLabel(item.type) }}</span></td><td><div class="mono">{{ score(item.score) }}</div><div class="entity-subtitle decision-reason">{{ item.reason || '—' }}</div></td><td><code class="thread-id">{{ item.coreThreadId || item.matchedThreadId || '—' }}</code></td></tr></tbody></table></div>
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
.routing-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}.routing-overview article{display:flex;align-items:center;gap:12px;padding:18px;border:1px solid var(--border);border-radius:16px;background:var(--surface)}.routing-overview svg{color:var(--primary)}.routing-overview div{display:flex;flex-direction:column;gap:4px}.routing-overview span{font-size:13px;color:var(--muted)}.decision-reason{max-width:440px;white-space:normal}.panel+.panel{margin-top:16px}@media(max-width:900px){.routing-overview{grid-template-columns:1fr}}
</style>
