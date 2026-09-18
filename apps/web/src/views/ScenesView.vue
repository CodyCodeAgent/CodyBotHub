<script setup lang="ts">
import { CircleDot, Pencil, Plus, Trash2, Workflow, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { api, type MessageTypeOption } from '../api'
import type { Bot, ChatMetadata, Scene, SkillPackage, Workspace } from '../types'
const items = ref<Scene[]>([]), bots = ref<Bot[]>([]), workspaces = ref<Workspace[]>([]), packages = ref<SkillPackage[]>([]), messageTypeOptions = ref<MessageTypeOption[]>([]), open = ref(false), saving = ref(false), error = ref('')
const chats = ref<ChatMetadata[]>([]), chatInput = ref<HTMLTextAreaElement | null>(null), chatPickerFocused = ref(false)
const form = reactive({ id: '', botId: '', workspaceId: '', name: '', prompt: '', priority: 100, enabled: true, chatIdsText: '', messageTypes: [] as string[], textIncludesText: '', cardTitleIncludesText: '', skillPackageIds: [] as string[] })
const selectedBot = computed(() => bots.value.find(item => item.id === form.botId))
const availableWorkspaces = computed(() => workspaces.value.filter(item => selectedBot.value?.workspaceIds.includes(item.id)))
const availablePackages = computed(() => packages.value.filter(item => item.workspaceId === form.workspaceId))
const chatTrigger = computed(() => { const line = form.chatIdsText.split('\n').at(-1)?.trim() ?? ''; return line.startsWith('@') ? line.slice(1).trim().toLocaleLowerCase() : null })
const chatSuggestions = computed(() => {
  if (!chatPickerFocused.value || chatTrigger.value === null) return []
  const selected = new Set(form.chatIdsText.split('\n').map(value => value.trim()).filter(value => value && !value.startsWith('@')))
  return chats.value.filter(item => item.botId === form.botId && !selected.has(item.chatId) && (!chatTrigger.value || item.name.toLocaleLowerCase().includes(chatTrigger.value) || item.chatId.toLocaleLowerCase().includes(chatTrigger.value))).slice(0, 10)
})
const load = async () => { [items.value, bots.value, workspaces.value, packages.value, messageTypeOptions.value] = await Promise.all([api.scenes(), api.bots(), api.workspaces(), api.skillPackages(), api.feishuMessageTypes()]) }
onMounted(load)
const loadChats = async (botId: string) => { if (!botId) return; try { const current = await api.chats({ botId }); chats.value = [...chats.value.filter(item => item.botId !== botId), ...current] } catch { /* Chat ID can still be entered manually. */ } }
watch(() => form.botId, botId => { if (open.value && !availableWorkspaces.value.some(item => item.id === form.workspaceId)) form.workspaceId = selectedBot.value?.defaultWorkspaceId ?? availableWorkspaces.value[0]?.id ?? ''; if (open.value) void loadChats(botId) })
watch(() => form.workspaceId, () => { if (open.value) form.skillPackageIds = form.skillPackageIds.filter(id => availablePackages.value.some(item => item.id === id)) })
const edit = (item?: Scene) => {
  Object.assign(form, item ? { ...item, chatIdsText: item.matcher.chatIds.join('\n'), messageTypes: [...item.matcher.messageTypes], textIncludesText: item.matcher.textIncludes.join('\n'), cardTitleIncludesText: item.matcher.cardTitleIncludes.join('\n'), skillPackageIds: [...item.skillPackageIds] } : { id: '', botId: bots.value[0]?.id ?? '', workspaceId: bots.value[0]?.defaultWorkspaceId ?? '', name: '', prompt: '', priority: 100, enabled: true, chatIdsText: '', messageTypes: [], textIncludesText: '', cardTitleIncludesText: '', skillPackageIds: [] })
  error.value = ''; open.value = true; void loadChats(form.botId)
}
const lines = (value: string) => value.split('\n').map(v => v.trim()).filter(Boolean)
const save = async () => { saving.value = true; error.value = ''; try { const chatIds = lines(form.chatIdsText); if (chatIds.some(value => value.startsWith('@'))) throw new Error('请从候选中选择群，或填写完整 Chat ID'); await api.saveScene({ ...form, matcher: { chatIds, messageTypes: form.messageTypes, textIncludes: lines(form.textIncludesText), cardTitleIncludes: lines(form.cardTitleIncludesText) } }); open.value = false; await load() } catch (e) { error.value = e instanceof Error ? e.message : '保存失败' } finally { saving.value = false } }
const remove = async (item: Scene) => { if (!confirm(`删除场景“${item.name}”？`)) return; try { await api.deleteScene(item.id); await load() } catch (e) { alert(e instanceof Error ? e.message : '删除失败') } }
const togglePackage = (id: string) => { const index = form.skillPackageIds.indexOf(id); index >= 0 ? form.skillPackageIds.splice(index, 1) : form.skillPackageIds.push(id) }
const toggleMessageType = (value: string) => { const index = form.messageTypes.indexOf(value); index >= 0 ? form.messageTypes.splice(index, 1) : form.messageTypes.push(value) }
const selectChat = async (chat: ChatMetadata) => { const rows = form.chatIdsText.split('\n'); rows[rows.length - 1] = chat.chatId; form.chatIdsText = `${rows.join('\n')}\n`; await nextTick(); chatInput.value?.focus() }
const botName = (id: string) => bots.value.find(item => item.id === id)?.name ?? '未知 Bot'
const workspaceName = (id: string) => workspaces.value.find(item => item.id === id)?.name ?? '未知工作区'
const matcherSummary = (item: Scene) => {
  const parts = []
  if (item.matcher.chatIds.length) parts.push(`${item.matcher.chatIds.length} 个群`)
  if (item.matcher.messageTypes.length) parts.push(item.matcher.messageTypes.join(' / '))
  if (item.matcher.cardTitleIncludes.length) parts.push(`卡片标题 ${item.matcher.cardTitleIncludes.length} 条`)
  if (item.matcher.textIncludes.length) parts.push(`文本 ${item.matcher.textIncludes.length} 条`)
  return parts.join(' · ') || 'Bot 下的兜底场景'
}
</script>
<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Deterministic routing</p><h1>场景路由</h1><p class="page-description">场景是可复用的匹配模板。它把一类飞书消息固定路由到一个工作区，并决定当前消息使用的工作区、Prompt 和技能包。</p></div><button class="button" :disabled="!bots.length" @click="edit()"><Plus :size="17" />创建场景</button></header>
    <div v-if="!bots.length" class="notice" style="margin-bottom:16px">创建场景之前需要至少一个 Bot。每个场景只能使用该 Bot 已关联的工作区。</div>
    <section class="panel"><div class="panel-header"><h2>全部场景</h2><span class="badge gray">{{ items.length }} 个</span></div><div v-if="!items.length" class="empty"><Workflow :size="32" /><strong>还没有场景</strong><span>可以按群、消息类型、文本或卡片标题进行匹配。</span></div><div v-else class="table-wrap"><table><thead><tr><th>场景</th><th>Bot / 工作区</th><th>匹配条件</th><th>优先级</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><div class="entity-title"><CircleDot :size="12" :color="item.enabled ? 'var(--green)' : 'var(--muted)'" style="vertical-align:-1px;margin-right:6px" />{{ item.name }}</div><div class="entity-subtitle">{{ item.enabled ? '已启用' : '已停用' }} · 每轮动态路由</div></td><td><div>{{ botName(item.botId) }}</div><div class="entity-subtitle">{{ workspaceName(item.workspaceId) }}</div></td><td><span class="mono">{{ matcherSummary(item) }}</span></td><td><span class="badge gray">{{ item.priority }}</span></td><td><div class="actions"><button class="ghost-button" @click="edit(item)"><Pencil :size="15" />编辑</button><button class="danger-button" aria-label="删除场景" @click="remove(item)"><Trash2 :size="15" /></button></div></td></tr></tbody></table></div></section>
    <div v-if="open" class="dialog-backdrop" @mousedown.self="open = false"><form class="dialog large" @submit.prevent="save"><header class="dialog-header"><div><h2>{{ form.id ? '编辑场景' : '创建场景' }}</h2><p>多个场景命中时优先选择数值更小的场景。</p></div><button type="button" class="icon-button" aria-label="关闭" @click="open = false"><X :size="19" /></button></header><div class="dialog-body">
      <div class="field-grid"><div class="field"><label for="scene-name">名称</label><input id="scene-name" v-model.trim="form.name" required placeholder="例如：线上故障排查" /></div><div class="field"><label for="scene-priority">优先级</label><input id="scene-priority" v-model.number="form.priority" type="number" min="0" max="10000" required /></div></div>
      <div class="field-grid"><div class="field"><label for="scene-bot">Bot</label><select id="scene-bot" v-model="form.botId" required><option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.name }}</option></select></div><div class="field"><label for="scene-workspace">工作区</label><select id="scene-workspace" v-model="form.workspaceId" required><option v-for="workspace in availableWorkspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></div></div>
      <div class="field"><span class="field-label">状态</span><label class="check-card"><input v-model="form.enabled" type="checkbox" /><span>启用这个场景</span></label><small>场景只影响每轮路由，不改变 Bot 的会话模式或 Codex Thread。</small></div>
      <div class="field"><label for="scene-chat-ids">群 Chat ID</label><div class="skill-picker"><textarea id="scene-chat-ids" ref="chatInput" v-model="form.chatIdsText" rows="3" class="mono" placeholder="输入 @ 搜索已发现的群，也可每行粘贴一个 oc_xxx" @focus="chatPickerFocused = true" @blur="chatPickerFocused = false" /><div v-if="chatPickerFocused && chatTrigger !== null" class="skill-suggestion-menu" role="listbox"><button v-for="chat in chatSuggestions" :key="chat.chatId" type="button" @mousedown.prevent="selectChat(chat)"><strong>{{ chat.name || '未命名群' }}</strong><span>{{ chat.mode === 'topic' ? '话题群' : '普通群' }}</span><code>{{ chat.chatId }}</code></button><div v-if="!chatSuggestions.length" class="skill-suggestion-status">没有匹配的已发现群，仍可直接填写 Chat ID。</div></div></div><small>输入 <code>@群名</code> 选择当前 Bot 已经接触过的群；每行保存一个 Chat ID，留空表示不限制群。</small></div>
      <div class="field"><span class="field-label">消息类型</span><div class="check-grid message-type-grid"><label v-for="type in messageTypeOptions" :key="type.value" class="check-card"><input type="checkbox" :checked="form.messageTypes.includes(type.value)" @change="toggleMessageType(type.value)" /><span><strong>{{ type.label }}</strong><code>{{ type.value }}</code></span></label></div><small>留空表示匹配所有支持的消息类型。</small></div>
      <div class="field"><label for="text-includes">文本包含</label><textarea id="text-includes" v-model="form.textIncludesText" rows="3" placeholder="故障\n报警" /></div>
      <div class="field"><label for="card-title">卡片标题包含</label><textarea id="card-title" v-model="form.cardTitleIncludesText" rows="3" placeholder="P0 告警\n发布失败" /></div>
      <div class="field"><span class="field-label">技能包</span><div v-if="availablePackages.length" class="check-grid"><label v-for="item in availablePackages" :key="item.id" class="check-card"><input type="checkbox" :checked="form.skillPackageIds.includes(item.id)" @change="togglePackage(item.id)" /><span>{{ item.name }}</span></label></div><small v-else>这个工作区还没有技能包。</small></div>
      <div class="field"><label for="scene-prompt">场景 Prompt</label><textarea id="scene-prompt" v-model="form.prompt" rows="5" placeholder="描述当前场景的处理目标、约束和输出格式…" /></div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="open = false">取消</button><button class="button" :disabled="saving">{{ saving ? '保存中…' : '保存场景' }}</button></footer></form></div>
  </div>
</template>
