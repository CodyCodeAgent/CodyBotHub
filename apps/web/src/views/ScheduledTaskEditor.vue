<script setup lang="ts">
import { ArrowLeft, ArrowRight, Check, Clock3, GitBranch, RefreshCw, Archive, AlertTriangle } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import ModelConfigFields from '../components/ModelConfigFields.vue'
import { formatTime, scheduleLabel } from '../scheduled'
import type {
  Bot,
  ChatMetadata,
  ModelCatalog,
  ScheduledTaskInput,
  ScheduledTemplate,
  SkillPackage,
  SkillSource,
  ToolPackage,
  Workspace,
  WorkspaceRepository
} from '../types'
const route = useRoute(),
  router = useRouter(),
  id = String(route.params.id || ''),
  step = ref(1),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  notice = ref(''),
  dirty = ref(false),
  loaded = ref(false)
const workspaces = ref<Workspace[]>([]),
  packages = ref<SkillPackage[]>([]),
  tools = ref<ToolPackage[]>([]),
  sources = ref<SkillSource[]>([]),
  bots = ref<Bot[]>([]),
  chats = ref<ChatMetadata[]>([])
const catalog = ref<ModelCatalog>({ items: [], defaultModel: '', defaultReasoningEffort: '' }),
  inheritedModel = ref(''),
  dates = ref<string[]>([]),
  previewError = ref(''),
  repository = ref<WorkspaceRepository | null>(null),
  checking = ref(false),
  skillRoots = ref('skills\n.agents/skills')
const moduleOptions = ref<
  Array<{
    path: string
    initialized: boolean
    commit: string
    selected: boolean
    mode: 'pinned' | 'branch'
    branch: string
    required: boolean
  }>
>([])
const form = reactive<ScheduledTaskInput>({
  name: '',
  description: '',
  workspaceId: '',
  template: 'custom',
  prompt: '',
  runtimeKind: 'codex',
  model: '',
  reasoningEffort: '',
  mode: 'read_only',
  skillPackageIds: [],
  toolPackageIds: [],
  schedule: {
    kind: 'daily',
    intervalMinutes: 120,
    time: '09:00',
    weekdays: [1],
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai'
  },
  enabled: false,
  timeoutMinutes: 30,
  overlap: 'skip',
  contextMode: 'fresh',
  output: { botId: '', chatId: '', when: 'always' },
  sync: {
    branch: 'master',
    submodules: [],
    installSkills: true,
    skillRoots: ['skills', '.agents/skills'],
    sourceIds: []
  }
})
let alive = true,
  previewTimer: ReturnType<typeof setTimeout> | undefined
const workspace = computed(() => workspaces.value.find((w) => w.id === form.workspaceId)),
  eligiblePackages = computed(() => packages.value.filter((p) => p.workspaceId === form.workspaceId)),
  eligibleTools = computed(() => tools.value.filter((t) => t.workspaceId === form.workspaceId && t.enabled)),
  eligibleSources = computed(() => sources.value.filter((s) => s.workspaceId === form.workspaceId)),
  eligibleBots = computed(() => bots.value.filter((b) => b.workspaceIds.includes(form.workspaceId))),
  eligibleChats = computed(() => chats.value.filter((c) => c.botId === form.output.botId && c.chatId.startsWith('oc_')))
const isSync = computed(() => form.template === 'workspace_sync'),
  editTitle = computed(() => (id ? '编辑定时任务' : '新建定时任务'))
const modelLoad = async () => {
  try {
    catalog.value = await api.models(form.runtimeKind)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法加载模型目录'
  }
}
const preview = async () => {
  try {
    dates.value = await api.scheduledPreview({ ...form.schedule })
    previewError.value = ''
  } catch (e) {
    dates.value = []
    previewError.value = e instanceof Error ? e.message : '计划不合法'
  }
}
const syncConfig = () => {
  form.sync.skillRoots = skillRoots.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  form.sync.submodules = moduleOptions.value
    .filter((m) => m.selected)
    .map(({ path, mode, branch, required }) => ({ path, mode, branch, required }))
}
const inspect = async () => {
  checking.value = true
  error.value = ''
  try {
    repository.value = await api.scheduledRepository(form.workspaceId)
    if (!id && !dirty.value) form.sync.branch = repository.value.branch || 'master'
    else if (!form.sync.branch) form.sync.branch = repository.value.branch || 'master'
    moduleOptions.value = repository.value.submodules.map((m) => {
      const existing = form.sync.submodules.find((s) => s.path === m.path)
      return {
        ...m,
        selected: Boolean(existing),
        mode: existing?.mode || 'pinned',
        branch: existing?.branch || '',
        required: existing?.required ?? true
      }
    })
    notice.value = repository.value.changes
      ? '检测到本地修改，同步时会保留现场并停止应用。'
      : '仓库与子模块已识别，请选择需要同步的服务。'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法识别 Git 仓库'
  } finally {
    checking.value = false
  }
}
const changeWorkspace = () => {
  form.skillPackageIds = []
  form.toolPackageIds = []
  form.output = { botId: '', chatId: '', when: 'always' }
  form.sync.submodules = []
  form.sync.sourceIds = []
  moduleOptions.value = []
  repository.value = null
}
const next = async () => {
  error.value = ''
  syncConfig()
  if (step.value === 1 && (!form.name.trim() || !form.prompt.trim() || !form.workspaceId)) {
    error.value = '请填写任务名称、工作区与 Prompt。'
    return
  }
  if (step.value === 2) {
    await preview()
    if (previewError.value) {
      error.value = previewError.value
      return
    }
    if (Boolean(form.output.botId) !== Boolean(form.output.chatId)) {
      error.value = '发送 Bot 和接收群需要同时配置。'
      return
    }
    if (
      form.toolPackageIds.some((k) => eligibleTools.value.find((t) => t.id === k)?.approvalRequired) &&
      (!form.output.botId || !form.output.chatId)
    ) {
      error.value = '所选工具包需要人工审批，请设置发送 Bot 与接收群。'
      return
    }
  }
  step.value++
  window.scrollTo({ top: 0 })
}
const save = async () => {
  syncConfig()
  saving.value = true
  error.value = ''
  try {
    const task = await api.saveScheduledTask(JSON.parse(JSON.stringify(form)) as ScheduledTaskInput, id || undefined)
    dirty.value = false
    await router.push({ path: '/scheduled-tasks', query: { workspaceId: task.workspaceId } })
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
const archive = async () => {
  if (!confirm('归档后不再触发该任务，历史执行记录仍然保留。确定归档？')) return
  try {
    await api.archiveScheduledTask(id)
    dirty.value = false
    await router.push('/scheduled-tasks')
  } catch (e) {
    error.value = String(e)
  }
}
onBeforeRouteLeave(() => !dirty.value || confirm('当前任务配置尚未保存，确定离开？'))
watch(
  form,
  () => {
    if (loaded.value) dirty.value = true
  },
  { deep: true }
)
watch(
  () => form.runtimeKind,
  () => {
    if (loaded.value) {
      form.model = ''
      form.reasoningEffort = ''
      void modelLoad()
    }
  }
)
watch(
  () => form.mode,
  (value) => {
    if (value === 'read_only') form.toolPackageIds = []
  }
)
watch(
  () => form.schedule,
  () => {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      if (alive) void preview()
    }, 400)
  },
  { deep: true }
)
watch(
  () => form.output.botId,
  () => {
    if (loaded.value) form.output.chatId = ''
  }
)
onMounted(async () => {
  try {
    const [ws, pk, tp, so, bo, settings, ts, ch] = await Promise.all([
      api.workspaces(),
      api.skillPackages(),
      api.toolPackages(),
      api.skillSources(),
      api.bots(),
      api.settings(),
      api.scheduledTemplates(),
      api.chats({ limit: 500 })
    ])
    workspaces.value = ws
    packages.value = pk
    tools.value = tp
    sources.value = so
    bots.value = bo
    chats.value = ch
    inheritedModel.value = settings.defaultModel
    if (id) {
      const task = await api.scheduledTask(id)
      Object.assign(form, task)
      moduleOptions.value = task.sync.submodules.map((m) => ({ ...m, selected: true, initialized: true, commit: '' }))
      skillRoots.value = task.sync.skillRoots.join('\n')
    } else {
      form.workspaceId = String(route.query.workspaceId || ws[0]?.id || '')
      const template = (ts as ScheduledTemplate[]).find((t) => t.id === String(route.query.template || 'custom'))
      if (template) {
        form.template = template.id
        form.prompt = template.prompt
        form.name = template.id === 'custom' ? '' : template.name
        form.description = template.description
        form.mode = template.mode
        if (template.id === 'workspace_sync') form.schedule.kind = 'interval'
      }
    }
    await modelLoad()
    await preview()
    if (isSync.value && form.workspaceId) {
      try {
        const repo = await api.scheduledRepository(form.workspaceId)
        repository.value = repo
        if (!id) form.sync.branch = repo.branch || 'master'
        moduleOptions.value = repo.submodules.map((m) => {
          const old = form.sync.submodules.find((s) => s.path === m.path)
          return {
            ...m,
            selected: Boolean(old),
            mode: old?.mode || 'pinned',
            branch: old?.branch || '',
            required: old?.required ?? true
          }
        })
      } catch (e) {
        notice.value = `暂未识别仓库：${String(e)}`
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    await nextTick()
    loading.value = false
    loaded.value = true
    dirty.value = false
  }
})
onUnmounted(() => {
  alive = false
  if (previewTimer) clearTimeout(previewTimer)
})
</script>
<template>
  <div class="page scheduler">
    <RouterLink class="scheduler-back" to="/scheduled-tasks"><ArrowLeft :size="15" />返回任务列表</RouterLink>
    <header class="page-header">
      <div>
        <p class="eyebrow">Configure an AI task</p>
        <h1>{{ editTitle }}</h1>
        <p class="page-description">目标、能力、执行计划分别配置。保存配置不会立即执行，启用后按计划触发。</p>
      </div>
      <button v-if="id" class="danger-button" @click="archive"><Archive :size="16" />归档任务</button>
    </header>
    <div v-if="loading" class="empty">正在加载工作区、能力与模型目录…</div>
    <template v-else
      ><div v-if="notice" class="notice" role="status">{{ notice }}</div>
      <div class="scheduler-steps">
        <span
          v-for="(label, i) in ['目标与能力', '计划与输出', '检查并保存']"
          :key="label"
          :class="{ active: step === i + 1 }"
          ><b>{{ i + 1 }}</b
          >{{ label }}</span
        >
      </div>
      <form @submit.prevent="step === 3 ? save() : next()">
        <div class="scheduler-editor-grid">
          <div class="scheduler-editor-main">
            <template v-if="step === 1"
              ><section class="panel">
                <div class="panel-header"><h2>告诉 AI 要做什么</h2></div>
                <div class="scheduler-form-body">
                  <div class="field">
                    <label for="task-name">任务名称 *</label
                    ><input
                      id="task-name"
                      v-model.trim="form.name"
                      maxlength="120"
                      required
                      placeholder="例如：AI Hub 资源同步"
                    />
                  </div>
                  <div class="field">
                    <label for="task-description">用途说明</label
                    ><input
                      id="task-description"
                      v-model="form.description"
                      maxlength="2000"
                      placeholder="便于列表中快速看懂这个任务"
                    />
                  </div>
                  <div class="field-grid">
                    <div class="field">
                      <label for="task-workspace">工作区 *</label
                      ><select id="task-workspace" v-model="form.workspaceId" @change="changeWorkspace">
                        <option value="" disabled>请选择</option>
                        <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option></select
                      ><small>{{ workspace?.path }} · 不需要绑定 Bot 或场景。</small>
                    </div>
                    <div class="field">
                      <label for="task-engine">AI 引擎</label
                      ><select id="task-engine" v-model="form.runtimeKind">
                        <option value="codex">Codex</option>
                        <option value="traex">TraeX</option>
                      </select>
                    </div>
                  </div>
                  <ModelConfigFields
                    :catalog="catalog"
                    v-model:model="form.model"
                    v-model:reasoning-effort="form.reasoningEffort"
                    inherit-label="继承平台默认模型"
                    :inherited-model="inheritedModel"
                  />
                  <div class="field">
                    <label for="task-prompt">任务 Prompt *</label
                    ><textarea
                      id="task-prompt"
                      v-model="form.prompt"
                      rows="10"
                      required
                      placeholder="目标、信息来源、操作边界、完成标准和输出要求…"
                    /><small v-pre
                      >支持 {{ current_time }}、{{ last_success_at }}、{{ last_result_summary }}、{{
                        run_id
                      }}。其他占位文本保持原样。</small
                    >
                  </div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-header"><h2>任务可以使用的能力</h2></div>
                <div class="scheduler-form-body">
                  <div class="field">
                    <label for="task-mode">能力模式</label
                    ><select id="task-mode" v-model="form.mode">
                      <option value="read_only">只读分析</option>
                      <option value="maintenance">维护与工具执行</option></select
                    ><small>AI 原生沙箱为只读；受管同步和授权工具包通过平台工具执行。</small>
                  </div>
                  <div class="field">
                    <span class="field-label">技能包</span>
                    <div class="check-grid">
                      <label v-for="p in eligiblePackages" :key="p.id" class="check-card"
                        ><input v-model="form.skillPackageIds" type="checkbox" :value="p.id" /><span>{{
                          p.name
                        }}</span></label
                      >
                    </div>
                    <small v-if="!eligiblePackages.length">当前工作区没有技能包，仍可使用原生工作区技能与知识。</small>
                  </div>
                  <div v-if="form.mode === 'maintenance'" class="field">
                    <span class="field-label">允许申请或执行的工具包</span>
                    <div class="check-grid">
                      <label v-for="t in eligibleTools" :key="t.id" class="check-card"
                        ><input v-model="form.toolPackageIds" type="checkbox" :value="t.id" /><span
                          >{{ t.name }}
                          <small>{{ t.approvalRequired ? '需要人工确认' : '按配置自动执行' }}</small></span
                        ></label
                      >
                    </div>
                    <small>只有明确选中的工具包可以调用，原审批人和配置规则继续生效。</small>
                  </div>
                </div>
              </section>
              <section v-if="isSync || form.mode === 'maintenance'" class="panel">
                <div class="panel-header">
                  <h2><GitBranch :size="17" />工作区资源同步</h2>
                  <button
                    class="ghost-button compact"
                    type="button"
                    :disabled="checking || !form.workspaceId"
                    @click="inspect"
                  >
                    <RefreshCw :size="14" />{{ checking ? '检查中…' : '识别仓库' }}
                  </button>
                </div>
                <div class="scheduler-form-body">
                  <p class="scheduler-hint">
                    这些配置只在 AI 调用受管同步工具时生效。工作区本地修改会被保留，不自动清理。
                  </p>
                  <div v-if="repository" class="notice">
                    当前分支：{{ repository.branch || '游离 HEAD' }} · {{ repository.commit.slice(0, 12) }}<br />{{
                      repository.changes ? '存在本地修改，应用前需要处理' : '当前未检测到主仓库文件修改'
                    }}
                  </div>
                  <div class="field">
                    <label for="sync-branch">主仓库跟踪分支</label
                    ><input id="sync-branch" v-model.trim="form.sync.branch" placeholder="master / main" />
                  </div>
                  <details v-if="moduleOptions.length">
                    <summary>
                      选择子模块与更新策略（已选 {{ moduleOptions.filter((m) => m.selected).length }} /
                      {{ moduleOptions.length }}）
                    </summary>
                    <div class="actions scheduler-module-actions">
                      <button
                        class="ghost-button compact"
                        type="button"
                        @click="moduleOptions.forEach((m) => (m.selected = m.initialized))"
                      >
                        选择已初始化服务</button
                      ><button
                        class="ghost-button compact"
                        type="button"
                        @click="moduleOptions.forEach((m) => (m.selected = false))"
                      >
                        清空选择
                      </button>
                    </div>
                    <div class="scheduler-module-list">
                      <div v-for="m in moduleOptions" :key="m.path" class="scheduler-module">
                        <label class="check-card"
                          ><input v-model="m.selected" type="checkbox" :disabled="!m.initialized" /><span
                            >{{ m.path
                            }}<small>{{ m.initialized ? m.commit.slice(0, 10) : '未初始化，保留现状' }}</small></span
                          ></label
                        >
                        <div v-if="m.selected" class="field-grid">
                          <label
                            >更新方式<select v-model="m.mode">
                              <option value="pinned">跟随主仓库提交</option>
                              <option value="branch">指定分支最新版本</option>
                            </select></label
                          ><label v-if="m.mode === 'branch'"
                            >目标分支<input v-model.trim="m.branch" placeholder="请填写实际分支" /></label
                          ><label class="check-card"
                            ><input v-model="m.required" type="checkbox" /><span>必选项，失败则停止应用</span></label
                          >
                        </div>
                      </div>
                    </div>
                  </details>
                  <label class="check-card"
                    ><input v-model="form.sync.installSkills" type="checkbox" /><span
                      >扫描并自动安装、更新技能<small>按内容比较，保留虚拟环境、本地配置与认证文件。</small></span
                    ></label
                  >
                  <div v-if="form.sync.installSkills" class="field">
                    <label for="skill-roots">技能扫描目录（每行一个相对路径）</label
                    ><textarea id="skill-roots" v-model="skillRoots" rows="3" />
                  </div>
                  <details v-if="eligibleSources.length">
                    <summary>额外同步平台配置的独立技能源</summary>
                    <label v-for="source in eligibleSources" :key="source.id" class="check-card"
                      ><input v-model="form.sync.sourceIds" type="checkbox" :value="source.id" /><span
                        >{{ source.name }}<small>{{ source.branch }} · 沿用该来源的安装及知识库配置</small></span
                      ></label
                    >
                  </details>
                </div>
              </section></template
            >
            <template v-else-if="step === 2"
              ><section class="panel">
                <div class="panel-header"><h2>什么时候执行</h2></div>
                <div class="scheduler-form-body">
                  <div class="field">
                    <label for="schedule-kind">周期类型</label
                    ><select id="schedule-kind" v-model="form.schedule.kind">
                      <option value="interval">按间隔</option>
                      <option value="daily">每天</option>
                      <option value="weekly">每周</option>
                      <option value="cron">自定义 Cron</option>
                    </select>
                  </div>
                  <div class="field-grid">
                    <div v-if="form.schedule.kind === 'interval'" class="field">
                      <label for="schedule-interval">间隔（分钟）</label
                      ><input
                        id="schedule-interval"
                        v-model.number="form.schedule.intervalMinutes"
                        type="number"
                        min="1"
                        max="525600"
                      />
                    </div>
                    <div v-else-if="form.schedule.kind !== 'cron'" class="field">
                      <label for="schedule-time">执行时间</label
                      ><input id="schedule-time" v-model="form.schedule.time" type="time" />
                    </div>
                    <div v-else class="field">
                      <label for="schedule-cron">5 段 Cron</label
                      ><input id="schedule-cron" v-model="form.schedule.cron" placeholder="0 9 * * 1-5" />
                    </div>
                    <div class="field">
                      <label for="schedule-timezone">时区</label
                      ><input id="schedule-timezone" v-model.trim="form.schedule.timezone" list="timezones" /><datalist
                        id="timezones"
                      >
                        <option>Asia/Shanghai</option>
                        <option>UTC</option>
                        <option>America/Los_Angeles</option>
                      </datalist>
                    </div>
                  </div>
                  <div v-if="form.schedule.kind === 'weekly'" class="check-grid">
                    <label v-for="(day, i) in ['日', '一', '二', '三', '四', '五', '六']" :key="i" class="check-card"
                      ><input v-model="form.schedule.weekdays" type="checkbox" :value="i" />周{{ day }}</label
                    >
                  </div>
                  <div v-if="previewError" class="error-banner" role="alert">{{ previewError }}</div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-header"><h2>结果与审批发送到哪里</h2></div>
                <div class="scheduler-form-body">
                  <div class="notice">最终报告始终保存到平台。需要发送群报告或审批卡片时，再配置下面的 Bot 和群。</div>
                  <div class="field-grid">
                    <div class="field">
                      <label for="output-bot">发送 Bot</label
                      ><select id="output-bot" v-model="form.output.botId">
                        <option value="">仅保存在平台</option>
                        <option v-for="bot in eligibleBots" :key="bot.id" :value="bot.id">{{ bot.name }}</option>
                      </select>
                    </div>
                    <div class="field">
                      <label for="output-chat">接收群 Chat ID</label
                      ><input
                        id="output-chat"
                        v-model.trim="form.output.chatId"
                        :disabled="!form.output.botId"
                        list="known-task-chats"
                        placeholder="选择已知群或输入 oc_…"
                      /><datalist id="known-task-chats">
                        <option v-for="chat in eligibleChats" :key="chat.chatId" :value="chat.chatId">
                          {{ chat.name || chat.chatId }}
                        </option>
                      </datalist>
                    </div>
                  </div>
                  <div v-if="form.output.botId" class="field">
                    <label for="output-when">报告通知策略</label
                    ><select id="output-when" v-model="form.output.when">
                      <option value="always">每次有最终结果都发送</option>
                      <option value="attention">仅失败、警告或中断时发送</option></select
                    ><small>工具包审批卡片独立发送；报告发送失败可单独重试，不重跑任务。</small>
                  </div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-header"><h2>执行策略</h2></div>
                <div class="scheduler-form-body">
                  <div class="field-grid">
                    <div class="field">
                      <label for="task-timeout">单次运行时限（分钟）</label
                      ><input id="task-timeout" v-model.number="form.timeoutMinutes" type="number" min="1" max="240" />
                    </div>
                    <div class="field">
                      <label for="task-overlap">上次未结束时</label
                      ><select id="task-overlap" v-model="form.overlap">
                        <option value="skip">跳过本次，并留记录</option>
                        <option value="merge">合并为一次待执行任务</option>
                      </select>
                    </div>
                  </div>
                  <details>
                    <summary>高级配置</summary>
                    <div class="field scheduler-advanced">
                      <label for="task-context">Thread 上下文</label
                      ><select id="task-context" v-model="form.contextMode">
                        <option value="fresh">每次新建 Thread，参考上次成功摘要</option>
                        <option value="reuse">复用该任务专属 Thread</option></select
                      ><small>任务线程独立于群会话，不会与机器人对话抢占绑定。审批结果续写本次任务 Thread。</small>
                    </div>
                    <p class="scheduler-hint">
                      进程中断后的未知副作用不会自动重试整轮；审批最长等待 6 小时，拒绝后本轮不重复申请。
                    </p>
                  </details>
                </div>
              </section></template
            >
            <template v-else
              ><section class="panel">
                <div class="panel-header"><h2>检查并保存</h2></div>
                <div class="scheduler-form-body">
                  <h2>{{ form.name }}</h2>
                  <p class="scheduler-hint">
                    {{ workspace?.name }} · {{ form.runtimeKind }} ·
                    {{ form.mode === 'maintenance' ? '维护与工具执行' : '只读分析' }}
                  </p>
                  <pre class="scheduler-prompt">{{ form.prompt }}</pre>
                  <dl class="scheduler-definition">
                    <div>
                      <dt>执行计划</dt>
                      <dd>{{ scheduleLabel(form.schedule) }} · {{ form.schedule.timezone }}</dd>
                    </div>
                    <div>
                      <dt>模型</dt>
                      <dd>
                        {{ form.model || inheritedModel || '引擎账户默认' }} ·
                        {{ form.reasoningEffort || '默认推理强度' }}
                      </dd>
                    </div>
                    <div>
                      <dt>结果输出</dt>
                      <dd>{{ form.output.botId ? '平台记录，并发送到 ' + form.output.chatId : '仅保存在平台' }}</dd>
                    </div>
                    <div>
                      <dt>配置生效</dt>
                      <dd>本次保存只影响后续执行；当前运行使用原配置快照。</dd>
                    </div>
                  </dl>
                  <label class="check-card"
                    ><input v-model="form.enabled" type="checkbox" /><span
                      >保存后启用自动执行<small>默认保持暂停，可以先手动执行一次。</small></span
                    ></label
                  >
                </div>
              </section></template
            >
            <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
          </div>
          <aside class="scheduler-preview">
            <section class="panel">
              <div class="panel-header">
                <h2><Clock3 :size="17" />任务预览</h2>
                <span class="badge gray">{{ dirty ? '未保存' : '配置草稿' }}</span>
              </div>
              <div class="scheduler-form-body">
                <h2>{{ form.name || '尚未命名' }}</h2>
                <dl class="scheduler-definition">
                  <div>
                    <dt>工作区</dt>
                    <dd>{{ workspace?.name || '请选择' }}</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>{{ form.model || inheritedModel || '引擎账户默认' }}</dd>
                  </div>
                  <div>
                    <dt>模式</dt>
                    <dd>{{ form.mode === 'maintenance' ? '维护与工具执行' : '只读分析' }}</dd>
                  </div>
                  <div>
                    <dt>Thread</dt>
                    <dd>{{ form.contextMode === 'fresh' ? '每次新建' : '任务专属，串行复用' }}</dd>
                  </div>
                </dl>
                <span class="field-label">未来三次执行预览</span>
                <div class="scheduler-next-dates">
                  <template v-if="dates.length"
                    ><div v-for="date in dates" :key="date">
                      {{ formatTime(date, form.schedule.timezone) }}
                    </div></template
                  ><span v-else>{{ previewError || '计算中…' }}</span
                  ><small>{{ form.schedule.timezone }} · 若未启用则不触发</small>
                </div>
                <p class="scheduler-hint">关闭页面不影响任务。停机错过的周期不批量补跑。</p>
              </div>
            </section>
          </aside>
        </div>
        <footer class="scheduler-form-footer">
          <span>步骤 {{ step }} / 3</span>
          <div class="actions">
            <RouterLink class="ghost-button" to="/scheduled-tasks">取消</RouterLink
            ><button
              v-if="step > 1"
              class="ghost-button"
              type="button"
              @click="
                step--
                error = ''
              "
            >
              <ArrowLeft :size="15" />上一步</button
            ><button class="button" :disabled="saving">
              <component :is="step === 3 ? Check : ArrowRight" :size="16" />{{
                saving ? '保存中…' : step === 3 ? '保存任务' : '下一步'
              }}
            </button>
          </div>
        </footer>
      </form></template
    >
  </div>
</template>
