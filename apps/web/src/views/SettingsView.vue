<script setup lang="ts">
import { Edit3, GitPullRequest, Moon, Plus, RefreshCw, Save, Settings, Sun, Trash2, X } from 'lucide-vue-next'
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { announceTheme } from '../theme'
import type { SkillSource, ThemePreference, Workspace } from '../types'

const basePrompt = ref(''), theme = ref<ThemePreference>('system'), saving = ref(false), saved = ref(false), error = ref('')
const sources = ref<SkillSource[]>([]), workspaces = ref<Workspace[]>([]), dialogOpen = ref(false), syncingId = ref('')
const form = reactive({ id: '', name: '', repositoryUrl: '', branch: 'main', workspaceId: '', skillRoots: 'skills\n.codex/skills\n.agents/skills', knowledgeRoots: '', autoInstall: false })

const showError = (value: unknown) => { error.value = value instanceof Error ? value.message : '操作失败' }
const load = async () => {
  const [settings, preferences, sourceItems, workspaceItems] = await Promise.all([api.settings(), api.preferences(), api.skillSources(), api.workspaces()])
  basePrompt.value = settings.basePrompt; theme.value = preferences.theme; sources.value = sourceItems; workspaces.value = workspaceItems
}
onMounted(() => { void load().catch(showError) })
const save = async () => {
  saving.value = true; saved.value = false; error.value = ''
  try { await Promise.all([api.saveSettings(basePrompt.value), api.savePreferences(theme.value)]); announceTheme(theme.value); saved.value = true; setTimeout(() => { saved.value = false }, 1800) }
  catch (value) { showError(value) } finally { saving.value = false }
}
const openSource = (source?: SkillSource) => {
  Object.assign(form, source ? { ...source, skillRoots: source.skillRoots.join('\n'), knowledgeRoots: source.knowledgeRoots.join('\n') } : { id: '', name: '', repositoryUrl: '', branch: 'main', workspaceId: workspaces.value[0]?.id ?? '', skillRoots: 'skills\n.codex/skills\n.agents/skills', knowledgeRoots: '', autoInstall: false })
  dialogOpen.value = true
}
const lines = (value: string) => [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))]
const saveSource = async () => {
  error.value = ''
  try {
    await api.saveSkillSource({ ...(form.id ? { id: form.id } : {}), name: form.name, repositoryUrl: form.repositoryUrl, branch: form.branch, workspaceId: form.workspaceId, skillRoots: lines(form.skillRoots), knowledgeRoots: lines(form.knowledgeRoots), autoInstall: form.autoInstall })
    dialogOpen.value = false; sources.value = await api.skillSources()
  } catch (value) { showError(value) }
}
const sync = async (source: SkillSource) => {
  syncingId.value = source.id; error.value = ''
  try { await api.syncSkillSource(source.id); sources.value = await api.skillSources() } catch (value) { showError(value) } finally { syncingId.value = '' }
}
const remove = async (source: SkillSource) => {
  if (!window.confirm(`删除技能源“${source.name}”及其同步缓存？已安装到工作区的 Skill 文件会保留。`)) return
  try { await api.deleteSkillSource(source.id); sources.value = await api.skillSources() } catch (value) { showError(value) }
}
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Global policy</p><h1>平台设置</h1><p class="page-description">配置平台 Prompt、个人显示主题，以及供 AI 更新和安装能力的 Git 技能源。</p></div></header>
    <div class="settings-stack">
      <form class="panel" @submit.prevent="save">
        <div class="panel-header"><h2><Settings :size="16" />基础 Prompt 与显示</h2><span class="badge green">账号级</span></div>
        <div class="dialog-body">
          <div class="field"><label>显示主题</label><div class="theme-options">
            <label class="check-card"><input v-model="theme" value="system" type="radio" /><Settings :size="16" /><span>跟随系统</span></label>
            <label class="check-card"><input v-model="theme" value="light" type="radio" /><Sun :size="16" /><span>白天模式</span></label>
            <label class="check-card"><input v-model="theme" value="dark" type="radio" /><Moon :size="16" /><span>黑夜模式</span></label>
          </div><small>偏好绑定当前登录账号，并在这台设备上立即生效。</small></div>
          <div class="field"><label for="base-prompt">平台基础 Prompt</label><textarea id="base-prompt" v-model="basePrompt" rows="12" placeholder="定义平台级安全边界、统一行为和输出规范…" /><small>最终顺序：平台基础 → 工作区 → Bot → 场景 → 技能包。</small></div>
          <div v-if="error" class="error-banner" role="alert">{{ error }}</div><div v-if="saved" class="notice" role="status">设置已保存。</div>
        </div><footer class="dialog-actions"><button class="button" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : '保存设置' }}</button></footer>
      </form>

      <section class="panel">
        <div class="panel-header"><div><h2><GitPullRequest :size="16" />远程技能源</h2><p class="panel-description">平台在独立干净镜像中拉取代码，再把 Skill 和知识库安装到选定工作区的 .codex 目录。</p></div><button class="button" :disabled="!workspaces.length" @click="openSource()"><Plus :size="16" />添加技能源</button></div>
        <div v-if="!sources.length" class="empty"><GitPullRequest :size="34" /><strong>还没有技能源</strong><span>添加 Git 仓库后，可在 Skill 中心搜索、安装和更新。</span></div>
        <div v-else class="source-list">
          <article v-for="source in sources" :key="source.id" class="source-card">
            <div><div class="source-title"><strong>{{ source.name }}</strong><span v-if="source.autoInstall" class="badge green">自动安装</span></div><div class="mono muted">{{ source.repositoryUrl }} · {{ source.branch }}</div><p>{{ source.workspaceName }} · Skill 根目录 {{ source.skillRoots.join('、') || '自动识别' }}</p><p v-if="source.lastSyncedAt" class="muted">最近同步 {{ new Date(source.lastSyncedAt).toLocaleString() }} · {{ source.lastCommit.slice(0, 10) }}</p><p v-if="source.lastError" class="source-error">{{ source.lastError }}</p></div>
            <div class="actions"><button class="ghost-button compact" :disabled="syncingId === source.id" @click="sync(source)"><RefreshCw :size="14" :class="{ spinning: syncingId === source.id }" />{{ syncingId === source.id ? '同步中' : '同步' }}</button><button class="icon-button" title="编辑" @click="openSource(source)"><Edit3 :size="16" /></button><button class="icon-button danger-icon" title="删除" @click="remove(source)"><Trash2 :size="16" /></button></div>
          </article>
        </div>
      </section>
    </div>

    <div v-if="dialogOpen" class="dialog-backdrop" @click.self="dialogOpen = false"><form class="dialog large" @submit.prevent="saveSource"><header class="dialog-header"><div><h2>{{ form.id ? '编辑技能源' : '添加技能源' }}</h2><p>Git 操作只发生在 CodyBotHub 管理的缓存目录，不会 reset 工作区。</p></div><button type="button" class="icon-button" @click="dialogOpen = false"><X :size="18" /></button></header><div class="dialog-body">
      <div class="field-grid"><div class="field"><label>名称</label><input v-model="form.name" required placeholder="AI Hub 能力源" /></div><div class="field"><label>目标工作区</label><select v-model="form.workspaceId" required><option disabled value="">选择工作区</option><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></div></div>
      <div class="field"><label>Git 仓库</label><input v-model="form.repositoryUrl" required placeholder="git@code.example.com:team/repo.git" /></div>
      <div class="field"><label>分支</label><input v-model="form.branch" required placeholder="main" /></div>
      <div class="field-grid"><div class="field"><label>Skill 根目录（每行一个）</label><textarea v-model="form.skillRoots" rows="5" placeholder="skills&#10;.codex/skills" /><small>在这些目录下递归识别 SKILL.md。</small></div><div class="field"><label>知识库 / 子模块目录（每行一个）</label><textarea v-model="form.knowledgeRoots" rows="5" placeholder="knowledge/team_knowledge" /><small>同步后安装到工作区 .codex/knowledge。</small></div></div>
      <label class="check-card"><input v-model="form.autoInstall" type="checkbox" /><span><strong>同步后自动安装与更新</strong><small>遇到未受管理的同名目录时会跳过，避免覆盖本地内容。</small></span></label>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="dialogOpen = false">取消</button><button class="button"><Save :size="16" />保存技能源</button></footer></form></div>
  </div>
</template>
