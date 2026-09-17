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

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/auth', name: 'auth', component: AuthView, meta: { public: true } },
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/workspaces', name: 'workspaces', component: WorkspacesView },
    { path: '/bots', name: 'bots', component: BotsView },
    { path: '/scenes', name: 'scenes', component: ScenesView },
    { path: '/packages', name: 'packages', component: PackagesView },
    { path: '/messages', name: 'messages', component: MessagesView },
    { path: '/settings', name: 'settings', component: SettingsView },
  ],
})

router.beforeEach(async to => {
  const status = await api.authStatus().catch(() => ({ setupRequired: false, authenticated: false }))
  if (!to.meta.public && !status.authenticated) return { name: 'auth' }
  if (to.name === 'auth' && status.authenticated) return { name: 'dashboard' }
  return true
})
