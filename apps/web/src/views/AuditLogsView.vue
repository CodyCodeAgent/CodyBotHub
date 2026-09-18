<script setup lang="ts">
import { ClipboardList, ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { AdminAccount, AuditLog } from '../types'

const pageSize = 50
const items = ref<AuditLog[]>([]), accounts = ref<AdminAccount[]>([]), total = ref(0), offset = ref(0), loading = ref(false), error = ref(''), selected = ref<AuditLog | null>(null)
const filters = reactive({ actorAccountId: '', query: '' })
const page = computed(() => Math.floor(offset.value / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value))
const load = async () => { loading.value = true; error.value = ''; try { const result = await api.auditLogs({ ...filters, limit: pageSize, offset: offset.value }); items.value = result.items; total.value = result.total } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' } finally { loading.value = false } }
onMounted(async () => { accounts.value = await api.accounts(); await load() })
const search = async () => { offset.value = 0; await load() }
const move = async (delta: number) => { offset.value = Math.max(0, offset.value + delta * pageSize); await load() }
const actorName = (item: AuditLog) => item.actorDisplayName ? `${item.actorDisplayName}（${item.actorLoginName}）` : '系统 / 飞书操作'
const detailText = (item: AuditLog) => JSON.stringify(item.details, null, 2)
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Operation audit</p><h1>操作记录</h1><p class="page-description">记录平台配置变更、账号管理和登录操作，便于追溯谁在什么时间修改了什么。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button></header>
    <form class="filter-bar audit-filter" @submit.prevent="search"><select v-model="filters.actorAccountId" aria-label="操作者"><option value="">全部操作者</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.displayName }}（{{ account.loginName }}）</option></select><div class="filter-search"><Search :size="15" /><input v-model.trim="filters.query" placeholder="搜索摘要、对象 ID 或操作者…" /></div><button class="button">查询</button></form>
    <div v-if="error" class="error-banner" role="alert" style="margin-bottom:16px">{{ error }}</div>
    <section class="panel"><div class="panel-header"><h2>审计日志</h2><span class="badge gray">{{ total }} 条</span></div>
      <div v-if="!loading && !items.length" class="empty"><ClipboardList :size="32" /><strong>还没有操作记录</strong><span>后续平台配置变更会自动记录在这里。</span></div>
      <div v-else class="table-wrap"><table class="message-table"><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>来源 IP</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" tabindex="0" @click="selected = item" @keydown.enter="selected = item"><td class="mono">{{ formatTime(item.createdAt) }}</td><td><div>{{ actorName(item) }}</div><div class="entity-subtitle mono">{{ item.actorAccountId || '—' }}</div></td><td><div class="entity-title">{{ item.summary }}</div><div class="entity-subtitle mono">{{ item.action }}</div></td><td><div>{{ item.targetType || '—' }}</div><div class="entity-subtitle mono">{{ item.targetId || '—' }}</div></td><td class="mono">{{ item.ipAddress || '—' }}</td></tr></tbody></table></div>
      <footer class="pagination"><span>第 {{ page }} / {{ pageCount }} 页</span><div><button class="ghost-button compact" :disabled="offset === 0 || loading" @click="move(-1)"><ChevronLeft :size="15" />上一页</button><button class="ghost-button compact" :disabled="offset + pageSize >= total || loading" @click="move(1)">下一页<ChevronRight :size="15" /></button></div></footer>
    </section>
    <div v-if="selected" class="dialog-backdrop" @mousedown.self="selected = null"><section class="dialog large"><header class="dialog-header"><div><h2>操作详情</h2><p class="mono">{{ selected.id }} · {{ formatTime(selected.createdAt) }}</p></div><button class="icon-button" aria-label="关闭" @click="selected = null"><X :size="19" /></button></header><div class="dialog-body">
      <div class="detail-grid"><div><span>操作者</span><strong>{{ actorName(selected) }}</strong></div><div><span>操作</span><strong class="mono">{{ selected.action }}</strong></div><div><span>来源 IP</span><strong class="mono">{{ selected.ipAddress || '—' }}</strong></div></div>
      <div class="record-content"><h3>操作摘要</h3><pre>{{ selected.summary }}</pre></div><div class="record-content"><h3>对象</h3><pre>{{ selected.targetType || '—' }} · {{ selected.targetId || '—' }}</pre></div><div class="record-content"><h3>附加信息</h3><pre>{{ detailText(selected) }}</pre></div>
    </div></section></div>
  </div>
</template>
