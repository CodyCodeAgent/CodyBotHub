<script setup lang="ts">
import { CodyMarkdown } from '@codycodeagent/cody-web-core/vue'
import { Bot, Check, ChevronDown, Code2, LoaderCircle, MessageSquareText, RefreshCw, Search, Send, Sparkles, Trash2, UserRoundCog, Wrench, X } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import type { CopilotProposal, CopilotState, Workspace } from '../types'

const open = ref(false), busy = ref(false), error = ref(''), prompt = ref('')
const workspaces = ref<Workspace[]>([]), workspaceId = ref(''), state = ref<CopilotState | null>(null)
const messageList = ref<HTMLElement | null>(null), isDark = ref(true)
const quickPrompts = [
  { icon: Search, label: '查询 Open ID', text: '帮我查询一个人的飞书 Open ID。请先问我姓名或邮箱。' },
  { icon: Wrench, label: '检查平台配置', text: '概览当前工作区相关的 Bot、场景、技能包、工具和工具包配置。' },
  { icon: Code2, label: '编写托管脚本', text: '帮我设计一个平台托管脚本工具。请先询问用途、输入参数和预期输出。' },
]
const pendingProposals = computed(() => state.value?.proposals.filter(item => item.status === 'draft') ?? [])
const scriptPreview = (proposal: CopilotProposal) => String(proposal.payload.scriptContent ?? '').slice(0, 2400)
const language = (proposal: CopilotProposal) => String(proposal.payload.language ?? '')
const argumentCount = (proposal: CopilotProposal) => Array.isArray(proposal.payload.argumentsTemplate) ? proposal.payload.argumentsTemplate.length : 0
const value = (proposal: CopilotProposal, key: string) => String(proposal.payload[key] ?? '')
const updateTheme = () => { isDark.value = document.documentElement.dataset.theme !== 'light' }
let themeObserver: MutationObserver | null = null

const scrollBottom = async () => { await nextTick(); if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight }
const loadSession = async () => {
  if (!workspaceId.value) return
  busy.value = true; error.value = ''
  try { state.value = await api.copilotSession(workspaceId.value); await scrollBottom() }
  catch (value) { error.value = value instanceof Error ? value.message : String(value) }
  finally { busy.value = false }
}
const show = async () => {
  open.value = true
  if (!workspaces.value.length) {
    try { workspaces.value = await api.workspaces(); workspaceId.value ||= workspaces.value[0]?.id ?? '' }
    catch (value) { error.value = value instanceof Error ? value.message : String(value) }
  }
  if (workspaceId.value && !state.value) await loadSession()
}
const ask = async (text = prompt.value) => {
  const content = text.trim()
  if (!content || busy.value || !state.value) return
  prompt.value = ''; busy.value = true; error.value = ''
  const optimistic = { id: `pending-${Date.now()}`, sessionId: state.value.session.id, role: 'user' as const, content, createdAt: new Date().toISOString() }
  state.value.messages.push(optimistic); await scrollBottom()
  try { state.value = await api.askCopilot(state.value.session.id, content); await scrollBottom() }
  catch (value) { state.value.messages = state.value.messages.filter(item => item.id !== optimistic.id); prompt.value = content; error.value = value instanceof Error ? value.message : String(value) }
  finally { busy.value = false }
}
const reset = async () => {
  if (!state.value || busy.value) return
  busy.value = true; error.value = ''
  try { state.value = await api.resetCopilot(state.value.session.id) }
  catch (value) { error.value = value instanceof Error ? value.message : String(value) }
  finally { busy.value = false }
}
const apply = async (proposal: CopilotProposal) => {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await api.applyCopilotProposal(proposal.id)
    Object.assign(proposal, result.proposal)
    const content = result.target.type === 'tool'
      ? `已创建托管工具 **${result.target.name}**，工具 ID：\`${result.target.id}\`。你可以在“工具”页面继续检查或关联工具包。`
      : `已更新 Bot **${result.target.name}** 的操作人配置。配置已经热重载并写入操作记录。`
    state.value?.messages.push({ id: `applied-${proposal.id}`, sessionId: proposal.sessionId, role: 'assistant', content, createdAt: new Date().toISOString() })
    await scrollBottom()
  } catch (value) { error.value = value instanceof Error ? value.message : String(value) }
  finally { busy.value = false }
}
const dismiss = async (proposal: CopilotProposal) => {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { Object.assign(proposal, await api.dismissCopilotProposal(proposal.id)) }
  catch (value) { error.value = value instanceof Error ? value.message : String(value) }
  finally { busy.value = false }
}
watch(workspaceId, () => { state.value = null; if (open.value) void loadSession() })
onMounted(() => { updateTheme(); themeObserver = new MutationObserver(updateTheme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }) })
onBeforeUnmount(() => themeObserver?.disconnect())
</script>

<template>
  <button class="copilot-launcher" :class="{ active: open }" aria-label="打开平台 Copilot" @click="open ? open = false : show()">
    <span class="copilot-pulse" aria-hidden="true" /><Sparkles :size="21" /><span>AI</span>
    <b v-if="pendingProposals.length">{{ pendingProposals.length }}</b>
  </button>
  <Transition name="copilot-fade"><div v-if="open" class="copilot-scrim" @click="open = false" /></Transition>
  <Transition name="copilot-slide">
    <aside v-if="open" class="copilot-panel" aria-label="平台 Copilot">
      <header class="copilot-head">
        <div class="copilot-identity"><span class="copilot-avatar"><Bot :size="21" /></span><div><strong>平台 Copilot</strong><small><span /> CodyWebCore · 管理模式</small></div></div>
        <div class="copilot-head-actions"><button class="icon-button" aria-label="新建会话" title="新建会话" :disabled="busy || !state" @click="reset"><RefreshCw :size="17" /></button><button class="icon-button" aria-label="关闭 Copilot" @click="open = false"><X :size="19" /></button></div>
      </header>
      <div class="copilot-context">
        <label for="copilot-workspace">工作区</label>
        <div class="copilot-select"><select id="copilot-workspace" v-model="workspaceId" :disabled="busy"><option v-for="item in workspaces" :key="item.id" :value="item.id">{{ item.name }}</option></select><ChevronDown :size="15" /></div>
        <span v-if="state?.session.coreThreadId" title="该 Copilot 会话对应的 Codex Thread">Thread {{ state.session.coreThreadId.slice(0, 8) }}</span>
      </div>
      <div ref="messageList" class="copilot-messages">
        <section v-if="!state?.messages.length && !busy" class="copilot-empty">
          <div class="copilot-orb"><Sparkles :size="27" /></div>
          <h2>今天想管理什么？</h2>
          <p>查询人员与平台配置，或者让 AI 生成可审查的工具草稿。</p>
          <div class="copilot-quick"><button v-for="item in quickPrompts" :key="item.label" @click="ask(item.text)"><component :is="item.icon" :size="17" /><span><strong>{{ item.label }}</strong><small>{{ item.text }}</small></span></button></div>
        </section>
        <template v-for="message in state?.messages ?? []" :key="message.id">
          <article class="copilot-message" :class="message.role"><div class="message-role">{{ message.role === 'user' ? 'YOU' : 'COPILOT' }}</div><div class="message-bubble"><CodyMarkdown v-if="message.role === 'assistant'" :text="message.content" :dark="isDark" /><p v-else>{{ message.content }}</p></div></article>
        </template>
        <section v-for="proposal in pendingProposals" :key="proposal.id" class="copilot-proposal">
          <div class="proposal-head"><span><Code2 v-if="proposal.kind === 'managed_script'" :size="17" /><UserRoundCog v-else :size="17" /></span><div><small>待确认草稿</small><strong>{{ proposal.title }}</strong></div></div>
          <template v-if="proposal.kind === 'managed_script'">
            <div class="proposal-meta"><span>{{ language(proposal) }}</span><span>{{ proposal.payload.timeoutSeconds }}s</span><span>{{ argumentCount(proposal) }} 个参数</span></div>
            <pre><code>{{ scriptPreview(proposal) }}</code></pre>
          </template>
          <div v-else class="proposal-change">
            <span>{{ value(proposal, 'action') === 'add' ? '添加操作人' : '移除操作人' }}</span>
            <dl><div><dt>Bot</dt><dd>{{ value(proposal, 'botName') }}</dd></div><div><dt>人员</dt><dd>{{ value(proposal, 'personName') || '未提供姓名' }}</dd></div><div><dt>Open ID</dt><dd>{{ value(proposal, 'openId') }}</dd></div></dl>
          </div>
          <div class="proposal-actions"><button class="ghost-button" @click="dismiss(proposal)"><Trash2 :size="16" />放弃</button><button class="button" @click="apply(proposal)"><Check :size="16" />{{ proposal.kind === 'managed_script' ? '确认创建工具' : '确认更新 Bot' }}</button></div>
        </section>
        <div v-if="busy" class="copilot-thinking"><LoaderCircle :size="17" /><span>Copilot 正在处理</span><i /><i /><i /></div>
      </div>
      <p v-if="error" class="copilot-error">{{ error }}</p>
      <footer class="copilot-composer">
        <textarea v-model="prompt" rows="3" placeholder="问人员 Open ID、检查配置、编写托管脚本…" :disabled="busy || !state" @keydown.meta.enter.prevent="ask()" @keydown.ctrl.enter.prevent="ask()" />
        <div><span><MessageSquareText :size="14" />写操作会先生成草稿</span><button class="copilot-send" aria-label="发送" :disabled="busy || !prompt.trim() || !state" @click="ask()"><Send :size="18" /></button></div>
      </footer>
    </aside>
  </Transition>
</template>

<style scoped>
.copilot-launcher{position:fixed;z-index:55;right:24px;bottom:24px;min-width:58px;height:54px;display:flex;align-items:center;justify-content:center;gap:6px;color:#fff;background:linear-gradient(135deg,#705cff,#26bce9);border:1px solid rgba(255,255,255,.24);border-radius:17px;box-shadow:0 18px 50px rgba(61,49,200,.38),0 0 28px rgba(69,217,255,.12);font-weight:800;letter-spacing:.04em;transition:transform .2s ease,box-shadow .2s ease}.copilot-launcher:hover{transform:translateY(-2px);box-shadow:0 22px 60px rgba(61,49,200,.46),0 0 34px rgba(69,217,255,.18)}.copilot-launcher.active{transform:scale(.94);opacity:0;pointer-events:none}.copilot-launcher b{position:absolute;right:-5px;top:-5px;min-width:20px;height:20px;padding:0 5px;display:grid;place-items:center;background:var(--danger);border:2px solid var(--bg);border-radius:99px;font-size:10px}.copilot-pulse{position:absolute;inset:-5px;border:1px solid rgba(69,217,255,.3);border-radius:21px;animation:pulse 2.6s ease-out infinite}
.copilot-scrim{position:fixed;z-index:60;inset:0;background:rgba(2,4,13,.42);backdrop-filter:blur(2px)}.copilot-panel{position:fixed;z-index:61;inset:12px 12px 12px auto;width:min(560px,calc(100vw - 24px));display:grid;grid-template-rows:auto auto 1fr auto auto;overflow:hidden;color:var(--text);background:color-mix(in srgb,var(--sidebar) 94%,transparent);border:1px solid var(--primary-border);border-radius:20px;box-shadow:0 32px 100px rgba(0,0,0,.62),0 0 70px rgba(112,92,255,.08);backdrop-filter:blur(24px)}
.copilot-head{height:74px;display:flex;align-items:center;justify-content:space-between;padding:0 18px 0 20px;border-bottom:1px solid var(--border);background:linear-gradient(110deg,var(--primary-soft),transparent 60%)}.copilot-identity{display:flex;align-items:center;gap:12px}.copilot-avatar{width:40px;height:40px;display:grid;place-items:center;color:#fff;background:linear-gradient(145deg,#7b6cff,#30bde8);border-radius:13px;box-shadow:0 8px 24px rgba(79,70,229,.3)}.copilot-identity strong{display:block;font-size:15px}.copilot-identity small{display:flex;align-items:center;gap:6px;margin-top:4px;color:var(--muted);font:600 9px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.copilot-identity small span{width:6px;height:6px;background:var(--green);border-radius:50%;box-shadow:0 0 9px var(--green)}.copilot-head-actions{display:flex;gap:4px}.copilot-head-actions .icon-button{width:38px;height:38px;background:transparent;border-radius:10px}.copilot-head-actions .icon-button:hover{background:var(--surface-soft)}
.copilot-context{min-height:54px;display:flex;align-items:center;gap:9px;padding:8px 18px;border-bottom:1px solid var(--border)}.copilot-context label{color:var(--muted);font-size:11px}.copilot-select{position:relative;min-width:155px}.copilot-select select{width:100%;height:34px;padding:0 30px 0 10px;color:var(--text-soft);background:var(--surface-input);border:1px solid var(--border);border-radius:9px;appearance:none;font-size:12px}.copilot-select svg{position:absolute;right:9px;top:9px;pointer-events:none;color:var(--muted)}.copilot-context>span{margin-left:auto;color:var(--muted);font:10px ui-monospace,monospace}
.copilot-messages{min-height:0;overflow-y:auto;padding:22px 20px 30px;scrollbar-width:thin;overscroll-behavior:contain}.copilot-empty{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 4px}.copilot-orb{width:64px;height:64px;display:grid;place-items:center;color:var(--cyan);background:radial-gradient(circle at 34% 28%,rgba(69,217,255,.22),var(--primary-soft));border:1px solid var(--cyan-border);border-radius:22px;box-shadow:0 0 44px rgba(69,217,255,.1)}.copilot-empty h2{margin:20px 0 7px;font-size:22px}.copilot-empty>p{max-width:390px;color:var(--muted);font-size:13px;line-height:1.6}.copilot-quick{width:100%;display:grid;gap:9px;margin-top:18px}.copilot-quick button{min-height:62px;display:flex;align-items:center;gap:12px;text-align:left;padding:11px 13px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:12px;transition:border-color .18s ease,background .18s ease}.copilot-quick button:hover{background:var(--surface-raised);border-color:var(--primary-border)}.copilot-quick button>svg{color:var(--primary)}.copilot-quick strong,.copilot-quick small{display:block}.copilot-quick strong{font-size:12px}.copilot-quick small{margin-top:4px;color:var(--muted);font-size:10px;line-height:1.35}
.copilot-message{max-width:92%;margin:0 0 18px}.copilot-message.user{margin-left:auto}.message-role{margin:0 4px 6px;color:var(--muted);font:700 9px/1 ui-monospace,monospace;letter-spacing:.12em}.copilot-message.user .message-role{text-align:right}.message-bubble{padding:13px 15px;background:var(--surface-raised);border:1px solid var(--border);border-radius:5px 15px 15px}.user .message-bubble{color:#fff;background:linear-gradient(135deg,#6655df,#4e56c8);border-color:rgba(255,255,255,.1);border-radius:15px 5px 15px 15px}.message-bubble p{margin:0;white-space:pre-wrap;font-size:13px;line-height:1.65}.message-bubble :deep(.cody-markdown){font-size:13px;line-height:1.65}.message-bubble :deep(pre){max-width:100%;overflow:auto}
.copilot-proposal{margin:4px 0 20px;padding:15px;background:linear-gradient(145deg,var(--primary-soft),var(--surface));border:1px solid var(--primary-border);border-radius:15px;box-shadow:0 10px 30px rgba(0,0,0,.14)}.proposal-head{display:flex;align-items:center;gap:10px}.proposal-head>span{width:34px;height:34px;display:grid;place-items:center;color:var(--cyan);background:var(--cyan-soft);border-radius:10px}.proposal-head small,.proposal-head strong{display:block}.proposal-head small{color:var(--primary);font:700 9px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}.proposal-head strong{margin-top:3px;font-size:13px}.proposal-meta{display:flex;gap:7px;margin:12px 0 9px}.proposal-meta span{padding:4px 7px;color:var(--muted);background:var(--surface-input);border:1px solid var(--border);border-radius:7px;font:10px ui-monospace,monospace}.copilot-proposal pre{max-height:220px;overflow:auto;margin:0;padding:12px;color:var(--text-soft);background:var(--surface-input);border:1px solid var(--border);border-radius:10px;font:10px/1.55 ui-monospace,monospace;white-space:pre-wrap}.proposal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.proposal-actions button{min-height:36px;font-size:11px}.copilot-thinking{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}.copilot-thinking svg{color:var(--primary);animation:spin 1s linear infinite}.copilot-thinking i{width:4px;height:4px;background:var(--primary);border-radius:50%;animation:blink 1.2s infinite}.copilot-thinking i:nth-child(3){animation-delay:.15s}.copilot-thinking i:nth-child(4){animation-delay:.3s}.copilot-error{margin:0;padding:9px 18px;color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,transparent);border-top:1px solid color-mix(in srgb,var(--danger) 20%,transparent);font-size:11px}
.proposal-change{margin-top:12px;padding:12px;background:var(--surface-input);border:1px solid var(--border);border-radius:10px}.proposal-change>span{display:inline-flex;padding:4px 8px;color:var(--cyan);background:var(--cyan-soft);border-radius:7px;font-size:10px;font-weight:700}.proposal-change dl{margin:9px 0 0}.proposal-change dl>div{display:grid;grid-template-columns:64px 1fr;gap:8px;padding:5px 0;border-top:1px solid var(--border)}.proposal-change dt{color:var(--muted);font-size:10px}.proposal-change dd{min-width:0;margin:0;color:var(--text-soft);font:11px/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
.copilot-composer{padding:12px 14px 14px;border-top:1px solid var(--border);background:color-mix(in srgb,var(--sidebar) 92%,transparent)}.copilot-composer textarea{width:100%;min-height:72px;max-height:180px;resize:vertical;padding:12px;color:var(--text);background:var(--surface-input);border:1px solid var(--border-strong);border-radius:12px;font-size:13px;line-height:1.5}.copilot-composer textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft);outline:0}.copilot-composer>div{display:flex;align-items:center;justify-content:space-between;margin-top:8px}.copilot-composer>div>span{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}.copilot-send{width:38px;height:38px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--primary-strong),#248fc2);border:0;border-radius:11px}.copilot-send:disabled{cursor:not-allowed;opacity:.4}
.copilot-slide-enter-active,.copilot-slide-leave-active{transition:transform .26s cubic-bezier(.16,1,.3,1),opacity .2s ease}.copilot-slide-enter-from,.copilot-slide-leave-to{transform:translateX(32px);opacity:0}.copilot-fade-enter-active,.copilot-fade-leave-active{transition:opacity .2s ease}.copilot-fade-enter-from,.copilot-fade-leave-to{opacity:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{0%,70%,100%{opacity:.25}35%{opacity:1}}@keyframes pulse{0%{opacity:.6;transform:scale(.96)}70%,100%{opacity:0;transform:scale(1.1)}}
@media(max-width:640px){.copilot-panel{inset:0;width:100%;border:0;border-radius:0}.copilot-launcher{right:16px;bottom:16px}.copilot-scrim{display:none}.copilot-context>span{display:none}.copilot-messages{padding:18px 14px 24px}.copilot-message{max-width:96%}}@media(prefers-reduced-motion:reduce){.copilot-pulse,.copilot-thinking svg,.copilot-thinking i{animation:none}.copilot-slide-enter-active,.copilot-slide-leave-active,.copilot-fade-enter-active,.copilot-fade-leave-active{transition:none}}
</style>
