<script setup lang="ts">
import { Bot as BotIcon, ExternalLink, KeyRound, Pencil, Plus, QrCode, Trash2, X } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { Bot, ProvisioningJob, Workspace } from '../types'
const items = ref<Bot[]>([]), workspaces = ref<Workspace[]>([]), open = ref(false), saving = ref(false), error = ref('')
const activeJob = ref<ProvisioningJob | null>(null)
let pollHandle: ReturnType<typeof setInterval> | null = null
const form = reactive({ id: '', createMode: 'existing' as 'existing'|'auto', name: '', description: '', appId: '', appSecret: '', prompt: '', operatorIdsText: '', replyMode: 'reply' as 'reply'|'topic', defaultWorkspaceId: '', workspaceIds: [] as string[] })
const canCreate = computed(() => workspaces.value.length > 0)
const load = async () => { [items.value, workspaces.value] = await Promise.all([api.bots(), api.workspaces()]) }
const pollJob = async () => {
  if (!activeJob.value || ['completed','failed','cancelled'].includes(activeJob.value.status)) return
  activeJob.value = await api.provisioningJob(activeJob.value.id)
  if (activeJob.value.status === 'completed') await load()
}
onMounted(async () => { await load(); activeJob.value = (await api.provisioningJobs()).find(job => ['starting','waiting_scan','creating'].includes(job.status)) ?? null; if (activeJob.value) pollHandle = setInterval(() => void pollJob(), 1200) })
onUnmounted(() => { if (pollHandle) clearInterval(pollHandle) })
const edit = (item?: Bot) => {
  Object.assign(form, item ? { ...item, createMode: 'existing', appSecret: '', operatorIdsText: item.operatorIds.join('\n'), workspaceIds: [...item.workspaceIds] } : { id: '', createMode: 'existing', name: '', description: '', appId: '', appSecret: '', prompt: '', operatorIdsText: '', replyMode: 'reply', defaultWorkspaceId: workspaces.value[0]?.id ?? '', workspaceIds: workspaces.value[0] ? [workspaces.value[0].id] : [] })
  error.value = ''; open.value = true
}
const toggleWorkspace = (id: string) => { const index = form.workspaceIds.indexOf(id); if (index >= 0) { if (id !== form.defaultWorkspaceId) form.workspaceIds.splice(index, 1) } else form.workspaceIds.push(id) }
const makeDefault = (id: string) => { form.defaultWorkspaceId = id; if (!form.workspaceIds.includes(id)) form.workspaceIds.push(id) }
const payload = () => ({ ...form, permissions: ['sandbox:danger-full-access'], operatorIds: form.operatorIdsText.split('\n').map(v => v.trim()).filter(Boolean) })
const save = async () => { saving.value = true; error.value = ''; try { if (!form.id && form.createMode === 'auto') { activeJob.value = await api.startProvisioning(payload()); if (pollHandle) clearInterval(pollHandle); pollHandle = setInterval(() => void pollJob(), 1200) } else await api.saveBot(payload()); open.value = false; await load() } catch (e) { error.value = e instanceof Error ? e.message : '保存失败' } finally { saving.value = false } }
const cancelJob = async () => { if (!activeJob.value) return; activeJob.value = await api.cancelProvisioning(activeJob.value.id) }
const remove = async (item: Bot) => { if (!confirm(`删除 Bot“${item.name}”以及它的场景路由？`)) return; try { await api.deleteBot(item.id); await load() } catch (e) { alert(e instanceof Error ? e.message : '删除失败') } }
const workspaceName = (id: string) => workspaces.value.find(item => item.id === id)?.name ?? '未知工作区'
</script>
<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Channel accounts</p><h1>飞书 Bot</h1><p class="page-description">接入已有飞书应用并为它配置默认工作区、可访问的其他工作区、基础 Prompt 和回复方式。</p></div><button class="button" :disabled="!canCreate" :title="canCreate ? '' : '请先创建工作区'" @click="edit()"><Plus :size="17" />创建 Bot</button></header>
    <div v-if="activeJob" class="notice" style="margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px"><div><strong style="display:block;margin-bottom:5px">{{ activeJob.status === 'waiting_scan' ? '等待扫码创建飞书应用' : activeJob.status === 'creating' ? '正在保存 Bot' : activeJob.status === 'completed' ? '自动注册完成' : activeJob.status === 'failed' ? '自动注册失败' : activeJob.status === 'cancelled' ? '自动注册已取消' : '正在申请二维码' }}</strong><span>{{ activeJob.error || '注册任务已持久化，可以离开此页面后再回来。' }}</span></div><div style="display:flex;gap:8px"><a v-if="activeJob.qrUrl" class="button" :href="activeJob.qrUrl" target="_blank" rel="noreferrer"><QrCode :size="16" />打开扫码页<ExternalLink :size="13" /></a><button v-if="!['completed','failed','cancelled'].includes(activeJob.status)" class="ghost-button" @click="cancelJob">取消</button></div></div>
    </div>
    <div v-if="!canCreate" class="notice" style="margin-bottom:16px">创建 Bot 之前需要至少一个工作区。Bot 的默认工作区用于处理尚未匹配场景的消息。</div>
    <section class="panel"><div class="panel-header"><h2>全部 Bot</h2><span class="badge gray">{{ items.length }} 个</span></div><div v-if="!items.length" class="empty"><BotIcon :size="32" /><strong>还没有 Bot</strong><span>关联一个飞书应用，或之后通过自动注册流程创建。</span></div><div v-else class="table-wrap"><table><thead><tr><th>Bot</th><th>飞书应用</th><th>默认工作区</th><th>回复方式</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><div class="entity-title">{{ item.name }}</div><div class="entity-subtitle">{{ item.description || '暂无描述' }}</div></td><td><div class="mono">{{ item.appId || '待配置' }}</div><div class="entity-subtitle"><KeyRound :size="11" style="vertical-align:-2px" /> {{ item.hasAppSecret ? '凭据已加密' : '未配置 Secret' }}</div></td><td><span class="badge">{{ workspaceName(item.defaultWorkspaceId) }}</span><div class="entity-subtitle">可访问 {{ item.workspaceIds.length }} 个工作区</div></td><td><span class="badge gray">{{ item.replyMode === 'topic' ? '话题回复' : '直接回复' }}</span></td><td><div class="actions"><button class="ghost-button" @click="edit(item)"><Pencil :size="15" />编辑</button><button class="danger-button" aria-label="删除 Bot" @click="remove(item)"><Trash2 :size="15" /></button></div></td></tr></tbody></table></div></section>
    <div v-if="open" class="dialog-backdrop" @mousedown.self="open = false"><form class="dialog large" @submit.prevent="save"><header class="dialog-header"><div><h2>{{ form.id ? '编辑 Bot' : '创建 Bot' }}</h2><p>可以接入已有应用，也可以扫码自动创建飞书应用。</p></div><button type="button" class="icon-button" aria-label="关闭" @click="open = false"><X :size="19" /></button></header><div class="dialog-body">
      <div class="field-grid"><div class="field"><label for="bot-name">名称</label><input id="bot-name" v-model.trim="form.name" required placeholder="例如：研发助手" /></div><div class="field"><label for="bot-reply-mode">默认回复方式</label><select id="bot-reply-mode" v-model="form.replyMode"><option value="reply">直接回复消息</option><option value="topic">在话题中回复</option></select></div></div>
      <div v-if="!form.id" class="field"><span class="field-label">飞书应用接入方式</span><div class="check-grid"><label class="check-card"><input v-model="form.createMode" type="radio" value="existing" /><span>使用已有应用</span></label><label class="check-card"><input v-model="form.createMode" type="radio" value="auto" /><span>扫码自动注册</span></label></div></div>
      <div class="field"><label for="bot-description">描述</label><input id="bot-description" v-model.trim="form.description" placeholder="这个 Bot 面向谁、解决什么问题" /></div>
      <div v-if="form.createMode === 'existing'" class="field-grid"><div class="field"><label for="app-id">Feishu App ID</label><input id="app-id" v-model.trim="form.appId" class="mono" placeholder="cli_xxxxxxxxx" /></div><div class="field"><label for="app-secret">Feishu App Secret</label><input id="app-secret" v-model.trim="form.appSecret" type="password" autocomplete="new-password" :placeholder="form.id ? '留空则保持原值' : '输入 App Secret'" /><small>仅加密保存在服务端，不会再次显示。</small></div></div>
      <div v-else class="notice">保存后会生成飞书扫码链接。完成授权后，App ID 和 App Secret 会自动写入并加密保存。</div>
      <div class="field"><span class="field-label">可访问的工作区</span><div class="check-grid"><label v-for="workspace in workspaces" :key="workspace.id" class="check-card"><input type="checkbox" :checked="form.workspaceIds.includes(workspace.id)" :disabled="workspace.id === form.defaultWorkspaceId" @change="toggleWorkspace(workspace.id)" /><span>{{ workspace.name }}</span></label></div></div>
      <div class="field"><label for="default-workspace">默认工作区</label><select id="default-workspace" :value="form.defaultWorkspaceId" required @change="makeDefault(($event.target as HTMLSelectElement).value)"><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select><small>未配置群和未匹配场景的消息会在这里运行。</small></div>
      <div class="field"><label for="bot-prompt">Bot Prompt</label><textarea id="bot-prompt" v-model="form.prompt" rows="5" placeholder="角色、语气、职责和限制…" /></div>
      <div class="notice"><strong>YOLO 执行模式</strong><br />Bot 会以 <span class="mono">approvalPolicy: never</span> 和 <span class="mono">danger-full-access</span> 运行，允许网络、命令和工具调用。</div>
      <div class="field"><label for="bot-operators">群场景操作人</label><textarea id="bot-operators" v-model="form.operatorIdsText" rows="3" class="mono" placeholder="ou_xxxxxxxxx\n每行一个飞书 Open ID" /><small>这些人可以通过飞书卡片为群绑定场景。留空时使用飞书应用管理员。</small></div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="open = false">取消</button><button class="button" :disabled="saving">{{ saving ? '保存中…' : '保存 Bot' }}</button></footer></form></div>
  </div>
</template>
