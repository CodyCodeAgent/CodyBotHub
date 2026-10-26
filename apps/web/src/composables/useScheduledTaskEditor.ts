import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { applySyncDraft, createScheduledTaskInput, validateDeliveryStep, validateTaskStep, type ScheduledSubmoduleOption } from '../scheduled-editor'
import type { Bot, ChatMetadata, ModelCatalog, ScheduledTaskInput, ScheduledTemplate, SkillPackage, SkillSource, ToolPackage, Workspace, WorkspaceRepository } from '../types'

export function useScheduledTaskEditor() {
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
  skillRoots = ref('skills\n.agents/skills'),
  preserveLocalFiles = ref('')
const moduleOptions = ref<Array<ScheduledSubmoduleOption & { initialized: boolean; commit: string }>>([])
const form = reactive<ScheduledTaskInput>(createScheduledTaskInput())
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
  applySyncDraft(form, skillRoots.value, preserveLocalFiles.value, moduleOptions.value)
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
      ? '检测到本地修改：仅本机保留清单中的文件允许保留后更新，其他修改会阻止同步。'
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
  form.sync.preserveLocalFiles = []
  preserveLocalFiles.value = ''
  moduleOptions.value = []
  repository.value = null
}
const next = async () => {
  error.value = ''
  syncConfig()
  if (step.value === 1) error.value = validateTaskStep(form)
  if (error.value) return
  if (step.value === 2) {
    await preview()
    if (previewError.value) {
      error.value = previewError.value
      return
    }
    error.value = validateDeliveryStep(form, eligibleTools.value)
    if (error.value) return
  }
  step.value++
  window.scrollTo({ top: 0 })
}
const previousStep = () => {
  step.value--
  error.value = ''
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
  [skillRoots, preserveLocalFiles, moduleOptions],
  () => {
    if (loaded.value) dirty.value = true
  },
  { deep: true }
)
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
      preserveLocalFiles.value = (task.sync.preserveLocalFiles || []).join('\n')
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
  return { id, step, loading, saving, error, notice, dirty, workspaces, catalog, inheritedModel, dates, previewError, repository, checking, skillRoots, preserveLocalFiles, moduleOptions, form, workspace, eligiblePackages, eligibleTools, eligibleSources, eligibleBots, eligibleChats, isSync, editTitle, inspect, changeWorkspace, next, previousStep, save, archive }
}
