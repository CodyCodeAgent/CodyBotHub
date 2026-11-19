import type { ScheduledTaskInput } from './types'

export type ScheduledSubmoduleOption = {
  path: string
  selected: boolean
  mode: 'pinned' | 'branch' | 'merge'
  branch: string
  required: boolean
}

const normalizedLines = (value: string): string[] => [
  ...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))
]

export const createScheduledTaskInput = (): ScheduledTaskInput => ({
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
    sourceIds: [],
    preserveLocalFiles: []
  }
})

export const applySyncDraft = (
  form: ScheduledTaskInput,
  skillRoots: string,
  preserveLocalFiles: string,
  modules: ScheduledSubmoduleOption[]
) => {
  form.sync.skillRoots = normalizedLines(skillRoots)
  form.sync.preserveLocalFiles = normalizedLines(preserveLocalFiles)
  form.sync.submodules = modules
    .filter(module => module.selected)
    .map(({ path, mode, branch, required }) => ({ path, mode, branch, required }))
}

export const validateTaskStep = (form: ScheduledTaskInput): string => {
  if (!form.name.trim() || !form.prompt.trim() || !form.workspaceId) return '请填写任务名称、工作区与 Prompt。'
  if (form.mode === 'maintenance') return '旧版维护任务请先选择只读或 YOLO 模式，再保存修改。'
  if (form.template === 'workspace_sync' && form.mode === 'read_only') return '工作区资源同步需要 YOLO 模式。'
  return ''
}

export const validateDeliveryStep = (form: ScheduledTaskInput): string => {
  if (Boolean(form.output.botId) !== Boolean(form.output.chatId)) {
    return '发送 Bot 和接收群需要同时配置。'
  }
  return ''
}
