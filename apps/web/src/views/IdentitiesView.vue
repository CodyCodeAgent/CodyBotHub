<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { KeyRound, Plus, RefreshCw } from 'lucide-vue-next'
import type { InteractionIdentity, IdentityCredential, IdentityType } from '@cody-bot-hub/contracts/interaction'
import type { Bot } from '../types'
import { api } from '../api'

const identities = ref<InteractionIdentity[]>([]), bots = ref<Bot[]>([]), credentials = ref<IdentityCredential[]>([])
const selected = ref<InteractionIdentity | null>(null), busy = ref(false), loading = ref(false), error = ref('')
const secretDialog = ref<HTMLDialogElement | null>(null), secret = ref(''), secretTitle = ref(''), copied = ref(false)
const credentialName = ref('production'), editingId = ref('')
const form = reactive({ name: '', type: 'digital_employee' as IdentityType, defaultBotId: '', allowedBotIds: [] as string[], enabled: true })
const botName = (id: string) => bots.value.find(bot => bot.id === id)?.name ?? id
const typeNames = { digital_employee: '数字员工', bot: '机器人', service: '服务账号' }
const allowedBots = computed(() => [...new Set([form.defaultBotId, ...form.allowedBotIds])].filter(Boolean))

async function load() {
  loading.value = true
  try {
    const [items, targets] = await Promise.all([api.identities(), api.bots()])
    identities.value = items; bots.value = targets
    if (!form.defaultBotId) form.defaultBotId = targets[0]?.id ?? ''
  } catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause) }
  finally { loading.value = false }
}
onMounted(load)
async function perform(action: () => Promise<void>) {
  busy.value = true; error.value = ''
  try { await action() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}
async function showSecret(title: string, value: string) {
  secretTitle.value = title; secret.value = value; copied.value = false
  await nextTick(); secretDialog.value?.showModal()
}
function clearForm() {
  editingId.value = ''
  Object.assign(form, { name: '', type: 'digital_employee', defaultBotId: bots.value[0]?.id ?? '', allowedBotIds: [], enabled: true })
}
function toggleBot(id: string, checked: boolean) {
  form.allowedBotIds = checked ? [...new Set([...form.allowedBotIds, id])] : form.allowedBotIds.filter(value => value !== id)
}
function edit(identity: InteractionIdentity) {
  editingId.value = identity.id
  Object.assign(form, { name: identity.name, type: identity.type, defaultBotId: identity.defaultBotId, allowedBotIds: [...identity.allowedBotIds], enabled: identity.enabled })
  document.getElementById('identity-name')?.focus()
}
async function save(invite = false) {
  await perform(async () => {
    const input = { name: form.name, type: form.type, defaultBotId: form.defaultBotId, allowedBotIds: allowedBots.value }
    if (editingId.value) await api.updateIdentity(editingId.value, { ...input, enabled: form.enabled })
    else if (invite) {
      const result = await api.inviteIdentity(input)
      await showSecret(`注册邀请（有效至 ${new Date(result.expiresAt).toLocaleString()}）`, result.registrationToken)
    } else {
      const result = await api.createIdentity(input)
      await showSecret('交互 Token · 仅显示一次', result.token)
    }
    clearForm(); await load()
    if (selected.value) await select(identities.value.find(item => item.id === selected.value?.id) ?? null)
  })
}
async function select(identity: InteractionIdentity | null) {
  selected.value = identity; credentials.value = []
  if (identity) credentials.value = await api.identityCredentials(identity.id)
}
async function issue() {
  if (!selected.value) return
  await perform(async () => {
    const result = await api.issueIdentityCredential(selected.value!.id, credentialName.value)
    await showSecret('交互 Token · 仅显示一次', result.token)
    await select(selected.value)
  })
}
async function revoke(item: IdentityCredential) {
  if (!confirm(`吊销 Token“${item.name}”？使用此 Token 的调用将立即失效。`)) return
  await perform(async () => { await api.revokeIdentityCredential(item.identityId, item.id); await select(selected.value) })
}
async function copySecret() {
  try { await navigator.clipboard.writeText(secret.value); copied.value = true }
  catch { error.value = '无法自动复制，请选择下方内容手动复制。' }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div><p class="eyebrow">Interaction identities</p><h1>交互身份</h1><p class="page-description">为数字员工和外部机器人签发 Token，绑定默认 Bot，通过 CLI 提交群消息并获取结果。</p></div>
      <button class="ghost-button" :disabled="loading || busy" @click="load"><RefreshCw :size="16" />刷新</button>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="!bots.length && !loading" class="notice">请先在 <RouterLink to="/bots">Bot 配置</RouterLink> 中创建执行 Bot 并选择工作区。仅通过 CLI 调用时，飞书 App ID 和 Secret 可以留空。</div>

    <section class="panel">
      <div class="panel-header"><h2>{{ editingId ? '编辑身份' : '注册身份' }}</h2><span class="badge gray">CLI 任务只读执行</span></div>
      <form class="identity-form" @submit.prevent="save()">
        <div class="field-grid">
          <div class="field"><label for="identity-name">身份名称</label><input id="identity-name" v-model.trim="form.name" maxlength="200" required placeholder="例如：勾云凡" /></div>
          <div class="field"><label for="identity-type">身份类型</label><select id="identity-type" v-model="form.type"><option value="digital_employee">数字员工</option><option value="bot">机器人</option><option value="service">服务账号</option></select></div>
          <div class="field"><label for="identity-bot">默认执行 Bot</label><select id="identity-bot" v-model="form.defaultBotId" required><option disabled value="">选择 Bot</option><option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.name }}</option></select><small>调用方无需传入 Bot ID，服务端根据 Token 自动选择。</small></div>
        </div>
        <details><summary>允许额外调用的 Bot</summary><div class="check-grid"><label v-for="bot in bots" :key="bot.id" class="check-card"><input type="checkbox" :checked="bot.id === form.defaultBotId || form.allowedBotIds.includes(bot.id)" :disabled="bot.id === form.defaultBotId" @change="toggleBot(bot.id, ($event.target as HTMLInputElement).checked)" /><span>{{ bot.name }}{{ bot.id === form.defaultBotId ? '（默认，始终允许）' : '' }}</span></label></div></details>
        <label v-if="editingId" class="check-card"><input v-model="form.enabled" type="checkbox" /><span>启用身份（关闭后所有 Token 立即停止接受新请求）</span></label>
        <div class="actions">
          <button class="button" :disabled="busy || !bots.length"><Plus :size="16" />{{ busy ? '处理中…' : editingId ? '保存身份' : '创建并领取 Token' }}</button>
          <button v-if="!editingId" class="ghost-button" type="button" :disabled="busy || !form.name || !form.defaultBotId" @click="save(true)">生成机器人注册邀请</button>
          <button v-else class="ghost-button" type="button" :disabled="busy" @click="clearForm">取消编辑</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="panel-header"><h2>已注册身份</h2><span class="badge gray">{{ identities.length }} 个</span></div>
      <p v-if="loading" class="empty" role="status">正在加载…</p>
      <p v-else-if="!identities.length" class="empty">创建一个身份，或让机器人使用一次性邀请完成注册。</p>
      <div v-else class="table-wrap"><table><thead><tr><th>身份</th><th>类型 / 来源</th><th>默认 Bot</th><th>状态</th><th>操作</th></tr></thead><tbody>
        <tr v-for="identity in identities" :key="identity.id"><td><div class="entity-title">{{ identity.name }}</div><div class="entity-subtitle mono">{{ identity.id }}</div></td><td>{{ typeNames[identity.type] }}<div class="entity-subtitle">{{ identity.registrationSource === 'manual' ? '管理员创建' : '机器人注册' }}</div></td><td>{{ botName(identity.defaultBotId) }}</td><td>{{ identity.enabled ? '已启用' : '已停用' }}</td><td><div class="actions"><button class="ghost-button" :disabled="busy" @click="edit(identity)">编辑</button><button class="ghost-button" :disabled="busy" @click="perform(() => select(identity))"><KeyRound :size="15" />Token 管理</button></div></td></tr>
      </tbody></table></div>
    </section>

    <section v-if="selected" class="panel">
      <div class="panel-header"><h2>{{ selected.name }} · Token</h2><span class="badge gray">每个实例可单独签发和吊销</span></div>
      <form class="identity-form" @submit.prevent="issue"><div class="field"><label for="credential-name">Token 名称</label><input id="credential-name" v-model.trim="credentialName" maxlength="200" required placeholder="例如：production" /></div><button class="button" :disabled="busy || !selected.enabled">签发新 Token</button></form>
      <div class="table-wrap"><table><thead><tr><th>名称</th><th>前缀</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in credentials" :key="item.id"><td>{{ item.name }}</td><td class="mono">{{ item.prefix }}…</td><td>{{ item.revokedAt ? '已吊销' : '可用' }}</td><td><button class="danger-button" :disabled="busy || Boolean(item.revokedAt)" @click="revoke(item)">吊销</button></td></tr></tbody></table></div>
    </section>

    <dialog ref="secretDialog" class="secret-dialog" aria-labelledby="secret-title" @close="secret = ''">
      <h2 id="secret-title">{{ secretTitle }}</h2>
      <p>复制并保存在调用机器人的 Secret 配置中，关闭后无法再次查看。</p>
      <label for="identity-secret">{{ secret.startsWith('cbh_invite_') ? 'CODYBOTHUB_REGISTRATION_TOKEN' : 'CODYBOTHUB_TOKEN' }}</label>
      <textarea id="identity-secret" :value="secret" readonly rows="3" class="mono" spellcheck="false" />
      <p v-if="secret.startsWith('cbh_invite_')">机器人配置邀请后执行 <code>codybothub identity register</code>，领取自己的交互 Token。邀请 15 分钟内有效，仅可使用一次。</p>
      <p v-else>配置 Token 后执行 <code>codybothub identity whoami</code> 验证身份。</p>
      <div class="actions"><button class="button" @click="copySecret">{{ copied ? '已复制' : '复制' }}</button><button class="ghost-button" @click="secretDialog?.close()">关闭</button></div>
    </dialog>
  </div>
</template>

<style scoped>
.identity-form { padding: 20px; display: grid; gap: 16px; }
.identity-form summary { cursor: pointer; margin-bottom: 12px; }
td:nth-child(2), td:nth-child(3), td:nth-child(4) { white-space: nowrap; }
.secret-dialog { width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; padding: 24px; border-radius: 16px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.secret-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.secret-dialog textarea { width: 100%; margin: 12px 0; overflow-wrap: anywhere; }
.secret-dialog p { line-height: 1.6; }
</style>
