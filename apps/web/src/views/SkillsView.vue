<script setup lang="ts">
import { CheckCircle2, Download, LibraryBig, RefreshCw, Search, ShieldAlert } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import type { SkillCatalogItem, SkillSource, Workspace } from '../types'

const items = ref<SkillCatalogItem[]>([]), sources = ref<SkillSource[]>([]), workspaces = ref<Workspace[]>([]), selected = ref<string[]>([])
const workspaceId = ref(''), sourceId = ref(''), status = ref(''), query = ref(''), loading = ref(false), working = ref(false), error = ref(''), notice = ref('')
const isBulkSelectable = (item: SkillCatalogItem) => item.status === 'available' || item.status === 'update_available'
const selectable = computed(() => items.value.filter(isBulkSelectable))
const selectionKey = (item: SkillCatalogItem) => `${item.sourceId}\u0000${item.workspaceId}\u0000${item.key}`
const statusLabel: Record<SkillCatalogItem['status'], string> = { available: '可安装', installed: '已安装', update_available: '有更新', conflict: '目录冲突', local: '本地' }

const load = async () => {
  loading.value = true; error.value = ''
  try {
    const [catalog, sourceItems, workspaceItems] = await Promise.all([api.skillCatalog({ workspaceId: workspaceId.value, sourceId: sourceId.value, status: status.value, query: query.value }), api.skillSources(), api.workspaces()])
    items.value = catalog; sources.value = sourceItems; workspaces.value = workspaceItems; selected.value = selected.value.filter(key => catalog.some(item => selectionKey(item) === key))
  } catch (value) { error.value = value instanceof Error ? value.message : '加载失败' } finally { loading.value = false }
}
onMounted(() => { void load() })
const toggleAll = () => { selected.value = selected.value.length === selectable.value.length ? [] : selectable.value.map(selectionKey) }
const installItems = async (targets: SkillCatalogItem[], force = false) => {
  if (!targets.length) return
  working.value = true; error.value = ''; notice.value = ''
  try {
    const groups = new Map<string, SkillCatalogItem[]>()
    for (const item of targets) { const key = `${item.sourceId}\u0000${item.workspaceId}`; groups.set(key, [...(groups.get(key) ?? []), item]) }
    let installed = 0, skipped = 0; const errors: string[] = []
    for (const group of groups.values()) {
      const first = group[0]!
      const result = await api.installSkills({ sourceId: first.sourceId, workspaceId: first.workspaceId, skillKeys: group.map(item => item.key), force })
      installed += result.installed; skipped += result.skipped; errors.push(...result.errors)
    }
    notice.value = `已安装或更新 ${installed} 个${skipped ? `，跳过 ${skipped} 个` : ''}`
    if (errors.length) error.value = errors.join('；')
    selected.value = []; await load()
  } catch (value) { error.value = value instanceof Error ? value.message : '安装失败' } finally { working.value = false }
}
const installSelected = () => installItems(items.value.filter(item => selected.value.includes(selectionKey(item))))
const installOne = (item: SkillCatalogItem) => installItems([item], item.status === 'conflict')
const syncSource = async (source: SkillSource) => {
  working.value = true; error.value = ''; notice.value = ''
  try { const result = await api.syncSkillSource(source.id); notice.value = `已同步 ${source.name}${result.installed ? `，自动安装 ${result.installed} 个` : ''}`; await load() }
  catch (value) { error.value = value instanceof Error ? value.message : '同步失败' } finally { working.value = false }
}
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Skill registry</p><h1>Skill 中心</h1><p class="page-description">集中查看工作区中已识别的本地 Skill 和远程技能源，支持搜索、同步、安装与更新。</p></div><button class="ghost-button" :disabled="loading" @click="load"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新识别</button></header>
    <div class="skill-summary">
      <div><strong>{{ items.length }}</strong><span>当前结果</span></div><div><strong>{{ items.filter(item => item.status === 'installed').length }}</strong><span>已安装</span></div><div><strong>{{ items.filter(item => item.status === 'update_available').length }}</strong><span>有更新</span></div><div><strong>{{ items.filter(item => item.status === 'local').length }}</strong><span>本地 Skill</span></div>
    </div>
    <div class="filter-bar skill-filter"><select v-model="workspaceId" @change="load"><option value="">全部工作区</option><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select><select v-model="sourceId" @change="load"><option value="">全部来源</option><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option></select><select v-model="status" @change="load"><option value="">全部状态</option><option v-for="(label, value) in statusLabel" :key="value" :value="value">{{ label }}</option></select><div class="filter-search"><Search :size="16" /><input v-model="query" placeholder="搜索名称、描述、来源、路径…" @keyup.enter="load" /></div><button class="button" @click="load">查询</button></div>
    <div v-if="sources.length" class="source-toolbar"><span>远程同步：</span><button v-for="source in sources" :key="source.id" class="ghost-button compact" :disabled="working" @click="syncSource(source)"><RefreshCw :size="13" />{{ source.name }}</button></div>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div><div v-if="notice" class="notice" role="status">{{ notice }}</div>
    <section class="panel">
      <div class="panel-header"><div><h2>识别结果</h2><p class="panel-description">同名未受管理目录标记为冲突，只有点击“接管安装”才会备份原目录并替换。</p></div><div class="actions"><button class="ghost-button compact" :disabled="!selectable.length" @click="toggleAll">{{ selected.length === selectable.length && selectable.length ? '取消全选' : '选择可更新项' }}</button><button class="button" :disabled="!selected.length || working" @click="installSelected"><Download :size="15" />安装所选（{{ selected.length }}）</button></div></div>
      <div v-if="loading" class="empty">正在扫描工作区和技能源…</div>
      <div v-else-if="!items.length" class="empty"><LibraryBig :size="36" /><strong>没有识别到 Skill</strong><span>请检查工作区目录，或先在平台设置中添加并同步技能源。</span></div>
      <div v-else class="table-wrap"><table class="skill-table"><thead><tr><th class="select-cell"></th><th>Skill</th><th>工作区 / 来源</th><th>路径</th><th>状态</th><th></th></tr></thead><tbody><tr v-for="item in items" :key="selectionKey(item)"><td class="select-cell"><input v-if="isBulkSelectable(item)" v-model="selected" type="checkbox" :value="selectionKey(item)" /></td><td><div class="entity-title">{{ item.name }}</div><div class="entity-subtitle skill-description">{{ item.description || '未提供描述' }}</div></td><td><div>{{ item.workspaceName }}</div><div class="muted">{{ item.sourceName }}</div></td><td><code class="mono path-code">{{ item.sourcePath }}</code></td><td><span class="badge" :class="{ green: item.status === 'installed', red: item.status === 'conflict', gray: item.status === 'local' }"><ShieldAlert v-if="item.status === 'conflict'" :size="12" /><CheckCircle2 v-else-if="item.status === 'installed'" :size="12" />{{ statusLabel[item.status] }}</span></td><td><button v-if="item.sourceId && item.status !== 'installed'" class="ghost-button compact" :disabled="working" @click="installOne(item)">{{ item.status === 'conflict' ? '备份并接管' : item.status === 'update_available' ? '更新' : '安装' }}</button></td></tr></tbody></table></div>
    </section>
  </div>
</template>
