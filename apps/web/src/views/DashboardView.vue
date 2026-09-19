<script setup lang="ts">
import { Activity, AlertCircle, ArrowRight, Bot, Boxes, CheckCircle2, Clock3, Gauge, MessageSquareText, RefreshCw, Sparkles, Workflow } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import type { DashboardOverview, MessageLog, ThreadRoutingRule } from '../types'

const emptyStats: DashboardOverview = {
  workspaces: 0, bots: 0, scenes: 0, skillPackages: 0, messageLogs: 0,
  today: { received: 0, completed: 0, failed: 0, processing: 0, reused: 0, experience: 0, created: 0, averageDurationMs: 0 },
  threads: { channels: 0, bindings: 0, profiles: 0, queuedJobs: 0, processingJobs: 0 },
}
const stats = ref<DashboardOverview>(emptyStats)
const recent = ref<MessageLog[]>([])
const rules = ref<ThreadRoutingRule[]>([])
const loading = ref(false)
const error = ref('')

const load = async () => {
  loading.value = true; error.value = ''
  try {
    const [overview, messages, routingRules] = await Promise.all([api.dashboard(), api.messageLogs({ limit: 8 }), api.threadRoutingRules()])
    stats.value = overview; recent.value = messages.items; rules.value = routingRules
  } catch (value) { error.value = value instanceof Error ? value.message : '读取运行状态失败' }
  finally { loading.value = false }
}
onMounted(load)

const finishedToday = computed(() => stats.value.today.completed + stats.value.today.failed)
const successRateLabel = computed(() => finishedToday.value ? `${Math.round(stats.value.today.completed / finishedToday.value * 100)}%` : '—')
const averageDurationLabel = computed(() => stats.value.today.completed ? formatDuration(stats.value.today.averageDurationMs) : '—')
const experienceHits = computed(() => stats.value.today.reused + stats.value.today.experience)
const activeJobs = computed(() => stats.value.threads.queuedJobs + stats.value.threads.processingJobs)
const needsAttention = computed(() => stats.value.today.failed > 0 || activeJobs.value > 0)
const enabledRules = computed(() => rules.value.filter(item => item.enabled).length)
const formatDuration = (value: number | null) => value === null ? '处理中' : value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} 秒`
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—'
const excerpt = (value: string) => value.replace(/\s+/gu, ' ').trim().slice(0, 72) || '（空消息）'
const routeLabel = (value: MessageLog['threadRouting']['type']) => ({ fixed: '继续当前会话', new: '全新处理', reused: '复用历史会话', experience: '引用历史经验' }[value])
</script>

<template>
  <div class="page dashboard-page">
    <header class="page-header"><div><p class="eyebrow">Operations overview</p><h1>运行总览</h1><p class="page-description">先看系统是否正常，再看今天处理了什么、经验有没有生效，以及哪里需要关注。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新</button></header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>

    <section class="health-hero" :class="{ attention: needsAttention }">
      <div class="health-copy">
        <div class="health-kicker"><span class="health-pulse" /><span>{{ needsAttention ? '有运行项需要留意' : '系统运行正常' }}</span></div>
        <h2>{{ stats.today.received ? `今天已接收 ${stats.today.received} 条消息` : '今天还没有新消息' }}</h2>
        <p v-if="needsAttention">{{ stats.today.failed }} 条失败，{{ activeJobs }} 条正在排队或执行。可以从下方最近处理记录继续排查。</p>
        <p v-else>消息处理和 Thread 队列当前没有待处理异常。</p>
      </div>
      <div class="health-facts">
        <div><span>当前任务</span><strong>{{ activeJobs }}</strong><small>排队 {{ stats.threads.queuedJobs }} · 执行 {{ stats.threads.processingJobs }}</small></div>
        <div><span>今日失败</span><strong>{{ stats.today.failed }}</strong><small>{{ stats.today.processing }} 条消息处理中</small></div>
        <div><span>经验规则</span><strong>{{ enabledRules }}/{{ rules.length }}</strong><small>场景已启用</small></div>
      </div>
    </section>

    <section class="today-grid" aria-label="今日运行指标">
      <article><div class="metric-heading"><MessageSquareText :size="17" /><span>今日消息</span></div><strong>{{ stats.today.received }}</strong><small>{{ stats.today.completed }} 条已完成</small></article>
      <article><div class="metric-heading"><CheckCircle2 :size="17" /><span>处理成功率</span></div><strong>{{ successRateLabel }}</strong><small>{{ finishedToday }} 条已结束任务</small></article>
      <article><div class="metric-heading"><Sparkles :size="17" /><span>经验命中</span></div><strong>{{ experienceHits }}</strong><small>{{ stats.today.reused }} 条复用 · {{ stats.today.experience }} 条引用</small></article>
      <article><div class="metric-heading"><Clock3 :size="17" /><span>平均耗时</span></div><strong>{{ averageDurationLabel }}</strong><small>今日已完成消息</small></article>
    </section>

    <section class="dashboard-grid">
      <article class="panel recent-panel">
        <div class="panel-header"><div><h2><Activity :size="17" />最近处理</h2><p class="panel-description">最新消息、处理结果和经验路由一眼可见。</p></div><RouterLink class="text-link" to="/messages">查看全部<ArrowRight :size="14" /></RouterLink></div>
        <div v-if="!recent.length" class="empty"><MessageSquareText :size="30" /><strong>还没有处理记录</strong><span>Bot 收到消息后会显示在这里。</span></div>
        <div v-else class="activity-list">
          <RouterLink v-for="item in recent" :key="item.id" :to="`/messages?query=${encodeURIComponent(item.id)}`" class="activity-row">
            <div class="activity-state" :class="item.status"><CheckCircle2 v-if="item.status === 'completed'" :size="15" /><AlertCircle v-else-if="item.status === 'failed'" :size="15" /><Clock3 v-else :size="15" /></div>
            <div class="activity-main"><strong>{{ excerpt(item.inboundContent) }}</strong><span>{{ item.botName }} · {{ item.sceneName || '默认路由' }}</span></div>
            <div class="activity-route"><span>{{ routeLabel(item.threadRouting.type) }}</span><small>{{ formatDuration(item.durationMs) }}</small></div>
            <time>{{ formatTime(item.receivedAt) }}</time>
          </RouterLink>
        </div>
      </article>

      <aside class="overview-side">
        <article class="panel reuse-card">
          <div class="panel-header"><div><h2><Sparkles :size="17" />经验复用</h2><p class="panel-description">历史处理是否正在帮助新问题。</p></div><RouterLink class="text-link" to="/thread-routing">查看经验库<ArrowRight :size="14" /></RouterLink></div>
          <div class="reuse-body">
            <div class="reuse-total"><strong>{{ stats.threads.profiles }}</strong><span>条可用经验</span></div>
            <div class="reuse-breakdown"><div><span>直接复用历史会话</span><strong>{{ stats.today.reused }}</strong></div><div><span>引用经验重新处理</span><strong>{{ stats.today.experience }}</strong></div><div><span>全新问题</span><strong>{{ stats.today.created }}</strong></div></div>
          </div>
        </article>
        <article class="panel coverage-card">
          <div class="panel-header"><div><h2><Gauge :size="17" />系统覆盖</h2><p class="panel-description">当前配置和会话沉淀情况。</p></div></div>
          <div class="coverage-list"><RouterLink to="/bots"><Bot :size="16" /><span>飞书 Bot</span><strong>{{ stats.bots }}</strong></RouterLink><RouterLink to="/workspaces"><Boxes :size="16" /><span>工作区</span><strong>{{ stats.workspaces }}</strong></RouterLink><RouterLink to="/scenes"><Workflow :size="16" /><span>启用场景</span><strong>{{ stats.scenes }}</strong></RouterLink><RouterLink to="/conversation-threads"><Activity :size="16" /><span>会话 / Channel</span><strong>{{ stats.threads.bindings }} / {{ stats.threads.channels }}</strong></RouterLink></div>
        </article>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.dashboard-page{max-width:1440px}.health-hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(420px,.8fr);gap:28px;align-items:center;margin-bottom:16px;padding:28px 30px;background:linear-gradient(125deg,rgba(52,211,153,.10),transparent 48%),var(--surface);border:1px solid rgba(52,211,153,.24);border-radius:18px;box-shadow:var(--shadow-soft)}.health-hero.attention{background:linear-gradient(125deg,rgba(251,191,36,.10),transparent 48%),var(--surface);border-color:rgba(251,191,36,.28)}.health-kicker{display:flex;align-items:center;gap:9px;margin-bottom:10px;color:var(--green);font-size:12px;font-weight:750}.attention .health-kicker{color:var(--warning)}.health-pulse{width:9px;height:9px;background:currentColor;border-radius:50%;box-shadow:0 0 0 5px color-mix(in srgb,currentColor 14%,transparent)}.health-copy h2{margin:0;font-size:24px;letter-spacing:-.025em}.health-copy p{max-width:700px;margin:9px 0 0;color:var(--muted);font-size:13px;line-height:1.65}.health-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;overflow:hidden;background:var(--border);border:1px solid var(--border);border-radius:13px}.health-facts>div{min-width:0;padding:16px;background:var(--surface-raised)}.health-facts span,.health-facts small{display:block;color:var(--muted);font-size:10px}.health-facts strong{display:block;margin:7px 0;font:700 23px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.today-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.today-grid article{padding:18px 19px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-soft)}.metric-heading{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;font-weight:650}.metric-heading svg{color:var(--primary)}.today-grid article>strong{display:block;margin:14px 0 7px;font:700 25px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.today-grid small{color:var(--muted);font-size:11px}.dashboard-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(330px,.65fr);gap:16px}.overview-side{display:grid;align-content:start;gap:16px}.text-link{display:inline-flex;align-items:center;gap:5px;color:var(--primary);font-size:11px;font-weight:700;text-decoration:none}.activity-list{display:grid}.activity-row{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(130px,.3fr) 48px;align-items:center;gap:12px;padding:15px 20px;color:inherit;border-top:1px solid var(--border);text-decoration:none;transition:background .16s ease}.activity-row:first-child{border-top:0}.activity-row:hover{background:var(--surface-raised)}.activity-state{width:30px;height:30px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-radius:9px}.activity-state.completed{color:var(--green);background:rgba(52,211,153,.09)}.activity-state.failed{color:var(--danger);background:rgba(251,113,133,.09)}.activity-main{min-width:0}.activity-main strong,.activity-main span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity-main strong{font-size:12px}.activity-main span,.activity-route small,.activity-row time{margin-top:5px;color:var(--muted);font-size:10px}.activity-route span{display:block;color:var(--text-soft);font-size:11px}.activity-row time{text-align:right}.reuse-body{padding:22px}.reuse-total{display:flex;align-items:baseline;gap:9px;padding-bottom:18px;border-bottom:1px solid var(--border)}.reuse-total strong{font:700 32px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.reuse-total span{color:var(--muted);font-size:12px}.reuse-breakdown{display:grid;gap:11px;padding-top:17px}.reuse-breakdown div{display:flex;align-items:center;justify-content:space-between;gap:10px}.reuse-breakdown span{color:var(--muted);font-size:11px}.reuse-breakdown strong{font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace}.coverage-list{display:grid}.coverage-list a{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;min-height:48px;padding:0 20px;color:var(--text-soft);border-top:1px solid var(--border);text-decoration:none}.coverage-list a:first-child{border-top:0}.coverage-list a:hover{background:var(--surface-raised)}.coverage-list svg{color:var(--primary)}.coverage-list span{font-size:12px}.coverage-list strong{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:1100px){.health-hero,.dashboard-grid{grid-template-columns:1fr}.today-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.health-hero{padding:22px}.health-facts{grid-template-columns:1fr}.today-grid{grid-template-columns:1fr}.activity-row{grid-template-columns:auto minmax(0,1fr) auto}.activity-route{display:none}}
</style>
