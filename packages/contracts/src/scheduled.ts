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
  submodules: Array<{ path: string; mode: 'pinned' | 'branch' | 'merge'; branch: string; required: boolean }>
  installSkills: boolean
  skillRoots: string[]
  sourceIds: string[]
  preserveLocalFiles?: string[]
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
