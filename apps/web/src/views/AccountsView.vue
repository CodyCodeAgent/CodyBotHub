<script setup lang="ts">
import { KeyRound, Pencil, Plus, Trash2, UserRound, X } from 'lucide-vue-next'
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import type { AdminAccount } from '../types'

const items = ref<AdminAccount[]>([])
const currentAccountId = ref('')
const open = ref(false), saving = ref(false), error = ref('')
const form = reactive({ id: '', loginName: '', displayName: '', password: '', confirmPassword: '' })
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '从未登录'
const load = async () => {
  const [accounts, status] = await Promise.all([api.accounts(), api.authStatus()])
  items.value = accounts
  currentAccountId.value = status.account?.id ?? ''
}
onMounted(load)
const edit = (item?: AdminAccount) => {
  Object.assign(form, item ? { id: item.id, loginName: item.loginName, displayName: item.displayName, password: '', confirmPassword: '' } : { id: '', loginName: '', displayName: '', password: '', confirmPassword: '' })
  error.value = ''; open.value = true
}
const save = async () => {
  error.value = ''
  if (!form.id && !form.password) { error.value = '新账号必须设置密码'; return }
  if (form.password !== form.confirmPassword) { error.value = '两次输入的密码不一致'; return }
  saving.value = true
  try {
    await api.saveAccount({ ...(form.id ? { id: form.id } : {}), loginName: form.loginName, displayName: form.displayName, ...(form.password ? { password: form.password } : {}) })
    open.value = false
    await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { saving.value = false }
}
const remove = async (item: AdminAccount) => {
  if (!confirm(`删除平台账号“${item.loginName}”？删除后该账号的登录会话会立即失效。`)) return
  try { await api.deleteAccount(item.id); await load() }
  catch (cause) { alert(cause instanceof Error ? cause.message : '删除失败') }
}
</script>

<template>
  <div class="page">
    <header class="page-header"><div><p class="eyebrow">Administrator accounts</p><h1>账号管理</h1><p class="page-description">管理可登录 CodyBotHub 的平台管理员。账号名用于登录，用户名用于界面展示和操作审计。</p></div><button class="button" @click="edit()"><Plus :size="17" />新增账号</button></header>
    <section class="panel"><div class="panel-header"><h2>平台账号</h2><span class="badge gray">{{ items.length }} 个</span></div>
      <div v-if="!items.length" class="empty"><UserRound :size="32" /><strong>还没有平台账号</strong></div>
      <div v-else class="table-wrap"><table><thead><tr><th>账号</th><th>用户名</th><th>最近登录</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><div class="entity-title mono">{{ item.loginName }}</div><div class="entity-subtitle mono">{{ item.id }}</div></td><td><div>{{ item.displayName }}</div><div class="tag-list" style="margin-top:6px"><span v-if="item.primary" class="badge">主账号</span><span v-if="item.id === currentAccountId" class="badge green">当前账号</span></div></td><td class="mono">{{ formatTime(item.lastLoginAt) }}</td><td class="mono">{{ formatTime(item.createdAt) }}</td><td><div class="actions"><button class="ghost-button" @click="edit(item)"><Pencil :size="15" />编辑</button><button class="danger-button" :disabled="item.primary || item.id === currentAccountId" :title="item.primary ? '主账号不能删除' : item.id === currentAccountId ? '不能删除当前登录账号' : ''" @click="remove(item)"><Trash2 :size="15" />删除</button></div></td></tr></tbody></table></div>
    </section>
    <div v-if="open" class="dialog-backdrop" @mousedown.self="open = false"><form class="dialog" @submit.prevent="save"><header class="dialog-header"><div><h2>{{ form.id ? '编辑账号' : '新增账号' }}</h2><p>所有平台账号当前都拥有管理员权限。</p></div><button type="button" class="icon-button" aria-label="关闭" @click="open = false"><X :size="19" /></button></header><div class="dialog-body">
      <div class="field-grid"><div class="field"><label for="account-login">账号名</label><input id="account-login" v-model.trim="form.loginName" autocomplete="off" minlength="2" maxlength="64" required placeholder="例如：zhangsan" /><small>用于登录；支持字母、数字、点、下划线、@ 和连字符。</small></div><div class="field"><label for="account-display">用户名</label><input id="account-display" v-model.trim="form.displayName" maxlength="64" required placeholder="例如：张三" /><small>用于操作记录中标识操作者。</small></div></div>
      <div class="field-grid"><div class="field"><label for="account-password">密码</label><input id="account-password" v-model="form.password" type="password" autocomplete="new-password" minlength="10" :required="!form.id" :placeholder="form.id ? '留空则保持原密码' : '至少 10 个字符'" /></div><div class="field"><label for="account-confirm">确认密码</label><input id="account-confirm" v-model="form.confirmPassword" type="password" autocomplete="new-password" minlength="10" :required="Boolean(form.password)" placeholder="再次输入密码" /></div></div>
      <div class="notice"><KeyRound :size="15" style="vertical-align:-3px;margin-right:6px" />密码使用 Argon2id 哈希保存，不会在平台中回显。</div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="open = false">取消</button><button class="button" :disabled="saving">{{ saving ? '保存中…' : '保存账号' }}</button></footer></form></div>
  </div>
</template>
