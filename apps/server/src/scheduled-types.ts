export type ScheduleConfig = {
  kind: 'interval' | 'daily' | 'weekly' | 'cron'
  intervalMinutes: number
  time: string
  weekdays: number[]
  cron: string
  timezone: string
}
export type WorkspaceSyncConfig = {
  branch: string
  submodules: Array<{ path: string; mode: 'pinned' | 'branch'; branch: string; required: boolean }>
  installSkills: boolean
  skillRoots: string[]
  sourceIds: string[]
}
export type ScheduledTaskInput = {
  name: string
  description: string
  workspaceId: string
  template: string
  prompt: string
  runtimeKind: 'codex' | 'traex'
  model: string
  reasoningEffort: string
  mode: 'read_only' | 'maintenance'
  skillPackageIds: string[]
  toolPackageIds: string[]
  schedule: ScheduleConfig
  enabled: boolean
  timeoutMinutes: number
  overlap: 'skip' | 'merge'
  contextMode: 'fresh' | 'reuse'
  output: { botId: string; chatId: string; when: 'always' | 'attention' }
  sync: WorkspaceSyncConfig
}
export type ScheduledTask = ScheduledTaskInput & {
  id: string
  revision: number
  createdBy: string
  createdAt: string
  updatedAt: string
  nextRunAt: string
  coreThreadId: string
  lastRun: ScheduledRunSummary | null
}
export type ScheduledRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'skipped'
  | 'no_change'
export type ScheduledRunSummary = {
  id: string
  taskId: string
  taskName: string
  workspaceId: string
  status: ScheduledRunStatus
  trigger: string
  scheduledAt: string
  createdAt: string
  startedAt: string
  completedAt: string
  model: string
  reasoningEffort: string
  coreThreadId: string
  report: string
  error: string
  deliveryStatus: 'none' | 'pending' | 'sent' | 'failed'
  deliveryError: string
}
export type ScheduledRun = ScheduledRunSummary & {
  snapshot: ScheduledTaskInput & { revision: number; workspacePath: string; workspacePrompt: string }
  events: ScheduledEvent[]
  actions: ScheduledAction[]
}
export type ScheduledEvent = { id: number; at: string; phase: string; message: string; data: unknown }
export type ScheduledAction = {
  id: string
  runId: string
  packageId: string
  packageName: string
  arguments: Record<string, unknown>
  reason: string
  status: 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'rejected' | 'expired'
  botId: string
  chatId: string
  cardMessageId: string
  operatorId: string
  createdAt: string
  expiresAt: string
  packageUpdatedAt: string
  toolVersions: Record<string, string>
  result: unknown
  error: string
}
export const scheduledTemplates = [
  {
    id: 'workspace_sync',
    name: '工作区资源同步',
    description: '更新代码与子模块，安装技能、同步知识库并验证资源。',
    mode: 'maintenance',
    prompt:
      '维护当前工作区。先调用 inspect_workspace 检查仓库、本地修改和资源配置；有更新时调用 sync_workspace 完成受管更新。保留本地修改、认证信息和运行环境。完成后调用 verify_resources 验证技能与知识库可被识别。根据工具实际结果，报告更新前后版本、新增/更新/冲突的技能、知识变化、失败原因和未闭合项。不要通过 shell 绕过同步工具更新文件，不要部署或重启平台。'
  },
  {
    id: 'alert_review',
    name: '告警与任务复盘',
    description: '归纳告警、根因和待处理事项，生成可核对的复盘报告。',
    mode: 'read_only',
    prompt:
      '复盘自上次成功执行以来与当前工作区相关的告警和任务。通过可用的查询能力获取事实，按问题、影响、根因与待办整理，保留记录 ID、时间与证据来源。没有数据时明确说明。不要修改业务数据。'
  },
  {
    id: 'code_review',
    name: '代码变更分析',
    description: '识别接口、配置、数据库和知识文档的变化。',
    mode: 'read_only',
    prompt:
      '分析自上次成功执行以来当前工作区的代码变更，关注接口、配置、数据结构及其与知识库和技能说明的不一致。引用提交和文件路径，区分已确认变化与推测，给出需要跟进的事项。只做分析，不修改文件或业务数据。'
  },
  {
    id: 'health_check',
    name: '环境健康检查',
    description: '检查 CLI、MCP、认证及关键连接，定位失败原因。',
    mode: 'read_only',
    prompt:
      '以只读且无副作用的方式检查本工作区所需 CLI、MCP 和关键连接的可用性。区分认证失效、DNS、连接超时和业务错误。输出检查结果、证据、影响及恢复建议，不执行业务写入或修改权限。'
  },
  {
    id: 'knowledge_review',
    name: '知识库巡检',
    description: '发现过期说明、重复内容、失效引用和缺失信息。',
    mode: 'read_only',
    prompt:
      '巡检本工作区知识库与技能参考资料，发现与当前代码不一致、重复或失效的说明。输出带路径和依据的问题清单及修改建议。不要直接删除或改写文件。'
  },
  {
    id: 'custom',
    name: '自定义 AI 任务',
    description: '组合工作区、Prompt、技能和执行计划。',
    mode: 'read_only',
    prompt: ''
  }
] as const
