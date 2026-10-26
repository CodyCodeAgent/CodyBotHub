import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  { path: '/auth', name: 'auth', component: () => import('./views/AuthView.vue'), meta: { public: true } },
  { path: '/', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
  { path: '/guide', name: 'guide', component: () => import('./views/GuideView.vue') },
  { path: '/scheduled-tasks', name: 'scheduled-tasks', component: () => import('./views/ScheduledTasksView.vue') },
  { path: '/scheduled-tasks/new', name: 'scheduled-task-new', component: () => import('./views/ScheduledTaskEditor.vue') },
  { path: '/scheduled-tasks/:id', name: 'scheduled-task-edit', component: () => import('./views/ScheduledTaskEditor.vue') },
  { path: '/scheduled-runs/:id', name: 'scheduled-run', component: () => import('./views/ScheduledRunView.vue') },
  { path: '/workspaces', name: 'workspaces', component: () => import('./views/WorkspacesView.vue') },
  { path: '/bots', name: 'bots', component: () => import('./views/BotsView.vue') },
  { path: '/scenes', name: 'scenes', component: () => import('./views/ScenesView.vue') },
  { path: '/conversation-threads', name: 'conversation-threads', component: () => import('./views/ConversationThreadsView.vue') },
  { path: '/thread-routing', name: 'thread-routing', component: () => import('./views/ThreadRoutingView.vue') },
  { path: '/packages', name: 'packages', component: () => import('./views/PackagesView.vue') },
  { path: '/tools', name: 'tools', component: () => import('./views/ToolsView.vue') },
  { path: '/tool-packages', name: 'tool-packages', component: () => import('./views/ToolPackagesView.vue') },
  { path: '/skills', name: 'skills', component: () => import('./views/SkillsView.vue') },
  { path: '/messages', name: 'messages', component: () => import('./views/MessagesView.vue') },
  { path: '/accounts', name: 'accounts', component: () => import('./views/AccountsView.vue') },
  { path: '/audit-logs', name: 'audit-logs', component: () => import('./views/AuditLogsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
]
