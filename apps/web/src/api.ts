import type { AdminAccount, AuditLog, Bot, ChatMetadata, ConversationThread, MessageLog, ProvisioningJob, Scene, SkillPackage, Workspace } from './types'

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
  accounts: () => request<AdminAccount[]>('/accounts'),
  saveAccount: (value: { id?: string; loginName: string; displayName: string; password?: string }) => request<AdminAccount>(value.id ? `/accounts/${value.id}` : '/accounts', { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
  deleteAccount: (id: string) => request<void>(`/accounts/${id}`, { method: 'DELETE' }),
  auditLogs: (filters: { limit?: number; offset?: number; actorAccountId?: string; action?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ items: AuditLog[]; total: number }>(`/audit-logs${params.size ? `?${params.toString()}` : ''}`)
  },
  auditLog: (id: string) => request<AuditLog>(`/audit-logs/${encodeURIComponent(id)}`),
  dashboard: () => request<{ workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number }>('/dashboard'),
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
  messageLogs: (filters: { limit?: number; offset?: number; botId?: string; sceneId?: string; status?: string; query?: string } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    return request<{ items: MessageLog[]; total: number }>(`/message-logs${params.size ? `?${params.toString()}` : ''}`)
  },
  messageLog: (id: string) => request<MessageLog>(`/message-logs/${encodeURIComponent(id)}`),
  settings: () => request<{ basePrompt: string }>('/settings'),
  saveSettings: (basePrompt: string) => request<{ basePrompt: string }>('/settings', { method: 'PUT', body: JSON.stringify({ basePrompt }) }),
  workspaces: () => request<Workspace[]>('/workspaces'),
  directories: (path?: string) => request<DirectoryListing>(`/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  skills: (workspaceId: string) => request<SkillOption[]>(`/skills?workspaceId=${encodeURIComponent(workspaceId)}`),
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
