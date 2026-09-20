<script setup lang="ts">
import { Activity, BarChart3, Bot, Boxes, CheckCircle2, Clock3, Gauge, GitBranch, MessageSquareText, RefreshCw, Sparkles, UsersRound, Workflow } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api'
import type { DashboardOverview, SystemHealth } from '../types'

const emptyStats: DashboardOverview = {
  workspaces: 0, bots: 0, scenes: 0, skillPackages: 0, messageLogs: 0,
  today: { received: 0, completed: 0, failed: 0, processing: 0, reused: 0, experience: 0, created: 0, averageDurationMs: 0 },
  threads: { channels: 0, bindings: 0, profiles: 0, queuedJobs: 0, processingJobs: 0 },
  analytics: { total: { received: 0, completed: 0, failed: 0, processing: 0, uniqueChats: 0, averageDurationMs: 0 }, daily: [], chats: [], scenes: [], routes: [] },
}
const stats = ref<DashboardOverview>(emptyStats)
const emptyHealth: SystemHealth = {
  status: 'healthy', checkedAt: '', startedAt: '', uptimeSeconds: 0,
  store: { database: { ok: true, result: 'ok' }, queue: { queued: 0, processing: 0, staleProcessing: 0, oldestQueuedAt: '' }, profiles: { queued: 0, failed: 0 } },
  feishu: { draining: false, drainStartedAt: '', activeJobs: 0, pendingReceipts: 0, configuredBots: 0, activeProviders: 0, connectedProviders: 0, scheduledJobs: 0, activeChannels: 0, lastQueueScanAt: '', lastError: '', providers: [] },
  runtime: { initialized: false, attachedChannels: 0 },
}
const health = ref<SystemHealth>(emptyHealth)
const loading = ref(false)
const error = ref('')
const hoveredDailyIndex = ref<number | null>(null)
let loadInFlight = false
let refreshTimer: ReturnType<typeof setInterval> | null = null

const load = async (silent = false) => {
  if (loadInFlight) return
  loadInFlight = true
  if (!silent) loading.value = true
  error.value = ''
  try { [stats.value, health.value] = await Promise.all([api.dashboard(), api.systemHealth()]) }
  catch (value) { error.value = value instanceof Error ? value.message : '读取运行状态失败' }
  finally {
    loadInFlight = false
    if (!silent) loading.value = false
  }
}
onMounted(() => {
  void load()
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void load(true)
  }, 5_000)
})
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
})

const activeJobs = computed(() => health.value.store.queue.queued + health.value.store.queue.processing)
const needsAttention = computed(() => health.value.feishu.draining || health.value.status === 'attention' || stats.value.today.failed > 0)
const healthReason = computed(() => {
  const reasons: string[] = []
  if (health.value.feishu.draining) reasons.push(`正在等待 ${health.value.feishu.activeJobs} 个运行任务完成，新消息将暂存队列`)
  if (!health.value.store.database.ok) reasons.push('数据库检查异常')
  if (health.value.feishu.connectedProviders < health.value.feishu.configuredBots) reasons.push('Bot 连接不完整')
  if (health.value.store.queue.staleProcessing) reasons.push(`${health.value.store.queue.staleProcessing} 个任务疑似卡住`)
  if (stats.value.today.failed) reasons.push(`今日 ${stats.value.today.failed} 条失败`)
  return reasons.join('，') || '数据库、Bot 连接与持久队列均正常。'
})
const totalFinished = computed(() => stats.value.analytics.total.completed + stats.value.analytics.total.failed)
const totalSuccessRate = computed(() => totalFinished.value ? Math.round(stats.value.analytics.total.completed / totalFinished.value * 100) : null)
const maxDaily = computed(() => Math.max(1, ...stats.value.analytics.daily.map(item => item.received)))
const maxChat = computed(() => Math.max(1, ...stats.value.analytics.chats.map(item => item.received)))
const maxScene = computed(() => Math.max(1, ...stats.value.analytics.scenes.map(item => item.received)))
const daily14Total = computed(() => stats.value.analytics.daily.reduce((sum, item) => sum + item.received, 0))
const recentSeven = computed(() => stats.value.analytics.daily.slice(-7).reduce((sum, item) => sum + item.received, 0))
const previousSeven = computed(() => stats.value.analytics.daily.slice(0, 7).reduce((sum, item) => sum + item.received, 0))
const sevenDayDelta = computed(() => previousSeven.value ? Math.round((recentSeven.value - previousSeven.value) / previousSeven.value * 100) : null)
const routeTotal = computed(() => stats.value.analytics.routes.reduce((sum, item) => sum + item.count, 0))

const chart = { width: 760, height: 240, left: 42, right: 16, top: 18, bottom: 34 }
const plotWidth = chart.width - chart.left - chart.right
const plotHeight = chart.height - chart.top - chart.bottom
const chartX = (index: number) => chart.left + (stats.value.analytics.daily.length <= 1 ? 0 : index / (stats.value.analytics.daily.length - 1) * plotWidth)
const chartY = (value: number) => chart.top + plotHeight - value / maxDaily.value * plotHeight
const chartPoints = (key: 'received'|'completed'|'failed') => stats.value.analytics.daily.map((item, index) => `${chartX(index)},${chartY(item[key])}`).join(' ')
const chartArea = computed(() => `${chart.left},${chart.top + plotHeight} ${chartPoints('received')} ${chart.left + plotWidth},${chart.top + plotHeight}`)
const yTicks = computed(() => [1, .75, .5, .25, 0].map(ratio => ({ value: Math.round(maxDaily.value * ratio), y: chart.top + plotHeight * (1 - ratio) })))
const hoveredDaily = computed(() => hoveredDailyIndex.value === null ? null : stats.value.analytics.daily[hoveredDailyIndex.value] ?? null)

const updateDailyHover = (event: PointerEvent) => {
  const count = stats.value.analytics.daily.length
  if (!count) return
  const svg = event.currentTarget as SVGElement
  const bounds = svg.getBoundingClientRect()
  const pointerX = (event.clientX - bounds.left) / bounds.width * chart.width
  const ratio = Math.max(0, Math.min(1, (pointerX - chart.left) / plotWidth))
  hoveredDailyIndex.value = count === 1 ? 0 : Math.round(ratio * (count - 1))
}

const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const formatDuration = (value: number) => !value ? '—' : value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} 秒`
const formatUptime = (seconds: number) => seconds < 60 ? `${seconds} 秒` : seconds < 3_600 ? `${Math.floor(seconds / 60)} 分钟` : seconds < 86_400 ? `${Math.floor(seconds / 3_600)} 小时` : `${Math.floor(seconds / 86_400)} 天`
const formatDate = (value: string) => { const [, month, day] = value.split('-'); return `${Number(month)}/${Number(day)}` }
const rate = (completed: number, failed: number) => completed + failed ? Math.round(completed / (completed + failed) * 100) : null
const routeLabel = (value: string) => ({ fixed: '继续当前会话', new: '全新处理', reused: '复用历史会话', experience: '引用历史经验' }[value] ?? value)
const routeClass = (value: string) => value === 'reused' ? 'green' : value === 'experience' ? 'purple' : value === 'new' ? 'blue' : 'gray'
</script>

<template>
  <div class="page dashboard-page">
    <header class="page-header"><div><p class="eyebrow">Operations analytics</p><h1>运行总览</h1><p class="page-description">查看累计使用量、每日趋势、群与场景分布，以及当前运行健康状态。</p></div><button class="ghost-button" :disabled="loading" @click="load()"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新</button></header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>

    <section class="health-strip" :class="{ attention: needsAttention }">
      <div class="health-summary"><span class="health-pulse" /><div><strong>{{ health.feishu.draining ? '服务正在排空' : needsAttention ? '有运行项需要留意' : '系统运行正常' }}</strong><p>{{ healthReason }}</p></div></div>
      <div class="health-stat"><span>持久队列</span><strong>{{ activeJobs }}</strong><small>排队 {{ health.store.queue.queued }} · 执行 {{ health.store.queue.processing }}</small></div>
      <div class="health-stat"><span>飞书 Bot 连接</span><strong>{{ health.feishu.connectedProviders }}/{{ health.feishu.configuredBots }}</strong><small>{{ health.feishu.activeChannels }} 个 Channel 正在执行</small></div>
      <div class="health-stat"><span>SQLite</span><strong>{{ health.store.database.ok ? '正常' : '异常' }}</strong><small>{{ health.store.database.ok ? 'quick_check 已通过' : health.store.database.result }}</small></div>
      <div class="health-stat"><span>服务运行时间</span><strong>{{ formatUptime(health.uptimeSeconds) }}</strong><small>画像待处理 {{ health.store.profiles.queued }} 条</small></div>
    </section>

    <section class="kpi-grid" aria-label="累计运行指标">
      <article><div class="metric-heading"><MessageSquareText :size="17" /><span>累计处理</span></div><strong>{{ formatNumber(stats.analytics.total.received) }}</strong><small>今日新增 {{ stats.today.received }} 条</small></article>
      <article><div class="metric-heading"><UsersRound :size="17" /><span>服务群 / 会话</span></div><strong>{{ formatNumber(stats.analytics.total.uniqueChats) }}</strong><small>{{ stats.bots }} 个 Bot · {{ stats.scenes }} 个启用场景</small></article>
      <article><div class="metric-heading"><CheckCircle2 :size="17" /><span>累计成功率</span></div><strong>{{ totalSuccessRate === null ? '—' : `${totalSuccessRate}%` }}</strong><small>{{ formatNumber(totalFinished) }} 条已结束任务</small></article>
      <article><div class="metric-heading"><Clock3 :size="17" /><span>平均处理耗时</span></div><strong>{{ formatDuration(stats.analytics.total.averageDurationMs) }}</strong><small>仅统计成功完成的消息</small></article>
    </section>

    <section class="analytics-top">
      <article class="panel trend-panel">
        <div class="panel-header"><div><h2><BarChart3 :size="17" />近 14 天处理趋势</h2><p class="panel-description">按消息接收日期统计，包含成功、失败和处理中的消息。</p></div><div class="trend-summary"><strong>{{ daily14Total }}</strong><span>14 天累计</span><small v-if="sevenDayDelta !== null" :class="{ positive: sevenDayDelta > 0 }">近 7 天较前 7 天 {{ sevenDayDelta > 0 ? '+' : '' }}{{ sevenDayDelta }}%</small><small v-else>暂无可比基期</small></div></div>
        <div class="chart-legend"><span class="received">全部消息</span><span class="completed">成功完成</span><span class="failed">失败</span></div>
        <div class="trend-chart" role="img" aria-label="近 14 天消息处理趋势图，移动鼠标可查看每日指标">
          <div class="chart-canvas">
          <svg :viewBox="`0 0 ${chart.width} ${chart.height}`" preserveAspectRatio="none" @pointermove="updateDailyHover" @pointerleave="hoveredDailyIndex = null">
            <defs><linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity=".24"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
            <g v-for="tick in yTicks" :key="tick.y"><line class="grid-line" :x1="chart.left" :x2="chart.left + plotWidth" :y1="tick.y" :y2="tick.y"/><text class="axis-label" :x="chart.left - 8" :y="tick.y + 3" text-anchor="end">{{ tick.value }}</text></g>
            <polygon v-if="stats.analytics.daily.length" class="chart-area" :points="chartArea" />
            <polyline class="chart-line received-line" :points="chartPoints('received')" />
            <polyline class="chart-line completed-line" :points="chartPoints('completed')" />
            <polyline class="chart-line failed-line" :points="chartPoints('failed')" />
            <g v-for="(item, index) in stats.analytics.daily" :key="item.date"><circle class="chart-point" :cx="chartX(index)" :cy="chartY(item.received)" r="3"><title>{{ item.date }}：共 {{ item.received }} 条，成功 {{ item.completed }} 条，失败 {{ item.failed }} 条</title></circle><text v-if="index % 2 === 0 || index === stats.analytics.daily.length - 1" class="axis-label" :x="chartX(index)" :y="chart.height - 8" text-anchor="middle">{{ formatDate(item.date) }}</text></g>
            <g v-if="hoveredDaily && hoveredDailyIndex !== null" class="chart-hover-layer">
              <line class="chart-hover-guide" :x1="chartX(hoveredDailyIndex)" :x2="chartX(hoveredDailyIndex)" :y1="chart.top" :y2="chart.top + plotHeight" />
              <circle class="chart-hover-point received" :cx="chartX(hoveredDailyIndex)" :cy="chartY(hoveredDaily.received)" r="5" />
              <circle class="chart-hover-point completed" :cx="chartX(hoveredDailyIndex)" :cy="chartY(hoveredDaily.completed)" r="5" />
              <circle class="chart-hover-point failed" :cx="chartX(hoveredDailyIndex)" :cy="chartY(hoveredDaily.failed)" r="5" />
            </g>
          </svg>
          <div v-if="hoveredDaily && hoveredDailyIndex !== null" class="chart-tooltip" :class="{ right: hoveredDailyIndex > stats.analytics.daily.length / 2 }" :style="{ left: `${chartX(hoveredDailyIndex) / chart.width * 100}%` }">
            <strong>{{ hoveredDaily.date }}</strong>
            <span class="received"><i />全部消息 <b>{{ hoveredDaily.received }}</b></span>
            <span class="completed"><i />成功完成 <b>{{ hoveredDaily.completed }}</b></span>
            <span class="failed"><i />失败 <b>{{ hoveredDaily.failed }}</b></span>
          </div>
          </div>
        </div>
      </article>

      <article class="panel route-panel">
        <div class="panel-header"><div><h2><Sparkles :size="17" />处理方式分布</h2><p class="panel-description">累计消息如何进入 Codex Thread。</p></div></div>
        <div class="route-list"><div v-for="item in stats.analytics.routes" :key="item.type"><div class="route-row"><span><i :class="routeClass(item.type)" />{{ routeLabel(item.type) }}</span><strong>{{ item.count }}</strong></div><div class="mini-bar"><span :class="routeClass(item.type)" :style="{ width: `${routeTotal ? item.count / routeTotal * 100 : 0}%` }" /></div><small>{{ routeTotal ? Math.round(item.count / routeTotal * 100) : 0 }}%</small></div><div v-if="!stats.analytics.routes.length" class="empty compact-empty">暂无处理记录</div></div>
        <RouterLink class="panel-link" to="/thread-routing">查看经验复用详情<GitBranch :size="14" /></RouterLink>
      </article>
    </section>

    <section class="analytics-bottom">
      <article class="panel chat-panel">
        <div class="panel-header"><div><h2><UsersRound :size="17" />群处理量排行</h2><p class="panel-description">按 Bot + 群或会话聚合，展示累计使用量与处理质量。</p></div><span class="badge gray">Top {{ stats.analytics.chats.length }}</span></div>
        <div v-if="stats.analytics.chats.length" class="ranking-list"><article v-for="(item, index) in stats.analytics.chats" :key="`${item.botId}:${item.chatId}`"><span class="rank">{{ String(index + 1).padStart(2, '0') }}</span><div class="rank-main"><div class="rank-title"><strong>{{ item.chatName }}</strong><span>{{ item.botName }}</span></div><div class="rank-bar"><span :style="{ width: `${item.received / maxChat * 100}%` }" /></div><small class="mono">{{ item.chatId }}</small></div><div class="rank-metrics"><strong>{{ item.received }}</strong><span>条消息</span></div><div class="rank-quality"><strong>{{ rate(item.completed, item.failed) === null ? '—' : `${rate(item.completed, item.failed)}%` }}</strong><span>成功率</span></div></article></div>
        <div v-else class="empty"><UsersRound :size="30" /><strong>还没有群处理数据</strong></div>
      </article>

      <article class="panel scene-panel">
        <div class="panel-header"><div><h2><Workflow :size="17" />场景使用分布</h2><p class="panel-description">哪些业务场景使用最多。</p></div></div>
        <div v-if="stats.analytics.scenes.length" class="scene-list"><article v-for="item in stats.analytics.scenes" :key="item.sceneId || 'default'"><div><strong>{{ item.sceneName }}</strong><span>{{ item.received }} 条 · {{ item.failed }} 条失败</span></div><div class="scene-bar"><span :style="{ width: `${item.received / maxScene * 100}%` }" /></div></article></div>
        <div v-else class="empty compact-empty">暂无场景数据</div>
        <div class="coverage-links"><RouterLink to="/bots"><Bot :size="15" /><span>Bot</span><strong>{{ stats.bots }}</strong></RouterLink><RouterLink to="/workspaces"><Boxes :size="15" /><span>工作区</span><strong>{{ stats.workspaces }}</strong></RouterLink><RouterLink to="/conversation-threads"><Activity :size="15" /><span>Thread Channel</span><strong>{{ stats.threads.channels }}</strong></RouterLink><RouterLink to="/thread-routing"><Gauge :size="15" /><span>经验画像</span><strong>{{ stats.threads.profiles }}</strong></RouterLink></div>
      </article>
    </section>

    <p class="data-note">统计口径：累计指标来自全部消息记录；成功率以已完成和失败任务为分母；平均耗时仅统计成功完成的消息；每日趋势按服务器本地自然日聚合。</p>
  </div>
</template>

<style scoped>
.dashboard-page{max-width:1440px}.health-strip{display:grid;grid-template-columns:minmax(300px,1.15fr) repeat(4,minmax(130px,.42fr));align-items:stretch;overflow:hidden;margin-bottom:14px;background:linear-gradient(110deg,rgba(52,211,153,.08),transparent 40%),var(--surface);border:1px solid rgba(52,211,153,.22);border-radius:16px;box-shadow:var(--shadow-soft)}.health-strip.attention{background:linear-gradient(110deg,rgba(251,191,36,.08),transparent 40%),var(--surface);border-color:rgba(251,191,36,.27)}.health-summary{display:flex;align-items:center;gap:13px;padding:19px 22px}.health-pulse{width:9px;height:9px;flex:0 0 auto;background:var(--green);border-radius:50%;box-shadow:0 0 0 5px rgba(52,211,153,.1)}.attention .health-pulse{background:var(--warning);box-shadow:0 0 0 5px rgba(251,191,36,.1)}.health-summary strong{font-size:13px}.health-summary p{margin:5px 0 0;color:var(--muted);font-size:10px}.health-stat{padding:17px 19px;background:color-mix(in srgb,var(--surface-raised) 72%,transparent);border-left:1px solid var(--border)}.health-stat span,.health-stat small{display:block;color:var(--muted);font-size:9px}.health-stat strong{display:block;margin:7px 0 5px;font:700 20px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.kpi-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}.kpi-grid article{padding:18px 19px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-soft)}.metric-heading{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;font-weight:650}.metric-heading svg{color:var(--primary)}.kpi-grid article>strong{display:block;margin:14px 0 7px;font:700 25px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.kpi-grid small{color:var(--muted);font-size:10px}.analytics-top,.analytics-bottom{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(310px,.55fr);gap:14px;margin-bottom:14px}.trend-summary{text-align:right}.trend-summary strong,.trend-summary span,.trend-summary small{display:block}.trend-summary strong{font:700 19px ui-monospace,SFMono-Regular,Menlo,monospace}.trend-summary span,.trend-summary small{color:var(--muted);font-size:9px}.trend-summary small{margin-top:3px}.trend-summary small.positive{color:var(--primary)}.chart-legend{display:flex;justify-content:flex-end;gap:15px;padding:13px 22px 0}.chart-legend span{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:9px}.chart-legend span::before{content:'';width:14px;height:2px;background:var(--primary);border-radius:2px}.chart-legend .completed::before{background:var(--green)}.chart-legend .failed::before{background:var(--danger)}.trend-chart{height:265px;padding:4px 17px 15px}.trend-chart svg{width:100%;height:100%;overflow:visible}.grid-line{stroke:var(--border);stroke-width:1}.axis-label{fill:var(--muted);font:8px ui-monospace,SFMono-Regular,Menlo,monospace}.chart-area{fill:url(#traffic-area)}.chart-line{fill:none;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.received-line{stroke:var(--primary)}.completed-line{stroke:var(--green)}.failed-line{stroke:var(--danger);stroke-width:1.7}.chart-point{fill:var(--surface);stroke:var(--primary);stroke-width:2;vector-effect:non-scaling-stroke}.route-list{display:grid;gap:17px;padding:21px 22px}.route-row{display:flex;justify-content:space-between;gap:12px}.route-row span{display:flex;align-items:center;gap:8px;color:var(--text-soft);font-size:10px}.route-row i{width:7px;height:7px;background:var(--muted);border-radius:50%}.route-row i.green,.mini-bar span.green{background:var(--green)}.route-row i.purple,.mini-bar span.purple{background:var(--primary)}.route-row i.blue,.mini-bar span.blue{background:#60a5fa}.route-row strong{font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace}.mini-bar{height:5px;overflow:hidden;margin:8px 0 4px;background:var(--surface-soft);border-radius:999px}.mini-bar span{display:block;height:100%;background:var(--muted);border-radius:inherit}.route-list small{display:block;color:var(--muted);font-size:8px;text-align:right}.panel-link{display:flex;align-items:center;justify-content:space-between;padding:15px 22px;color:var(--primary);border-top:1px solid var(--border);font-size:10px;font-weight:700;text-decoration:none}.ranking-list{display:grid}.ranking-list article{display:grid;grid-template-columns:28px minmax(0,1fr) 70px 70px;align-items:center;gap:12px;padding:15px 20px;border-top:1px solid var(--border)}.ranking-list article:first-child{border-top:0}.rank{color:var(--muted);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace}.rank-main{min-width:0}.rank-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.rank-title strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.rank-title span{flex:0 0 auto;color:var(--muted);font-size:8px}.rank-bar,.scene-bar{height:5px;overflow:hidden;margin:8px 0 5px;background:var(--surface-soft);border-radius:999px}.rank-bar span,.scene-bar span{display:block;height:100%;background:linear-gradient(90deg,var(--primary-strong),var(--primary));border-radius:inherit}.rank-main small{display:block;overflow:hidden;color:var(--muted);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.rank-metrics,.rank-quality{text-align:right}.rank-metrics strong,.rank-metrics span,.rank-quality strong,.rank-quality span{display:block}.rank-metrics strong,.rank-quality strong{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}.rank-metrics span,.rank-quality span{margin-top:3px;color:var(--muted);font-size:8px}.scene-list{display:grid;padding:7px 0}.scene-list article{padding:12px 20px}.scene-list article>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}.scene-list strong{font-size:10px}.scene-list span{color:var(--muted);font-size:8px}.coverage-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--border)}.coverage-links a{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;min-height:45px;padding:0 16px;color:var(--text-soft);border-top:1px solid var(--border);border-left:1px solid var(--border);font-size:9px;text-decoration:none}.coverage-links a:nth-child(-n+2){border-top:0}.coverage-links a:nth-child(odd){border-left:0}.coverage-links svg{color:var(--primary)}.coverage-links strong{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}.compact-empty{min-height:130px}.data-note{margin:5px 2px 0;color:var(--muted);font-size:9px;line-height:1.6}@media(max-width:1150px){.health-strip{grid-template-columns:repeat(4,minmax(0,1fr))}.health-summary{grid-column:1/-1;border-bottom:1px solid var(--border)}.analytics-top,.analytics-bottom{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.health-strip,.kpi-grid{grid-template-columns:1fr}.health-summary{grid-column:auto}.health-stat{border-top:1px solid var(--border);border-left:0}.ranking-list article{grid-template-columns:24px minmax(0,1fr) 58px}.rank-quality{display:none}.coverage-links{grid-template-columns:1fr}.coverage-links a{border-left:0}.coverage-links a:nth-child(2){border-top:1px solid var(--border)}}
.chart-canvas{position:relative;width:100%;height:100%}.chart-canvas svg{touch-action:none;cursor:crosshair}.chart-hover-layer{pointer-events:none}.chart-hover-guide{stroke:color-mix(in srgb,var(--text) 48%,transparent);stroke-width:1;stroke-dasharray:4 4;vector-effect:non-scaling-stroke}.chart-hover-point{stroke:var(--surface);stroke-width:2.5;vector-effect:non-scaling-stroke}.chart-hover-point.received{fill:var(--primary)}.chart-hover-point.completed{fill:var(--green)}.chart-hover-point.failed{fill:var(--danger)}.chart-tooltip{position:absolute;z-index:3;top:8px;display:grid;min-width:142px;gap:7px;padding:11px 12px;color:var(--text);background:color-mix(in srgb,var(--surface-raised) 94%,transparent);border:1px solid color-mix(in srgb,var(--primary) 35%,var(--border));border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.28);pointer-events:none;transform:translateX(10px);backdrop-filter:blur(14px)}.chart-tooltip.right{transform:translateX(calc(-100% - 10px))}.chart-tooltip strong{padding-bottom:5px;border-bottom:1px solid var(--border);font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}.chart-tooltip span{display:grid;grid-template-columns:7px 1fr auto;align-items:center;gap:7px;color:var(--text-soft);font-size:9px}.chart-tooltip i{width:7px;height:7px;background:var(--primary);border-radius:50%;box-shadow:0 0 8px color-mix(in srgb,var(--primary) 65%,transparent)}.chart-tooltip .completed i{background:var(--green);box-shadow:0 0 8px color-mix(in srgb,var(--green) 65%,transparent)}.chart-tooltip .failed i{background:var(--danger);box-shadow:0 0 8px color-mix(in srgb,var(--danger) 65%,transparent)}.chart-tooltip b{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
