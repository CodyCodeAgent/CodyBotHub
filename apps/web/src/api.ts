import type { Bot, ProvisioningJob, Scene, SkillPackage, Workspace } from './types'

export interface DirectoryListing { roots: Array<{ name: string; path: string }>; current: string; parent: string | null; directories: Array<{ name: string; path: string }> }
export interface SkillOption { name: string; path: string; displayName: string; description: string; scope: 'repo' | 'user' | 'system' | 'admin'; enabled: boolean }
export interface MessageTypeOption { value: string; label: string }

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
  authStatus: () => request<{ setupRequired: boolean; authenticated: boolean }>('/auth/status'),
  setup: (password: string) => request('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  dashboard: () => request<{ workspaces: number; bots: number; scenes: number; skillPackages: number }>('/dashboard'),
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
