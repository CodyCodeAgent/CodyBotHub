<script setup lang="ts">
import { Boxes, FolderOpen, Pencil, Plus, Trash2, X } from 'lucide-vue-next'
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import DirectoryPicker from '../components/DirectoryPicker.vue'
import type { Workspace } from '../types'
const items = ref<Workspace[]>([]), open = ref(false), directoryPickerOpen = ref(false), saving = ref(false), error = ref('')
const form = reactive({ id: '', name: '', path: '', prompt: '' })
const load = async () => { items.value = await api.workspaces() }
onMounted(load)
const edit = (item?: Workspace) => { Object.assign(form, item ?? { id: '', name: '', path: '', prompt: '' }); error.value = ''; open.value = true }
const save = async () => { saving.value = true; error.value = ''; try { await api.saveWorkspace(form); open.value = false; await load() } catch (e) { error.value = e instanceof Error ? e.message : '保存失败' } finally { saving.value = false } }
const remove = async (item: Workspace) => { if (!confirm(`删除工作区“${item.name}”？`)) return; try { await api.deleteWorkspace(item.id); await load() } catch (e) { alert(e instanceof Error ? e.message : '删除失败') } }
const selectDirectory = (path: string) => { form.path = path; directoryPickerOpen.value = false }
</script>
<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Execution boundaries</p><h1>工作区</h1><p class="page-description">每个工作区对应一个本地目录，也是每轮消息的文件访问、Prompt 和执行边界。</p></div><button class="button" @click="edit()"><Plus :size="17" />创建工作区</button></header>
    <section class="panel"><div class="panel-header"><h2>全部工作区</h2><span class="badge gray">{{ items.length }} 个</span></div><div v-if="!items.length" class="empty"><Boxes :size="32" /><strong>还没有工作区</strong><span>先添加一个本地目录，再创建 Bot。</span></div><div v-else class="table-wrap"><table><thead><tr><th>名称</th><th>本地目录</th><th>Prompt</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><div class="entity-title">{{ item.name }}</div></td><td class="mono">{{ item.path }}</td><td><span :class="['badge', item.prompt ? 'green' : 'gray']">{{ item.prompt ? '已配置' : '未配置' }}</span></td><td><div class="actions"><button class="ghost-button" @click="edit(item)"><Pencil :size="15" />编辑</button><button class="danger-button" aria-label="删除工作区" @click="remove(item)"><Trash2 :size="15" /></button></div></td></tr></tbody></table></div></section>
    <div v-if="open" class="dialog-backdrop" @mousedown.self="open = false"><form class="dialog" @submit.prevent="save"><header class="dialog-header"><div><h2>{{ form.id ? '编辑工作区' : '创建工作区' }}</h2><p>目录必须已存在于 CodyBotHub 所在机器。</p></div><button type="button" class="icon-button" aria-label="关闭" @click="open = false"><X :size="19" /></button></header><div class="dialog-body"><div class="field-grid"><div class="field"><label for="workspace-name">名称</label><input id="workspace-name" v-model.trim="form.name" required placeholder="例如：营销自动化" /></div><div class="field"><label for="workspace-path">本地目录</label><div class="path-picker-field"><input id="workspace-path" :value="form.path" readonly required class="mono" placeholder="请选择本地目录" /><button type="button" class="ghost-button" @click="directoryPickerOpen = true"><FolderOpen :size="16" />选择目录</button></div><small>从服务所在机器的允许目录中选择。</small></div></div><div class="field"><label for="workspace-prompt">工作区 Prompt</label><textarea id="workspace-prompt" v-model="form.prompt" rows="6" placeholder="描述这个目录的上下文、规则和默认工作方式…" /><small>在平台基础 Prompt 之后、Bot Prompt 之前注入。</small></div><div v-if="error" class="error-banner" role="alert">{{ error }}</div></div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="open = false">取消</button><button class="button" :disabled="saving || !form.path">{{ saving ? '保存中…' : '保存工作区' }}</button></footer></form></div>
    <DirectoryPicker :visible="directoryPickerOpen" :initial-path="form.path" @close="directoryPickerOpen = false" @select="selectDirectory" />
  </div>
</template>
