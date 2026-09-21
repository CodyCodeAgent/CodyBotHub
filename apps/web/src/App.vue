<script setup lang="ts">
import { BookOpenCheck, Bot, Boxes, ClipboardList, GitBranch, LayoutDashboard, LibraryBig, LogOut, Menu, MessageSquareText, PackageCheck, Puzzle, Route, Settings, Users, Workflow, Wrench, X } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api'
import { applyTheme } from './theme'
import CopilotPanel from './components/CopilotPanel.vue'

const route = useRoute()
const router = useRouter()
const mobileOpen = ref(false)
const isAuth = computed(() => route.name === 'auth')
const groups = [
  { label: '', items: [
    { to: '/', label: '运行总览', icon: LayoutDashboard },
    { to: '/guide', label: '系统介绍', icon: BookOpenCheck },
  ] },
  { label: '编排', items: [
    { to: '/workspaces', label: '工作区', icon: Boxes },
    { to: '/bots', label: '飞书 Bot', icon: Bot },
    { to: '/scenes', label: '场景路由', icon: Workflow },
  ] },
  { label: '能力', items: [
    { to: '/packages', label: '技能包', icon: Puzzle },
    { to: '/tools', label: '工具', icon: Wrench },
    { to: '/tool-packages', label: '工具包', icon: PackageCheck },
    { to: '/skills', label: 'Skill 中心', icon: LibraryBig },
  ] },
  { label: '可观测性', items: [
    { to: '/conversation-threads', label: '会话线程', icon: GitBranch },
    { to: '/thread-routing', label: '经验复用', icon: Route },
    { to: '/messages', label: '消息记录', icon: MessageSquareText },
  ] },
  { label: '系统', items: [
    { to: '/accounts', label: '账号管理', icon: Users },
    { to: '/audit-logs', label: '操作记录', icon: ClipboardList },
    { to: '/settings', label: '平台设置', icon: Settings },
  ] },
]
const logout = async () => { await api.logout(); await router.push('/auth') }
onMounted(async () => { const status = await api.authStatus().catch(() => null); applyTheme(status?.account?.theme ?? 'system') })
</script>

<template>
  <RouterView v-if="isAuth" />
  <div v-else class="app-shell">
    <div class="app-atmosphere" aria-hidden="true"><span class="ambient-orb orb-a" /><span class="ambient-orb orb-b" /><span class="scan-beam" /></div>
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <button class="mobile-menu icon-button" aria-label="打开导航" @click="mobileOpen = true"><Menu :size="20" /></button>
    <div v-if="mobileOpen" class="nav-scrim" @click="mobileOpen = false" />
    <aside class="sidebar" :class="{ open: mobileOpen }">
      <div class="brand">
        <div class="brand-mark"><span class="brand-orbit" aria-hidden="true" /><Bot :size="22" /></div>
        <div><strong>CodyBotHub</strong><span>Feishu Agent Control</span></div>
        <button class="close-nav icon-button" aria-label="关闭导航" @click="mobileOpen = false"><X :size="20" /></button>
      </div>
      <nav aria-label="主要导航">
        <section v-for="group in groups" :key="group.label || 'overview'" class="nav-group">
          <p v-if="group.label" class="nav-label">{{ group.label }}</p>
          <RouterLink v-for="item in group.items" :key="item.to" :to="item.to" @click="mobileOpen = false">
            <component :is="item.icon" :size="18" /><span>{{ item.label }}</span>
          </RouterLink>
        </section>
      </nav>
      <div class="sidebar-foot">
        <div class="system-status"><span class="status-dot" />系统已连接</div>
        <button class="ghost-button full" @click="logout"><LogOut :size="17" />退出登录</button>
      </div>
    </aside>
    <main id="main-content" class="main" tabindex="-1"><RouterView /></main>
    <CopilotPanel />
  </div>
</template>
