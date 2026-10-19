<script setup lang="ts">
import {
  Clock3,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  FileText,
  GitBranch,
  BookOpen,
  ShieldCheck
} from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import PaginationBar from '../components/PaginationBar.vue'
import { formatTime, duration, runLabels, runColor, scheduleLabel } from '../scheduled'
import type { ScheduledTask, ScheduledRunSummary, ScheduledTemplate, SchedulerHealth, Workspace } from '../types'
const route = useRoute(),
  router = useRouter(),
  tab = ref(String(route.query.tab || 'tasks')),
  query = ref(''),
  workspaceId = ref(String(route.query.workspaceId || '')),
  enabled = ref(''),
  status = ref(''),
  from = ref(''),
  to = ref(''),
  taskId = ref(String(route.query.taskId || ''))
const items = ref<ScheduledTask[]>([]),
  runs = ref<ScheduledRunSummary[]>([]),
  templates = ref<ScheduledTemplate[]>([]),
  workspaces = ref<Workspace[]>([]),
  health = ref<SchedulerHealth | null>(null),
  maintenance = ref<{ paused: boolean; reason: string } | null>(null)
const total = ref(0),
  offset = ref(0),
  pageSize = 20,
  loading = ref(false),
  working = ref(''),
  error = ref(''),
  notice = ref('')
let alive = true,
  timer: ReturnType<typeof setInterval> | undefined
const wsName = (id: string) => workspaces.value.find((w) => w.id === id)?.name || '已删除工作区'
const selectedTaskName = computed(() => items.value.find((t) => t.id === taskId.value)?.name || '关联任务')
const load = async (quiet = false) => {
  if (loading.value) return
  const requested = tab.value
  loading.value = true
  if (!quiet) error.value = ''
  try {
    const [summary, result] = await Promise.all([
      api.scheduledHealth(),
      tab.value === 'runs'
        ? api.scheduledRuns({
            taskId: taskId.value,
            workspaceId: workspaceId.value,
            status: status.value,
            ...(from.value ? { from: new Date(from.value).toISOString() } : {}),
            ...(to.value ? { to: new Date(to.value).toISOString() } : {}),
            limit: pageSize,
            offset: offset.value
          })
        : api.scheduledTasks({
            workspaceId: workspaceId.value,
            query: query.value,
            enabled: enabled.value,
            limit: pageSize,
            offset: offset.value
          })
    ])
    if (!alive || tab.value !== requested) return
    health.value = summary
    total.value = result.total
    if (workspaceId.value) maintenance.value = await api.scheduledMaintenance(workspaceId.value)
    else maintenance.value = null
    if (tab.value === 'runs') runs.value = result.items as ScheduledRunSummary[]
    else items.value = result.items as ScheduledTask[]
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
    if (alive && tab.value !== requested) void load()
  }
}
const filter = async () => {
  offset.value = 0
  await load()
}
const move = async (value: number) => {
  offset.value = value
  await load()
}
const choose = (value: string) => {
  tab.value = value
  offset.value = 0
  void router.replace({
    query: {
      ...(workspaceId.value ? { workspaceId: workspaceId.value } : {}),
      tab: value,
      ...(taskId.value ? { taskId: taskId.value } : {})
    }
  })
  void load()
}
const resumeWorkspace = async () => {
  if (!confirm('请确认已检查并恢复工作区文件和技能状态。解除暂停后，新的任务将可以继续执行。')) return
  try {
    await api.resumeScheduledWorkspace(workspaceId.value)
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
const execute = async (task: ScheduledTask) => {
  working.value = task.id
  error.value = ''
  try {
    const run = await api.triggerScheduledTask(task.id)
    await router.push(`/scheduled-runs/${run.id}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '执行失败'
  } finally {
    working.value = ''
  }
}
const toggle = async (task: ScheduledTask) => {
  working.value = task.id
  error.value = ''
  try {
    await api.enableScheduledTask(task.id, !task.enabled)
    notice.value = task.enabled ? '已暂停后续触发，当前执行继续完成' : '已启用，下一次时间按当前计划计算'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '更新失败'
  } finally {
    working.value = ''
  }
}
const templateIcon = (id: string) =>
  id === 'workspace_sync'
    ? GitBranch
    : id === 'health_check'
      ? ShieldCheck
      : id === 'knowledge_review'
        ? BookOpen
        : FileText
const ready = async () => {
  try {
    ;[workspaces.value, templates.value] = await Promise.all([api.workspaces(), api.scheduledTemplates()])
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
onMounted(() => {
  void ready()
  timer = setInterval(() => {
    if (!document.hidden && tab.value !== 'templates' && !working.value) void load(true)
  }, 5000)
})
onUnmounted(() => {
  alive = false
  if (timer) clearInterval(timer)
})
watch(
  () => route.query.workspaceId,
  (value) => {
    if (String(value || '') !== workspaceId.value) {
      workspaceId.value = String(value || '')
      void filter()
    }
  }
)
</script>
<template>
  <div class="page scheduler">
    <header class="page-header">
      <div>
        <p class="eyebrow">Agent automation</p>
        <h1>定时任务</h1>
        <p class="page-description">给 AI 一个目标和时间，在指定工作区执行。每次结果、工具操作和 Thread 都可追溯。</p>
      </div>
      <div class="actions">
        <button class="ghost-button" :disabled="loading" @click="load()"><RefreshCw :size="16" />刷新</button
        ><button class="button" @click="choose('templates')"><Plus :size="17" />新建任务</button>
      </div>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="notice" class="notice" role="status">{{ notice }}</div>
    <section v-if="health" class="scheduler-metrics" aria-label="任务概览">
      <article>
        <span><Clock3 :size="16" />已启用任务</span
        ><strong
          >{{ health.enabledTasks }} <small>/ {{ health.totalTasks }}</small></strong
        >
        <p>关闭计划不会中断当前执行</p>
      </article>
      <article>
        <span><Play :size="16" />当前执行 / 排队</span
        ><strong
          >{{ health.activeTasks }} <small>/ {{ health.queuedTasks }}</small></strong
        >
        <p>
          {{ health.draining ? '正在排空，暂停派发新任务' : health.ready ? '调度器已就绪' : '调度器正在等待领取租约' }}
        </p>
      </article>
      <article>
        <span><CheckCircle2 :size="16" />近 24 小时执行</span><strong>{{ health.recentRuns }}</strong>
        <p>包含跳过与无更新的记录</p>
      </article>
      <article>
        <span><AlertTriangle :size="16" />失败 / 待确认</span
        ><strong
          >{{ health.recentFailed }} <small>/ {{ health.awaitingApproval }}</small></strong
        >
        <p>失败按近 24 小时统计</p>
      </article>
    </section>
    <div class="scheduler-tabs" role="tablist" aria-label="定时任务工作台">
      <button role="tab" :aria-selected="tab === 'tasks'" :class="{ active: tab === 'tasks' }" @click="choose('tasks')">
        任务列表</button
      ><button role="tab" :aria-selected="tab === 'runs'" :class="{ active: tab === 'runs' }" @click="choose('runs')">
        执行记录</button
      ><button
        role="tab"
        :aria-selected="tab === 'templates'"
        :class="{ active: tab === 'templates' }"
        @click="choose('templates')"
      >
        任务模板
      </button>
    </div>
    <div v-if="maintenance?.paused" class="error-banner">
      <strong>工作区因维护异常已暂停</strong>
      <p>{{ maintenance.reason }}</p>
      <button class="ghost-button" @click="resumeWorkspace">已核实，解除维护暂停</button>
    </div>
    <template v-if="tab === 'tasks'">
      <form class="scheduler-filters" @submit.prevent="filter">
        <label class="filter-search"
          ><Search :size="16" /><span class="sr-only">搜索任务</span
          ><input v-model="query" placeholder="搜索任务名称…" /></label
        ><label
          ><span class="sr-only">工作区</span
          ><select v-model="workspaceId" @change="filter">
            <option value="">全部工作区</option>
            <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select></label
        ><label
          ><span class="sr-only">启用状态</span
          ><select v-model="enabled" @change="filter">
            <option value="">全部状态</option>
            <option value="1">已启用</option>
            <option value="0">已暂停</option>
          </select></label
        ><button class="button">查询</button>
      </form>
      <section class="panel">
        <div v-if="!items.length && !loading" class="empty">
          <Clock3 :size="32" /><strong>还没有符合条件的定时任务</strong
          ><span>选择模板，配置 Prompt、工作区与执行计划。</span
          ><button class="button" @click="choose('templates')">从模板创建</button>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务 / 目标</th>
                <th>工作区 / 模型</th>
                <th>执行计划</th>
                <th>最近执行</th>
                <th>启用与操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in items" :key="task.id">
                <td>
                  <RouterLink class="scheduler-title" :to="`/scheduled-tasks/${task.id}`">{{ task.name }}</RouterLink
                  ><small>{{
                    task.description || (task.mode === 'maintenance' ? '维护与工具执行' : '只读分析')
                  }}</small>
                </td>
                <td>
                  {{ wsName(task.workspaceId)
                  }}<small
                    >{{ task.runtimeKind === 'codex' ? 'Codex' : 'TraeX' }} ·
                    {{ task.model || '继承平台默认模型' }}</small
                  >
                </td>
                <td>
                  {{ scheduleLabel(task.schedule)
                  }}<small
                    >{{ task.schedule.timezone }}<br />{{
                      task.enabled ? '下次 ' + formatTime(task.nextRunAt, task.schedule.timezone) : '已暂停自动执行'
                    }}</small
                  >
                </td>
                <td>
                  <RouterLink
                    v-if="task.lastRun"
                    :to="`/scheduled-runs/${task.lastRun.id}`"
                    :class="['badge', runColor(task.lastRun.status)]"
                    >{{ runLabels[task.lastRun.status] }}</RouterLink
                  ><span v-else class="badge gray">尚未执行</span
                  ><small v-if="task.lastRun">{{ formatTime(task.lastRun.createdAt) }}</small>
                </td>
                <td>
                  <div class="scheduler-row-actions">
                    <button
                      :class="['scheduler-toggle', { on: task.enabled }]"
                      role="switch"
                      :aria-checked="task.enabled"
                      :aria-label="`${task.enabled ? '暂停' : '启用'}${task.name}`"
                      :disabled="working === task.id"
                      @click="toggle(task)"
                    >
                      <span /></button
                    ><button class="ghost-button compact" :disabled="working === task.id" @click="execute(task)">
                      <Play :size="14" />执行</button
                    ><RouterLink class="ghost-button compact" :to="`/scheduled-tasks/${task.id}`">配置</RouterLink>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <PaginationBar :total="total" :offset="offset" :page-size="pageSize" :loading="loading" @change="move" />
      </section>
    </template>
    <template v-else-if="tab === 'runs'">
      <form class="scheduler-filters scheduler-run-filters" @submit.prevent="filter">
        <label
          ><span class="sr-only">工作区筛选</span
          ><select v-model="workspaceId">
            <option value="">全部工作区</option>
            <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select></label
        ><label
          ><span class="sr-only">执行结果筛选</span
          ><select v-model="status">
            <option value="">全部结果</option>
            <option v-for="(label, key) in runLabels" :key="key" :value="key">{{ label }}</option>
          </select></label
        ><label class="scheduler-date"
          >开始<input v-model="from" aria-label="记录开始时间" type="datetime-local" /></label
        ><label class="scheduler-date">结束<input v-model="to" aria-label="记录结束时间" type="datetime-local" /></label
        ><button class="button">查询</button>
      </form>
      <div v-if="taskId" class="notice">
        正在查看 {{ selectedTaskName }} 的记录。<button
          class="ghost-button compact"
          @click="
            taskId = ''
            filter()
          "
        >
          清除任务筛选
        </button>
      </div>
      <section class="panel">
        <div v-if="!runs.length && !loading" class="empty">
          <FileText :size="32" /><strong>当前没有执行记录</strong><span>手动执行或计划触发后，会自动记录结果。</span>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>执行任务</th>
                <th>时间 / 触发方式</th>
                <th>结果</th>
                <th>耗时</th>
                <th>结果投递</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.id">
                <td>
                  <RouterLink class="scheduler-title" :to="`/scheduled-runs/${run.id}`">{{ run.taskName }}</RouterLink
                  ><small>{{ wsName(run.workspaceId) }} · {{ run.model || '尚未调用模型' }}</small>
                </td>
                <td>
                  {{ formatTime(run.createdAt) }}<small>{{ run.trigger }}</small>
                </td>
                <td>
                  <span :class="['badge', runColor(run.status)]">{{ runLabels[run.status] }}</span>
                </td>
                <td>{{ duration(run.startedAt, run.completedAt) }}</td>
                <td>
                  <span :class="['badge', run.deliveryStatus === 'failed' ? 'orange' : 'gray']">{{
                    { none: '仅平台记录', pending: '投递中', sent: '已投递', failed: '投递失败，可单独重发' }[
                      run.deliveryStatus
                    ]
                  }}</span>
                </td>
                <td><RouterLink class="ghost-button compact" :to="`/scheduled-runs/${run.id}`">详情</RouterLink></td>
              </tr>
            </tbody>
          </table>
        </div>
        <PaginationBar :total="total" :offset="offset" :page-size="pageSize" :loading="loading" @change="move" />
      </section>
      <p class="scheduler-hint">结果发送失败时可单独重发，不会重新执行 AI 或业务工具。</p>
    </template>
    <template v-else>
      <div class="notice">模板预填任务目标与能力，可按需修改。模板更新不会静默改变已有任务。</div>
      <section class="scheduler-templates">
        <article v-for="template in templates" :key="template.id" class="panel">
          <component :is="templateIcon(template.id)" :size="27" />
          <h2>{{ template.name }}</h2>
          <span :class="['badge', template.mode === 'maintenance' ? 'blue' : 'gray']">{{
            template.mode === 'maintenance' ? '维护与工具执行' : '只读分析'
          }}</span>
          <p>{{ template.description }}</p>
          <RouterLink
            class="ghost-button"
            :to="{
              path: '/scheduled-tasks/new',
              query: { template: template.id, ...(workspaceId ? { workspaceId } : {}) }
            }"
            >{{ template.id === 'custom' ? '创建自定义任务' : '使用模板' }}<Sparkles :size="14"
          /></RouterLink>
        </article>
      </section>
    </template>
    <p class="scheduler-hint">当前列表每 5 秒刷新；离开页面或切到后台标签后暂停。所有时间均明确展示时区。</p>
  </div>
</template>
