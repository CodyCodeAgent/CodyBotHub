import { createRouter, createWebHistory } from 'vue-router'
import { api } from './api'
import AuthView from './views/AuthView.vue'
import BotsView from './views/BotsView.vue'
import DashboardView from './views/DashboardView.vue'
import PackagesView from './views/PackagesView.vue'
import ScenesView from './views/ScenesView.vue'
import WorkspacesView from './views/WorkspacesView.vue'
import SettingsView from './views/SettingsView.vue'
import MessagesView from './views/MessagesView.vue'
import AccountsView from './views/AccountsView.vue'
import AuditLogsView from './views/AuditLogsView.vue'
import ConversationThreadsView from './views/ConversationThreadsView.vue'
import SkillsView from './views/SkillsView.vue'
import ThreadRoutingView from './views/ThreadRoutingView.vue'
import GuideView from './views/GuideView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/auth', name: 'auth', component: AuthView, meta: { public: true } },
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/guide', name: 'guide', component: GuideView },
    { path: '/workspaces', name: 'workspaces', component: WorkspacesView },
    { path: '/bots', name: 'bots', component: BotsView },
    { path: '/scenes', name: 'scenes', component: ScenesView },
    { path: '/conversation-threads', name: 'conversation-threads', component: ConversationThreadsView },
    { path: '/thread-routing', name: 'thread-routing', component: ThreadRoutingView },
    { path: '/packages', name: 'packages', component: PackagesView },
    { path: '/skills', name: 'skills', component: SkillsView },
    { path: '/messages', name: 'messages', component: MessagesView },
    { path: '/accounts', name: 'accounts', component: AccountsView },
    { path: '/audit-logs', name: 'audit-logs', component: AuditLogsView },
    { path: '/settings', name: 'settings', component: SettingsView },
  ],
})

router.beforeEach(async to => {
  const status = await api.authStatus().catch(() => ({ setupRequired: false, authenticated: false }))
  if (!to.meta.public && !status.authenticated) return { name: 'auth' }
  if (to.name === 'auth' && status.authenticated) return { name: 'dashboard' }
  return true
})
