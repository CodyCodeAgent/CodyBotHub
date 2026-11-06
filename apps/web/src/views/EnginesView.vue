<script setup lang="ts">
import { Check, CircleCheck, CircleHelp, Cpu, RefreshCw, Save, TriangleAlert } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { api } from '../api'
import ModelConfigFields from '../components/ModelConfigFields.vue'
import type { AgentRuntimeKind, ModelCatalog, PlatformSettings } from '../types'

type EngineDraft = { kind: AgentRuntimeKind; label: string; description: string; model: string; effort: string; catalog: ModelCatalog; status: 'unchecked' | 'checking' | 'ready' | 'failed'; error: string }
const engines = reactive<EngineDraft[]>([
  { kind: 'codex', label: 'Codex', description: '连接 Codex，使用它的模型和原生会话。', model: '', effort: '', catalog: { items: [], defaultModel: '', defaultReasoningEffort: '' }, status: 'unchecked', error: '' },
  { kind: 'traex', label: 'TraeX', description: '连接 TraeX，使用它的模型和原生会话。', model: '', effort: '', catalog: { items: [], defaultModel: '', defaultReasoningEffort: '' }, status: 'unchecked', error: '' },
])
const defaultKind = ref<AgentRuntimeKind>('codex'), fallback = ref(true), loading = ref(true), saving = ref(false), error = ref(''), saved = ref(false), baseline = ref('')
const snapshot = () => JSON.stringify({ defaultKind: defaultKind.value, fallback: fallback.value, models: engines.map(engine => [engine.model, engine.effort]) })
const dirty = computed(() => !loading.value && Boolean(baseline.value) && baseline.value !== snapshot())
const defaultEngine = computed(() => engines.find(engine => engine.kind === defaultKind.value)!)
const labels = { unchecked: '尚未检测', checking: '正在连接', ready: '连接正常', failed: '连接失败' }
async function check(engine: EngineDraft) {
  if (engine.status === 'checking') return
  engine.status = 'checking'; engine.error = ''
  try { engine.catalog = await api.models(engine.kind); engine.status = 'ready' }
  catch (cause) { engine.status = 'failed'; engine.error = cause instanceof Error ? cause.message : '无法读取模型目录' }
}
async function setDefault(engine: EngineDraft) {
  if (engine.status !== 'ready') await check(engine)
  if (engine.status === 'ready') { defaultKind.value = engine.kind; error.value = '' }
  else error.value = `请先确认 ${engine.label} 连接正常，再设为平台默认。`
}
function fill(settings: PlatformSettings) {
  defaultKind.value = settings.defaultRuntimeKind ?? 'codex'; fallback.value = settings.modelFallbackEnabled
  for (const engine of engines) {
    engine.model = engine.kind === 'codex' ? settings.defaultModel : settings.traexDefaultModel ?? ''
    engine.effort = engine.kind === 'codex' ? settings.defaultReasoningEffort : settings.traexDefaultReasoningEffort ?? ''
  }
  baseline.value = snapshot()
}
async function load() {
  loading.value = true; error.value = ''
  try { fill(await api.settings()); void check(defaultEngine.value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取引擎配置' }
  finally { loading.value = false }
}
async function save() {
  saving.value = true; saved.value = false; error.value = ''
  try {
    const current = await api.settings(), codex = engines.find(engine => engine.kind === 'codex')!, traex = engines.find(engine => engine.kind === 'traex')!
    fill(await api.saveSettings({ ...current, defaultRuntimeKind: defaultKind.value, defaultModel: codex.model, defaultReasoningEffort: codex.effort, traexDefaultModel: traex.model, traexDefaultReasoningEffort: traex.effort, modelFallbackEnabled: fallback.value }))
    saved.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试' }
  finally { saving.value = false }
}
onMounted(load)
onBeforeRouteLeave(() => !dirty.value || confirm('引擎配置尚未保存，确定离开？'))
</script>

<template>
  <div class="page engines-page">
    <header class="page-header"><div><p class="eyebrow">AI engine management</p><h1>AI 引擎</h1><p class="page-description">选择平台使用的 AI 引擎，为每个引擎配置独立的默认模型。</p></div><span class="badge gray">{{ engines.length }} 个支持的引擎</span></header>
    <div v-if="loading" class="panel empty" role="status">正在加载引擎配置…</div>
    <div v-else-if="!baseline" class="panel empty"><p role="alert">{{ error }}</p><button type="button" class="ghost-button" @click="load">重新加载配置</button></div>
    <form v-else @submit.prevent="save">
      <section class="engine-overview panel" aria-label="平台默认引擎">
        <div class="engine-overview-icon"><Cpu :size="26" aria-hidden="true" /></div><div><p class="engine-kicker">平台默认引擎</p><h2>{{ defaultEngine.label }} <span v-if="dirty" class="badge gray">有未保存的修改</span></h2><p>用于平台 Copilot、新建 Bot、定时任务和默认技能查询。</p></div><div class="engine-overview-model"><span>平台默认模型</span><strong>{{ defaultEngine.model || defaultEngine.catalog.defaultModel || '跟随账户默认' }}</strong></div>
      </section>
      <div class="engine-card-grid">
        <section v-for="engine in engines" :key="engine.kind" class="panel engine-card" :class="{ 'is-default': defaultKind === engine.kind }" :aria-labelledby="`engine-${engine.kind}`">
          <header class="engine-card-heading"><div class="engine-name"><span class="engine-monogram" aria-hidden="true">{{ engine.kind === 'codex' ? 'C' : 'T' }}</span><div><h2 :id="`engine-${engine.kind}`">{{ engine.label }}</h2><span class="engine-status" :class="engine.status" role="status"><CircleCheck v-if="engine.status === 'ready'" :size="14" /><TriangleAlert v-else-if="engine.status === 'failed'" :size="14" /><CircleHelp v-else :size="14" />{{ labels[engine.status] }}</span></div></div><span v-if="defaultKind === engine.kind" class="badge green"><Check :size="12" />平台默认</span></header>
          <p class="engine-description">{{ engine.description }}</p>
          <div class="engine-card-actions"><button type="button" class="ghost-button" :disabled="engine.status === 'checking' || saving" @click="check(engine)"><RefreshCw :size="15" />{{ engine.status === 'checking' ? '检测中…' : engine.status === 'unchecked' ? '检测连接' : '重新检测' }}</button><button v-if="defaultKind !== engine.kind" type="button" class="ghost-button" :disabled="saving || engine.status === 'checking'" @click="setDefault(engine)">设为平台默认</button></div>
          <div class="engine-connection-result" aria-live="polite">
            <template v-if="engine.status === 'ready'"><strong>{{ engine.catalog.items.length }} 个可用模型</strong><span>账户当前默认：{{ engine.catalog.defaultModel || '由引擎决定' }}</span></template>
            <template v-else-if="engine.status === 'failed'"><strong>暂时无法连接 {{ engine.label }}</strong><span>检查服务端是否已安装 CLI 并完成登录，再重新检测。其他引擎仍可独立使用。</span><details><summary>查看错误详情</summary><code>{{ engine.error }}</code></details></template>
            <template v-else><strong>{{ engine.status === 'checking' ? '正在读取模型目录…' : '检测后可选择该引擎的模型' }}</strong><span>只需安装你要使用的引擎。检测不会修改现有配置。</span></template>
          </div>
          <div class="engine-model-config"><h3>平台模型默认值</h3><p>Bot、场景或定时任务未单独指定时使用。</p><ModelConfigFields :catalog="engine.catalog" :model="engine.model" :reasoning-effort="engine.effort" :runtime-kind="engine.kind" :inherit-label="`跟随 ${engine.label} 账户默认`" :disabled="engine.status !== 'ready' || saving" :inherited-model="engine.catalog.defaultModel" @update:model="engine.model = $event; saved = false" @update:reasoning-effort="engine.effort = $event; saved = false" /></div>
        </section>
      </div>
      <section class="panel engine-inheritance"><div><h2>默认值如何生效</h2><p>每个引擎只继承自己的模型配置，明确指定的模型优先。</p></div><ol><li><span>01</span><strong>任务 / 场景指定</strong></li><li><span>02</span><strong>Bot 配置</strong><small>仅 Bot 场景</small></li><li><span>03</span><strong>平台引擎默认</strong></li><li><span>04</span><strong>引擎账户默认</strong></li></ol><label class="engine-fallback"><input v-model="fallback" type="checkbox" :disabled="saving" /><span><strong>模型不可用时自动回退</strong><small>回退到同一引擎的账户默认值，并记录回退情况。</small></span></label></section>
      <footer class="engine-save-bar"><div><p v-if="error" class="engine-save-error" role="alert">{{ error }}</p><p v-else-if="saved && !dirty" class="engine-saved" role="status"><CircleCheck :size="16" />引擎配置已保存</p><p v-else>{{ dirty ? '配置有修改，保存后生效。' : '更改平台默认引擎，不会切换已有 Bot 的引擎。' }}</p></div><button class="button" :disabled="saving || !dirty"><Save :size="16" />{{ saving ? '保存中…' : '保存引擎配置' }}</button></footer>
    </form>
  </div>
</template>

<style scoped>
.engines-page { max-width:1240px }
.engine-overview { padding:24px; display:flex; align-items:center; gap:18px; margin-bottom:24px }
.engine-overview-icon { display:grid; place-items:center; width:56px; height:56px; border:1px solid var(--border-strong); border-radius:14px; color:var(--green); background:var(--surface-raised); flex-shrink:0 }
.engine-kicker { font-size:12px; color:var(--text-soft); margin:0 0 7px }
.engine-overview h2 { display:flex; align-items:center; gap:12px; font-size:23px; margin:0 }
.engine-overview p:not(.engine-kicker) { font-size:13px; color:var(--text-soft); line-height:1.6; margin:7px 0 0 }
.engine-overview-model { margin-left:auto; max-width:35%; text-align:right; overflow-wrap:anywhere }
.engine-overview-model span,.engine-overview-model strong { display:block; font-size:13px; line-height:1.6 }
.engine-overview-model span { color:var(--text-soft); margin-bottom:7px }
.engine-card-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px }
.engine-card { padding:24px; min-width:0 }
.engine-card.is-default { border-color:var(--green) }
.engine-card-heading,.engine-name { display:flex; align-items:center; gap:12px }
.engine-card-heading { justify-content:space-between }
.engine-monogram { display:grid; place-items:center; width:44px; height:44px; border-radius:12px; border:1px solid var(--border-strong); background:var(--surface-raised); font-size:22px; font-weight:650 }
.engine-name h2 { margin:0 0 6px; font-size:20px }
.engine-status { display:flex; gap:5px; align-items:center; color:var(--text-soft); font-size:12px }
.engine-status.ready { color:var(--green) }
.engine-status.failed { color:var(--orange,var(--text)) }
.engine-description { font-size:13px; line-height:1.6; color:var(--text-soft); margin:18px 0 }
.engine-card-actions { display:flex; flex-wrap:wrap; gap:8px }
.engine-card-actions button { min-height:40px }
.engine-connection-result { margin:20px 0; padding:16px; min-height:90px; background:var(--surface-raised); border-radius:10px; font-size:12px; line-height:1.7; overflow-wrap:anywhere }
.engine-connection-result strong,.engine-connection-result span { display:block }
.engine-connection-result span { color:var(--text-soft); margin-top:5px }
.engine-connection-result summary { cursor:pointer; margin-top:10px }
.engine-connection-result code { display:block; margin-top:8px; white-space:pre-wrap }
.engine-model-config { border-top:1px solid var(--border); padding-top:20px }
.engine-model-config h3 { margin:0; font-size:14px }
.engine-model-config>p { font-size:12px; color:var(--text-soft); margin:8px 0 18px; line-height:1.6 }
.engine-model-config :deep(.field-grid) { grid-template-columns:1fr }
.engine-inheritance { padding:24px; margin-top:24px }
.engine-inheritance h2 { font-size:16px; margin:0 }
.engine-inheritance p { font-size:13px; color:var(--text-soft); line-height:1.7 }
.engine-inheritance ol { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; list-style:none; padding:0; margin:20px 0 }
.engine-inheritance li { padding:14px; border:1px solid var(--border); border-radius:10px; font-size:12px }
.engine-inheritance li span { display:block; margin-bottom:10px; color:var(--text-soft); font-variant-numeric:tabular-nums }
.engine-inheritance li strong,.engine-inheritance li small { display:block; line-height:1.6 }
.engine-inheritance li small { color:var(--text-soft) }
.engine-fallback { border-top:1px solid var(--border); padding-top:20px; display:flex; align-items:flex-start; gap:10px; cursor:pointer; font-size:13px }
.engine-fallback input { margin-top:4px; width:18px; height:18px }
.engine-fallback small { display:block; margin-top:6px; font-size:12px; color:var(--text-soft); line-height:1.6 }
.engine-save-bar { display:flex; justify-content:space-between; align-items:center; gap:20px; padding:20px 0 28px }
.engine-save-bar p { font-size:13px; line-height:1.6; margin:0; color:var(--text-soft) }
.engine-save-bar .engine-saved { display:flex; align-items:center; gap:7px; color:var(--green) }
.engine-save-bar .engine-save-error { color:var(--red,var(--text)) }
@media(max-width:900px) { .engine-card-grid { grid-template-columns:1fr } .engine-overview-model { display:none } }
@media(max-width:480px) { .engine-card,.engine-overview,.engine-inheritance { padding:18px } .engine-inheritance ol { grid-template-columns:1fr 1fr } .engine-save-bar { align-items:stretch; flex-direction:column } }
</style>
