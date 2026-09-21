import type { AdminAccount, AgentRuntimeKind, AuditLog, Bot, ChatMetadata, ConversationThread, CopilotProposal, CopilotState, DashboardOverview, MessageAttempt, MessageLog, ModelCatalog, PlatformSettings, ProvisioningJob, Scene, SkillCatalogItem, SkillPackage, SkillSource, SystemHealth, ThemePreference, ThreadChannel, ThreadJob, ThreadProfile, ThreadRoutingDecisionRecord, ThreadRoutingRule, Tool, ToolPackage, ToolPackageExecution, ToolScriptVersion, Workspace, WorkspaceResources } from './types'

export interface DirectoryListing { roots: Array<{ name: string; path: string }>; current: string; parent: string | null; directories: Array<{ name: string; path: string }> }
export interface SkillOption { name: string; path: string; displayName: string; description: string; scope: 'repo' | 'user' | 'system' | 'admin'; enabled: boolean }
export interface MessageTypeOption { value: string; label: string }
export interface AuthStatus { setupRequired: boolean; authenticated: boolean; account: AdminAccount | null }
export interface PageResult<T> { items: T[]; total: number }

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!response.ok) {
    const value = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new ApiError(response.status, value.error ?? response.statusText)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),
  setup: (loginName: string, displayName: string, password: string) => request<AuthStatus>('/auth/setup', { method: 'POST', body: JSON.stringify({ loginName, displayName, password }) }),
  login: (loginName: string, password: string) => request<AuthStatus>('/auth/login', { method: 'POST', body: JSON.stringify({ loginName, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  copilotSession: (workspaceId: string) => request<CopilotState>(`/copilot/session?workspaceId=${encodeURIComponent(workspaceId)}`),
  resetCopilot: (sessionId: string) => request<CopilotState>('/copilot/session/reset', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  askCopilot: (sessionId: string, content: string) => request<CopilotState>('/copilot/messages', { method: 'POST', body: JSON.stringify({ sessionId, content }) }),
  applyCopilotProposal: (id: string) => request<{ proposal: CopilotProposal; target: { type: 'tool'|'bot'; id: string; name: string } }>(`/copilot/proposals/${encodeURIComponent(id)}/apply`, { method: 'POST' }),
  dismissCopilotProposal: (id: string) => request<CopilotProposal>(`/copilot/proposals/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
  preferences: () => request<{ theme: ThemePreference }>('/preferences'),
  savePreferences: (theme: ThemePreference) => request<{ theme: ThemePreference }>('/preferences', { method: 'PUT', body: JSON.stringify({ theme }) }),
  accounts: () => request<AdminAccount[]>('/accounts'),
  accountsPage: (limit = 20, offset = 0) => request<PageResult<AdminAccount>>(`/accounts/page?limit=${limit}&offset=${offset}`),
  saveAccount: (value: { id?: string; loginName: string; displayName: string; password?: string }) => request<AdminAccount>(value.id ? `/accounts/${value.id}` : '/accounts', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteAccount: (id: string) => request<void>(`/accounts/${id}`, { method: 'DELETE' }),
  auditLogs: (filters: { limit?: number; offset?: number; actorAccountId?: string; action?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ items: AuditLog[]; total: number }>(`/audit-logs${params.size ? `?${params.toString()}` : ''}`)
  },
  auditLog: (id: string) => request<AuditLog>(`/audit-logs/${encodeURIComponent(id)}`),
  dashboard: () => request<DashboardOverview>('/dashboard'),
  systemHealth: () => request<SystemHealth>('/system-health'),
  chats: (filters: { botId?: string; query?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<ChatMetadata[]>(`/chats${params.size ? `?${params.toString()}` : ''}`)
  },
  conversationThreads: (filters: { limit?: number; offset?: number; botId?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ items: ConversationThread[]; total: number }>(`/conversation-threads${params.size ? `?${params.toString()}` : ''}`)
  },
  conversationThread: (id: string) => request<ConversationThread>(`/conversation-threads/${encodeURIComponent(id)}`),
  threadRoutingRules: () => request<ThreadRoutingRule[]>('/thread-routing-rules'),
  saveThreadRoutingRule: (sceneId: string, value: Pick<ThreadRoutingRule, 'enabled'|'reuseThreshold'|'experienceThreshold'|'timeWindowHours'|'maxCandidates'|'structuredWeight'|'textWeight'>) => request<ThreadRoutingRule>(`/thread-routing-rules/${encodeURIComponent(sceneId)}`, { method: 'PUT', body: JSON.stringify(value) }),
  threadProfiles: (limit = 100) => request<ThreadProfile[]>(`/thread-routing-profiles?limit=${limit}`),
  threadProfilesPage: (filters: { limit?: number; offset?: number; sceneId?: string; query?: string } = {}) => { const params = new URLSearchParams({ paged: '1' }); for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value)); return request<PageResult<ThreadProfile>>(`/thread-routing-profiles?${params.toString()}`) },
  threadRoutingDecisions: (limit = 50) => request<ThreadRoutingDecisionRecord[]>(`/thread-routing-decisions?limit=${limit}`),
  threadRoutingDecisionsPage: (limit = 20, offset = 0) => request<PageResult<ThreadRoutingDecisionRecord> & { typeCounts: Record<string, number> }>(`/thread-routing-decisions?paged=1&limit=${limit}&offset=${offset}`),
  threadChannels: (limit = 200) => request<ThreadChannel[]>(`/thread-channels?limit=${limit}`),
  threadChannelsPage: (limit = 20, offset = 0) => request<PageResult<ThreadChannel>>(`/thread-channels?paged=1&limit=${limit}&offset=${offset}`),
  threadJobs: (limit = 100) => request<ThreadJob[]>(`/thread-jobs?limit=${limit}`),
  threadJobsPage: (limit = 20, offset = 0) => request<PageResult<ThreadJob>>(`/thread-jobs?paged=1&limit=${limit}&offset=${offset}`),
  messageLogs: (filters: { limit?: number; offset?: number; botId?: string; sceneId?: string; status?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ items: MessageLog[]; total: number }>(`/message-logs${params.size ? `?${params.toString()}` : ''}`)
  },
  messageLog: (id: string) => request<MessageLog>(`/message-logs/${encodeURIComponent(id)}`),
  messageAttempts: (id: string) => request<MessageAttempt[]>(`/message-logs/${encodeURIComponent(id)}/attempts`),
  retryMessage: (id: string) => request<{ log: MessageLog; job: ThreadJob; attempts: MessageAttempt[] }>(`/message-logs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  models: (runtimeKind: AgentRuntimeKind = 'codex') => request<ModelCatalog>(`/models?runtimeKind=${runtimeKind}`),
  settings: () => request<PlatformSettings>('/settings'),
  saveSettings: (value: PlatformSettings) => request<PlatformSettings>('/settings', { method: 'PUT', body: JSON.stringify(value) }),
  workspaces: () => request<Workspace[]>('/workspaces'),
  workspacesPage: (limit = 20, offset = 0) => request<PageResult<Workspace>>(`/workspaces/page?limit=${limit}&offset=${offset}`),
  directories: (path?: string) => request<DirectoryListing>(`/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  skills: (workspaceId: string) => request<SkillOption[]>(`/skills?workspaceId=${encodeURIComponent(workspaceId)}`),
  skillSources: () => request<SkillSource[]>('/skill-sources'),
  skillSourcesPage: (limit = 20, offset = 0) => request<PageResult<SkillSource>>(`/skill-sources/page?limit=${limit}&offset=${offset}`),
  saveSkillSource: (value: Partial<SkillSource> & { name: string; repositoryUrl: string; branch: string; workspaceId: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean }) => request<SkillSource>(value.id ? `/skill-sources/${value.id}` : '/skill-sources', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteSkillSource: (id: string) => request<void>(`/skill-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  syncSkillSource: (id: string) => request<{ source: SkillSource; installed: number; skipped: number }>(`/skill-sources/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  skillCatalog: (filters: { workspaceId?: string; sourceId?: string; status?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
    return request<SkillCatalogItem[]>(`/skill-catalog${params.size ? `?${params.toString()}` : ''}`)
  },
  skillCatalogPage: (filters: { workspaceId?: string; sourceId?: string; status?: string; query?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<PageResult<SkillCatalogItem> & { statusCounts: Record<string, number> }>(`/skill-catalog?${params.toString()}`)
  },
  workspaceResources: (workspaceId: string, query = '', limit = 20, offset = 0) => request<WorkspaceResources>(`/workspace-resources?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ''}`),
  installSkills: (value: { sourceId: string; workspaceId: string; skillKeys?: string[]; all?: boolean; force?: boolean }) => request<{ installed: number; skipped: number; errors: string[] }>('/skill-catalog/install', { method: 'POST', body: JSON.stringify(value) }),
  feishuMessageTypes: () => request<MessageTypeOption[]>('/feishu/message-types'),
  saveWorkspace: (value: Partial<Workspace> & { name: string; path: string }) => request<Workspace>(value.id ? `/workspaces/${value.id}` : '/workspaces', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${id}`, { method: 'DELETE' }),
  bots: () => request<Bot[]>('/bots'),
  botsPage: (limit = 20, offset = 0) => request<PageResult<Bot>>(`/bots/page?limit=${limit}&offset=${offset}`),
  saveBot: (value: Record<string, unknown> & { id?: string }) => request<Bot>(value.id ? `/bots/${value.id}` : '/bots', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteBot: (id: string) => request<void>(`/bots/${id}`, { method: 'DELETE' }),
  provisioningJobs: () => request<ProvisioningJob[]>('/provisioning'),
  startProvisioning: (value: Record<string, unknown>) => request<ProvisioningJob>('/provisioning', { method: 'POST', body: JSON.stringify(value) }),
  provisioningJob: (id: string) => request<ProvisioningJob>(`/provisioning/${id}`),
  cancelProvisioning: (id: string) => request<ProvisioningJob>(`/provisioning/${id}`, { method: 'DELETE' }),
  scenes: () => request<Scene[]>('/scenes'),
  scenesPage: (limit = 20, offset = 0) => request<PageResult<Scene>>(`/scenes/page?limit=${limit}&offset=${offset}`),
  saveScene: (value: Record<string, unknown> & { id?: string }) => request<Scene>(value.id ? `/scenes/${value.id}` : '/scenes', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteScene: (id: string) => request<void>(`/scenes/${id}`, { method: 'DELETE' }),
  skillPackages: () => request<SkillPackage[]>('/skill-packages'),
  skillPackagesPage: (limit = 20, offset = 0) => request<PageResult<SkillPackage>>(`/skill-packages/page?limit=${limit}&offset=${offset}`),
  saveSkillPackage: (value: Record<string, unknown> & { id?: string }) => request<SkillPackage>(value.id ? `/skill-packages/${value.id}` : '/skill-packages', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteSkillPackage: (id: string) => request<void>(`/skill-packages/${id}`, { method: 'DELETE' }),
  tools: () => request<Tool[]>('/tools'),
  toolsPage: (limit = 20, offset = 0) => request<PageResult<Tool>>(`/tools/page?limit=${limit}&offset=${offset}`),
  saveTool: (value: Record<string, unknown> & { id?: string }) => request<Tool>(value.id ? `/tools/${value.id}` : '/tools', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  toolScriptVersions: (id: string) => request<ToolScriptVersion[]>(`/tools/${encodeURIComponent(id)}/versions`),
  deleteTool: (id: string) => request<void>(`/tools/${id}`, { method: 'DELETE' }),
  toolPackages: () => request<ToolPackage[]>('/tool-packages'),
  toolPackagesPage: (limit = 20, offset = 0) => request<PageResult<ToolPackage>>(`/tool-packages/page?limit=${limit}&offset=${offset}`),
  saveToolPackage: (value: Record<string, unknown> & { id?: string }) => request<ToolPackage>(value.id ? `/tool-packages/${value.id}` : '/tool-packages', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteToolPackage: (id: string) => request<void>(`/tool-packages/${id}`, { method: 'DELETE' }),
  toolPackageExecutions: (limit = 20, offset = 0) => request<PageResult<ToolPackageExecution>>(`/tool-package-executions?limit=${limit}&offset=${offset}`),
}
