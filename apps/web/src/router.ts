import { createRouter, createWebHistory } from 'vue-router'
import { api } from './api'
import { routes } from './routes'

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async to => {
  const status = await api.authStatus().catch(() => ({ setupRequired: false, authenticated: false }))
  if (!to.meta.public && !status.authenticated) return { name: 'auth' }
  if (to.name === 'auth' && status.authenticated) return { name: 'dashboard' }
  return true
})
