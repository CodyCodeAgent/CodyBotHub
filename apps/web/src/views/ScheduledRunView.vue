<script setup lang="ts">
import { CodyMarkdown } from '@codycodeagent/cody-web-core/vue'
import { ArrowLeft, Copy, CheckCircle2, AlertTriangle, RefreshCw, Square, Clock3 } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { duration, formatTime, runLabels, runColor } from '../scheduled'
import type { ScheduledRun } from '../types'
const route = useRoute(),
  router = useRouter(),
  run = ref<ScheduledRun | null>(null),
  error = ref(''),
  notice = ref(''),
  loading = ref(false),
  working = ref(false)
let timer: ReturnType<typeof setInterval> | undefined,
  alive = true
const active = computed(() => run.value && ['queued', 'running', 'awaiting_approval'].includes(run.value.status))
const isDark = ref(document.documentElement.dataset.theme !== 'light')
const observer = new MutationObserver(() => {
  isDark.value = document.documentElement.dataset.theme !== 'light'
})
const load = async () => {
  if (loading.value) return
  const requested = String(route.params.id)
  loading.value = true
  try {
    const value = await api.scheduledRun(String(route.params.id))
    if (alive && String(route.params.id) === requested) run.value = value
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
    if (alive && String(route.params.id) !== requested) void load()
  }
}
const repeat = async () => {
  if (!run.value) return
  if (
    ['interrupted', 'warning'].includes(run.value.status) &&
    !confirm('重新执行会创建新的一轮任务。请确认已核实上一轮可能产生的外部操作，避免重复执行。')
  )
    return
  working.value = true
  error.value = ''
  try {
    const next = await api.triggerScheduledTask(run.value.taskId)
    await router.push(`/scheduled-runs/${next.id}`)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '执行失败'
  } finally {
    working.value = false
  }
}
const cancel = async () => {
  if (
    !run.value ||
    !confirm(
      run.value.status === 'running'
        ? '请求中断当前执行？已经完成的外部操作不会自动回滚。'
        : '取消本次排队或待审批执行？'
    )
  )
    return
  working.value = true
  try {
    run.value = await api.cancelScheduledRun(run.value.id)
    notice.value = '已提交处理请求，当前状态会自动刷新'
  } catch (e) {
    error.value = String(e)
  } finally {
    working.value = false
  }
}
const retry = async () => {
  if (!run.value) return
  working.value = true
  try {
    run.value = await api.retryScheduledDelivery(run.value.id)
    notice.value = run.value.deliveryStatus === 'sent' ? '结果已重新投递，任务没有重跑' : '投递仍未成功，请查看投递错误'
  } catch (e) {
    error.value = String(e)
  } finally {
    working.value = false
  }
}
const copy = async () => {
  if (!run.value) return
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          runId: run.value.id,
          taskId: run.value.taskId,
          threadId: run.value.coreThreadId,
          status: run.value.status,
          model: run.value.model,
          error: run.value.error
        },
        null,
        2
      )
    )
    notice.value = '排查信息已复制'
  } catch {
    error.value = '浏览器不允许写入剪贴板，请手动复制下面的信息'
  }
}
const pretty = (data: unknown) => JSON.stringify(data, null, 2)
watch(
  () => route.params.id,
  () => {
    run.value = null
    void load()
  }
)
onMounted(() => {
  void load()
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  timer = setInterval(() => {
    if (!document.hidden && active.value && !working.value) void load()
  }, 5000)
})
onUnmounted(() => {
  alive = false
  if (timer) clearInterval(timer)
  observer.disconnect()
})
</script>
<template>
  <div class="page scheduler">
    <RouterLink class="scheduler-back" to="/scheduled-tasks?tab=runs"><ArrowLeft :size="15" />返回执行记录</RouterLink>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="notice" class="notice" role="status">{{ notice }}</div>
    <template v-if="run"
      ><header class="page-header">
        <div>
          <p class="eyebrow">Execution detail</p>
          <h1>{{ run.taskName }}</h1>
          <p class="page-description">先看结果与影响，再展开真实工具执行过程。</p>
        </div>
        <div class="actions">
          <RouterLink class="ghost-button" :to="`/scheduled-tasks/${run.taskId}`"
            ><Clock3 :size="16" />任务配置</RouterLink
          ><button v-if="active" class="danger-button" :disabled="working" @click="cancel">
            <Square :size="15" />{{ run.status === 'running' ? '请求中断' : '取消本次执行' }}</button
          ><button v-else class="ghost-button" :disabled="working" @click="repeat">
            <RefreshCw :size="16" />重新执行</button
          ><button v-if="run.deliveryStatus === 'failed' && !active" class="button" :disabled="working" @click="retry">
            仅重试投递
          </button>
        </div>
      </header>
      <section class="panel scheduler-run-meta">
        <div>
          <small>执行状态</small><span :class="['badge', runColor(run.status)]">{{ runLabels[run.status] }}</span>
        </div>
        <div>
          <small>开始 / 触发时间</small><strong>{{ formatTime(run.startedAt || run.createdAt) }}</strong
          ><small>{{ run.trigger }}</small>
        </div>
        <div>
          <small>耗时</small><strong>{{ duration(run.startedAt, run.completedAt) }}</strong>
        </div>
        <div>
          <small>结果投递</small
          ><strong>{{
            { none: '仅平台记录', pending: '投递中', sent: '已投递', failed: '投递失败' }[run.deliveryStatus]
          }}</strong>
        </div>
      </section>
      <div v-if="run.error" class="error-banner scheduler-result" role="alert">
        <AlertTriangle :size="19" />
        <div>
          <strong>{{ runLabels[run.status] }}</strong>
          <p>{{ run.error }}</p>
        </div>
      </div>
      <div v-if="run.deliveryError" class="notice">
        <strong>结果投递失败</strong>：{{ run.deliveryError }}。任务结果仍已保存，单独重发不会重复执行。
      </div>
      <div v-if="run.status === 'awaiting_approval'" class="notice">
        审批卡片已发送到配置的飞书群。确认、拒绝或过期后，结果会回到本任务 Thread。拒绝的操作本轮不再申请。
      </div>
      <div class="scheduler-detail-grid">
        <div>
          <section class="panel">
            <div class="panel-header">
              <h2><CheckCircle2 :size="17" />{{ active ? '当前可展示结果' : '最终报告' }}</h2>
              <span class="badge gray">不展示思考摘要</span>
            </div>
            <div class="scheduler-report">
              <CodyMarkdown v-if="run.report" :text="run.report" :dark="isDark" />
              <p v-else class="scheduler-hint">
                {{
                  active ? '正在等待任务产生结果，关闭页面不影响执行。' : '本次没有 AI 文本报告，请查看执行原因和步骤。'
                }}
              </p>
            </div>
          </section>
          <section v-if="run.actions.length" class="panel">
            <div class="panel-header"><h2>工具包申请与执行</h2></div>
            <div class="scheduler-form-body">
              <details v-for="action in run.actions" :key="action.id" class="scheduler-event">
                <summary>
                  {{ action.packageName }} ·
                  {{
                    {
                      awaiting_approval: '等待确认',
                      queued: '排队中',
                      running: '执行中',
                      completed: '成功',
                      failed: '失败',
                      rejected: '已拒绝',
                      expired: '已过期'
                    }[action.status]
                  }}
                </summary>
                <p>{{ action.reason }}</p>
                <p v-if="action.error" class="error-banner">{{ action.error }}</p>
                <small
                  >请求：{{ action.id }}<br />操作人：{{ action.operatorId || '—' }}<br />审批到期：{{
                    formatTime(action.expiresAt)
                  }}</small
                >
                <pre>{{ pretty({ arguments: action.arguments, result: action.result }) }}</pre>
              </details>
            </div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <h2>执行步骤与真实工具结果</h2>
              <span class="badge gray">最近 {{ run.events.length }} 条</span>
            </div>
            <div class="scheduler-form-body">
              <p v-if="!run.events.length" class="scheduler-hint">执行开始后展示步骤。</p>
              <details v-for="event in run.events" :key="event.id" class="scheduler-event">
                <summary>
                  <span>{{ event.message }}</span
                  ><small>{{ formatTime(event.at) }} · {{ event.phase }}</small>
                </summary>
                <pre v-if="event.data !== null">{{ pretty(event.data) }}</pre>
                <p v-else class="scheduler-hint">没有附加结构化数据。</p>
              </details>
            </div>
          </section>
        </div>
        <aside>
          <section class="panel">
            <div class="panel-header"><h2>执行上下文</h2></div>
            <div class="scheduler-form-body">
              <dl class="scheduler-definition">
                <div>
                  <dt>执行 ID</dt>
                  <dd class="mono">{{ run.id }}</dd>
                </div>
                <div>
                  <dt>Thread ID</dt>
                  <dd class="mono">{{ run.coreThreadId || '尚未创建' }}</dd>
                </div>
                <div>
                  <dt>工作区</dt>
                  <dd class="mono">{{ run.snapshot.workspacePath }}</dd>
                </div>
                <div>
                  <dt>实际模型</dt>
                  <dd>{{ run.model || '尚未解析' }} · {{ run.reasoningEffort || '默认' }}</dd>
                </div>
                <div>
                  <dt>配置版本</dt>
                  <dd>v{{ run.snapshot.revision }}</dd>
                </div>
                <div>
                  <dt>引擎 / 模式</dt>
                  <dd>
                    {{ run.snapshot.runtimeKind }} ·
                    {{ run.snapshot.mode === 'maintenance' ? '维护与工具执行' : '只读分析' }}
                  </dd>
                </div>
              </dl>
              <button class="ghost-button full" @click="copy"><Copy :size="16" />复制排查信息</button>
              <details class="scheduler-event">
                <summary>执行时的任务要求</summary>
                <pre>{{ run.snapshot.prompt }}</pre>
              </details>
            </div>
          </section>
          <p class="scheduler-hint">配置快照随本轮执行保存。后来修改任务，不会改写这里的历史事实。</p>
        </aside>
      </div>
    </template>
    <div v-else-if="loading" class="empty">正在加载执行记录…</div>
  </div>
</template>
