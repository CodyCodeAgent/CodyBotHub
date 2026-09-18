<script setup lang="ts">
import { Pencil, Plus, Puzzle, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { findComposerTrigger, type ComposerTrigger } from '@codycodeagent/cody-web-core/composer'
import { api, type SkillOption } from '../api'
import type { SkillPackage, Workspace } from '../types'
const items = ref<SkillPackage[]>([]), workspaces = ref<Workspace[]>([]), open = ref(false), saving = ref(false), error = ref('')
const form = reactive({ id: '', workspaceId: '', name: '', description: '', prompt: '', skillsText: '', fallbackMode: 'package_first' as SkillPackage['fallbackMode'] })
const skillOptions = ref<SkillOption[]>([]), skillsLoading = ref(false), skillInput = ref<HTMLTextAreaElement | null>(null), activeTrigger = ref<ComposerTrigger | null>(null), highlightedSkill = ref(0)
const filteredSkills = computed(() => {
  const query = activeTrigger.value?.query ?? ''
  return skillOptions.value.filter(skill => !query || [skill.name, skill.displayName, skill.description, skill.path].join(' ').toLowerCase().includes(query)).slice(0, 12)
})
const load = async () => { [items.value, workspaces.value] = await Promise.all([api.skillPackages(), api.workspaces()]) }
onMounted(load)
const loadSkills = async () => { if (!form.workspaceId) { skillOptions.value = []; return }; skillsLoading.value = true; try { skillOptions.value = await api.skills(form.workspaceId) } catch { skillOptions.value = [] } finally { skillsLoading.value = false } }
const edit = (item?: SkillPackage) => { Object.assign(form, item ? { ...item, skillsText: item.skills.join('\n') } : { id: '', workspaceId: workspaces.value[0]?.id ?? '', name: '', description: '', prompt: '', skillsText: '', fallbackMode: 'package_first' }); error.value = ''; activeTrigger.value = null; open.value = true; void loadSkills() }
watch(() => form.workspaceId, () => { if (open.value) void loadSkills() })
const save = async () => { saving.value = true; error.value = ''; try { await api.saveSkillPackage({ ...form, skills: form.skillsText.split('\n').map(v => v.trim()).filter(Boolean) }); open.value = false; await load() } catch (e) { error.value = e instanceof Error ? e.message : '保存失败' } finally { saving.value = false } }
const remove = async (item: SkillPackage) => { if (!confirm(`删除技能包“${item.name}”？`)) return; try { await api.deleteSkillPackage(item.id); await load() } catch (e) { alert(e instanceof Error ? e.message : '删除失败') } }
const workspaceName = (id: string) => workspaces.value.find(item => item.id === id)?.name ?? '未知工作区'
const updateTrigger = () => { const input = skillInput.value; activeTrigger.value = input ? findComposerTrigger(input.value, input.selectionStart, '$') : null; highlightedSkill.value = 0 }
const selectSkill = async (skill: SkillOption) => {
  const trigger = activeTrigger.value
  if (!trigger) return
  const current = form.skillsText
  form.skillsText = `${current.slice(0, trigger.start)}${skill.path}${current.slice(trigger.end)}`
  activeTrigger.value = null
  await nextTick()
  const cursor = trigger.start + skill.path.length
  skillInput.value?.focus(); skillInput.value?.setSelectionRange(cursor, cursor)
}
const onSkillKeydown = (event: KeyboardEvent) => {
  if (!activeTrigger.value) return
  if (event.key === 'Escape') { event.preventDefault(); activeTrigger.value = null; return }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); const count = filteredSkills.value.length
    if (count) highlightedSkill.value = (highlightedSkill.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
  }
  if (event.key === 'Enter' && filteredSkills.value.length) { event.preventDefault(); void selectSkill(filteredSkills.value[Math.min(highlightedSkill.value, filteredSkills.value.length - 1)]!) }
}
const closeSkillMenu = () => window.setTimeout(() => { activeTrigger.value = null }, 100)
</script>
<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Reusable capability sets</p><h1>技能包</h1><p class="page-description">把场景需要的 Skill、Prompt 和查找策略打包。技能包属于一个工作区，避免把目录专属能力注入到错误的消息轮次。</p></div><button class="button" :disabled="!workspaces.length" @click="edit()"><Plus :size="17" />创建技能包</button></header>
    <section class="panel"><div class="panel-header"><h2>全部技能包</h2><span class="badge gray">{{ items.length }} 个</span></div><div v-if="!items.length" class="empty"><Puzzle :size="32" /><strong>还没有技能包</strong><span>组合已有 Skill，并定义场景运行时的优先策略。</span></div><div v-else class="table-wrap"><table><thead><tr><th>名称</th><th>工作区</th><th>Skills</th><th>查找策略</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><div class="entity-title">{{ item.name }}</div><div class="entity-subtitle">{{ item.description || '暂无描述' }}</div></td><td><span class="badge">{{ workspaceName(item.workspaceId) }}</span></td><td><span class="mono">{{ item.skills.length }} 个</span></td><td><span class="badge gray">{{ {package_first:'技能包优先', mixed:'混合查找', package_only:'仅技能包'}[item.fallbackMode] }}</span></td><td><div class="actions"><button class="ghost-button" @click="edit(item)"><Pencil :size="15" />编辑</button><button class="danger-button" aria-label="删除技能包" @click="remove(item)"><Trash2 :size="15" /></button></div></td></tr></tbody></table></div></section>
    <div v-if="open" class="dialog-backdrop" @mousedown.self="open = false"><form class="dialog large" @submit.prevent="save"><header class="dialog-header"><div><h2>{{ form.id ? '编辑技能包' : '创建技能包' }}</h2><p>技能名称会在工作区与 Core 可用 Skill 中解析。</p></div><button type="button" class="icon-button" aria-label="关闭" @click="open = false"><X :size="19" /></button></header><div class="dialog-body">
      <div class="field-grid"><div class="field"><label for="package-name">名称</label><input id="package-name" v-model.trim="form.name" required placeholder="例如：数据分析" /></div><div class="field"><label for="package-workspace">工作区</label><select id="package-workspace" v-model="form.workspaceId" required><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></div></div>
      <div class="field"><label for="package-description">描述</label><input id="package-description" v-model.trim="form.description" placeholder="适用范围和预期产出" /></div>
      <div class="field"><label for="package-skills">Skills</label><div class="skill-picker"><textarea id="package-skills" ref="skillInput" v-model="form.skillsText" rows="5" class="mono" placeholder="输入 $ 选择当前可用 Skill，也可每行填写一个名称或路径" @input="updateTrigger" @click="updateTrigger" @keyup="updateTrigger" @keydown="onSkillKeydown" @blur="closeSkillMenu" /><div v-if="activeTrigger" class="skill-suggestion-menu" role="listbox"><div v-if="skillsLoading" class="skill-suggestion-status">正在读取 Skill…</div><template v-else><button v-for="(skill, index) in filteredSkills" :key="skill.path" type="button" :class="{ active: index === highlightedSkill }" @mousedown.prevent="selectSkill(skill)"><strong>${{ skill.displayName || skill.name }}</strong><span>{{ skill.description || skill.name }}</span><code>{{ skill.scope }} · {{ skill.path }}</code></button><div v-if="!filteredSkills.length" class="skill-suggestion-status">没有匹配的 Skill</div></template></div></div><small>输入 <code>$</code> 可检索工作区、用户和系统 Skill；每行保存一个 Skill 路径或名称。</small></div>
      <div class="field"><label for="fallback-mode">Skill 查找策略</label><select id="fallback-mode" v-model="form.fallbackMode"><option value="package_first">技能包优先，找不到再用其他 Skill</option><option value="mixed">技能包与其他 Skill 混合查找</option><option value="package_only">仅允许技能包内 Skill</option></select></div>
      <div class="field"><label for="package-prompt">技能包 Prompt</label><textarea id="package-prompt" v-model="form.prompt" rows="6" placeholder="定义执行步骤、输出格式和质量要求…" /></div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="open = false">取消</button><button class="button" :disabled="saving">{{ saving ? '保存中…' : '保存技能包' }}</button></footer></form></div>
  </div>
</template>
