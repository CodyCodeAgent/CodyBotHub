import type { AdminAccount, AuditLog, Bot, ChatMetadata, ConversationThread, DashboardOverview, MessageAttempt, MessageLog, ModelCatalog, PlatformSettings, ProvisioningJob, Scene, SkillCatalogItem, SkillPackage, SkillSource, SystemHealth, ThemePreference, ThreadChannel, ThreadJob, ThreadProfile, ThreadRoutingDecisionRecord, ThreadRoutingRule, Workspace, WorkspaceResources } from './types'

export interface DirectoryListing { roots: Array<{ name: string; path: string }>; current: string; parent: string | null; directories: Array<{ name: string; path: string }> }
export interface SkillOption { name: string; path: string; displayName: string; description: string; scope: 'repo' | 'user' | 'system' | 'admin'; enabled: boolean }
export interface MessageTypeOption { value: string; label: string }
export interface AuthStatus { setupRequired: boolean; authenticated: boolean; account: AdminAccount | null }

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
  preferences: () => request<{ theme: ThemePreference }>('/preferences'),
  savePreferences: (theme: ThemePreference) => request<{ theme: ThemePreference }>('/preferences', { method: 'PUT', body: JSON.stringify({ theme }) }),
  accounts: () => request<AdminAccount[]>('/accounts'),
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
  threadRoutingDecisions: (limit = 50) => request<ThreadRoutingDecisionRecord[]>(`/thread-routing-decisions?limit=${limit}`),
  threadChannels: (limit = 200) => request<ThreadChannel[]>(`/thread-channels?limit=${limit}`),
  threadJobs: (limit = 100) => request<ThreadJob[]>(`/thread-jobs?limit=${limit}`),
  messageLogs: (filters: { limit?: number; offset?: number; botId?: string; sceneId?: string; status?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ items: MessageLog[]; total: number }>(`/message-logs${params.size ? `?${params.toString()}` : ''}`)
  },
  messageLog: (id: string) => request<MessageLog>(`/message-logs/${encodeURIComponent(id)}`),
  messageAttempts: (id: string) => request<MessageAttempt[]>(`/message-logs/${encodeURIComponent(id)}/attempts`),
  retryMessage: (id: string) => request<{ log: MessageLog; job: ThreadJob; attempts: MessageAttempt[] }>(`/message-logs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  models: () => request<ModelCatalog>('/models'),
  settings: () => request<PlatformSettings>('/settings'),
  saveSettings: (value: PlatformSettings) => request<PlatformSettings>('/settings', { method: 'PUT', body: JSON.stringify(value) }),
  workspaces: () => request<Workspace[]>('/workspaces'),
  directories: (path?: string) => request<DirectoryListing>(`/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  skills: (workspaceId: string) => request<SkillOption[]>(`/skills?workspaceId=${encodeURIComponent(workspaceId)}`),
  skillSources: () => request<SkillSource[]>('/skill-sources'),
  saveSkillSource: (value: Partial<SkillSource> & { name: string; repositoryUrl: string; branch: string; workspaceId: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean }) => request<SkillSource>(value.id ? `/skill-sources/${value.id}` : '/skill-sources', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteSkillSource: (id: string) => request<void>(`/skill-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  syncSkillSource: (id: string) => request<{ source: SkillSource; installed: number; skipped: number }>(`/skill-sources/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  skillCatalog: (filters: { workspaceId?: string; sourceId?: string; status?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
    return request<SkillCatalogItem[]>(`/skill-catalog${params.size ? `?${params.toString()}` : ''}`)
  },
  workspaceResources: (workspaceId: string, query = '') => request<WorkspaceResources>(`/workspace-resources?workspaceId=${encodeURIComponent(workspaceId)}${query ? `&query=${encodeURIComponent(query)}` : ''}`),
  installSkills: (value: { sourceId: string; workspaceId: string; skillKeys?: string[]; all?: boolean; force?: boolean }) => request<{ installed: number; skipped: number; errors: string[] }>('/skill-catalog/install', { method: 'POST', body: JSON.stringify(value) }),
  feishuMessageTypes: () => request<MessageTypeOption[]>('/feishu/message-types'),
  saveWorkspace: (value: Partial<Workspace> & { name: string; path: string }) => request<Workspace>(value.id ? `/workspaces/${value.id}` : '/workspaces', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${id}`, { method: 'DELETE' }),
  bots: () => request<Bot[]>('/bots'),
  saveBot: (value: Record<string, unknown> & { id?: string }) => request<Bot>(value.id ? `/bots/${value.id}` : '/bots', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteBot: (id: string) => request<void>(`/bots/${id}`, { method: 'DELETE' }),
  provisioningJobs: () => request<ProvisioningJob[]>('/provisioning'),
  startProvisioning: (value: Record<string, unknown>) => request<ProvisioningJob>('/provisioning', { method: 'POST', body: JSON.stringify(value) }),
  provisioningJob: (id: string) => request<ProvisioningJob>(`/provisioning/${id}`),
  cancelProvisioning: (id: string) => request<ProvisioningJob>(`/provisioning/${id}`, { method: 'DELETE' }),
  scenes: () => request<Scene[]>('/scenes'),
  saveScene: (value: Record<string, unknown> & { id?: string }) => request<Scene>(value.id ? `/scenes/${value.id}` : '/scenes', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteScene: (id: string) => request<void>(`/scenes/${id}`, { method: 'DELETE' }),
  skillPackages: () => request<SkillPackage[]>('/skill-packages'),
  saveSkillPackage: (value: Record<string, unknown> & { id?: string }) => request<SkillPackage>(value.id ? `/skill-packages/${value.id}` : '/skill-packages', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteSkillPackage: (id: string) => request<void>(`/skill-packages/${id}`, { method: 'DELETE' }),
}
