<script setup lang="ts">
import { Code2, History, Network, Pencil, Plus, Terminal, Trash2, Wrench, X } from 'lucide-vue-next'
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import PaginationBar from '../components/PaginationBar.vue'
import type { Tool, ToolScriptVersion, Workspace } from '../types'

type ToolKind = 'bits_rpc' | 'script' | 'command'
type ToolForm = {
  id: string; workspaceId: string; name: string; description: string; kind: ToolKind; command: string
  argumentsText: string; schemaText: string; timeoutSeconds: number; enabled: boolean
  rpcService: string; rpcMethod: string; rpcVregion: string; rpcEnvironment: string; rpcCluster: string; rpcRequestText: string
  scriptLanguage: 'python'|'shell'|'node'; scriptContent: string
}

const pageSize = 20
const items = ref<Tool[]>([]), workspaces = ref<Workspace[]>([]), versions = ref<ToolScriptVersion[]>([])
const total = ref(0), offset = ref(0), loading = ref(false), open = ref(false), saving = ref(false), error = ref('')
const defaultSchema = '{\n  "type": "object",\n  "additionalProperties": false,\n  "properties": {}\n}'
const defaultRequest = '{\n  "Base": {\n    "Extra": { "env": "prod" }\n  }\n}'
const empty = (): ToolForm => ({
  id: '', workspaceId: workspaces.value[0]?.id ?? '', name: '', description: '', kind: 'bits_rpc', command: 'gdpa-cli',
  argumentsText: '', schemaText: defaultSchema, timeoutSeconds: 60, enabled: true,
  rpcService: '', rpcMethod: '', rpcVregion: 'China-North', rpcEnvironment: 'prod', rpcCluster: 'default', rpcRequestText: defaultRequest,
  scriptLanguage: 'python', scriptContent: '# 输入参数通过 argv 传入；请把业务结果写到 stdout。\nimport json\nimport sys\n\nprint(json.dumps({"ok": True, "args": sys.argv[1:]}, ensure_ascii=False))\n',
})
const form = reactive<ToolForm>(empty())

const load = async () => {
  loading.value = true
  try {
    const [page, spaces] = await Promise.all([api.toolsPage(pageSize, offset.value), api.workspaces()])
    items.value = page.items; total.value = page.total; workspaces.value = spaces
  } finally { loading.value = false }
}
onMounted(load)

const toolKind = (item: Tool): ToolKind => item.scriptContent ? 'script' : item.executorType
const kindLabel = (item: Tool) => toolKind(item) === 'bits_rpc' ? 'Bits RPC' : toolKind(item) === 'script' ? '托管脚本' : '本地命令'
const kindSummary = (item: Tool) => toolKind(item) === 'bits_rpc'
  ? `${item.rpcConfig.service || '未配置服务'}.${item.rpcConfig.method || '未配置方法'}`
  : toolKind(item) === 'script' ? `${item.scriptLanguage} · v${item.scriptVersion}` : `${item.command} ${item.argumentsTemplate.slice(0, 2).join(' ')}`

const edit = async (item?: Tool) => {
  error.value = ''; versions.value = []
  if (!item) Object.assign(form, empty())
  else {
    Object.assign(form, {
      id: item.id, workspaceId: item.workspaceId, name: item.name, description: item.description, kind: toolKind(item), command: item.command || 'gdpa-cli',
      argumentsText: item.argumentsTemplate.join('\n'), schemaText: JSON.stringify(item.inputSchema, null, 2), timeoutSeconds: item.timeoutSeconds, enabled: item.enabled,
      rpcService: item.rpcConfig.service || '', rpcMethod: item.rpcConfig.method || '', rpcVregion: item.rpcConfig.vregion || 'China-North',
      rpcEnvironment: item.rpcConfig.environment || 'prod', rpcCluster: item.rpcConfig.cluster || 'default', rpcRequestText: JSON.stringify(item.rpcConfig.requestTemplate || {}, null, 2),
      scriptLanguage: item.scriptLanguage || 'python', scriptContent: item.scriptContent || empty().scriptContent,
    })
    if (item.scriptContent) versions.value = await api.toolScriptVersions(item.id)
  }
  open.value = true
}

const save = async () => {
  saving.value = true; error.value = ''
  try {
    const inputSchema = JSON.parse(form.schemaText || '{}') as Record<string, unknown>
    const requestTemplate = form.kind === 'bits_rpc' ? JSON.parse(form.rpcRequestText || '{}') as Record<string, unknown> : {}
    await api.saveTool({
      ...(form.id ? { id: form.id } : {}), workspaceId: form.workspaceId, name: form.name, description: form.description,
      executorType: form.kind, command: form.kind === 'bits_rpc' ? (form.command || 'gdpa-cli') : form.kind === 'command' ? form.command : '',
      argumentsTemplate: form.argumentsText.split('\n').map(value => value.trim()).filter(Boolean), inputSchema,
      rpcConfig: { service: form.rpcService, method: form.rpcMethod, vregion: form.rpcVregion, environment: form.rpcEnvironment, cluster: form.rpcCluster, requestTemplate },
      scriptLanguage: form.scriptLanguage, scriptContent: form.kind === 'script' ? form.scriptContent : '', timeoutSeconds: form.timeoutSeconds, enabled: form.enabled,
    })
    open.value = false; await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { saving.value = false }
}
const remove = async (item: Tool) => { if (!confirm(`删除工具“${item.name}”？`)) return; try { await api.deleteTool(item.id); await load() } catch (cause) { alert(cause instanceof Error ? cause.message : '删除失败') } }
const workspaceName = (id: string) => workspaces.value.find(item => item.id === id)?.name ?? '未知工作区'
</script>

<template><div class="page tools-page">
  <header class="page-header"><div><p class="eyebrow">Atomic operations</p><h1>工具</h1><p class="page-description">用结构化接口、平台托管脚本或本地命令定义可审计的原子能力，再交给工具包编排审批与执行顺序。</p></div><button class="button" :disabled="!workspaces.length" @click="edit()"><Plus :size="17" />注册工具</button></header>
  <section class="tool-kind-intro"><article><Network :size="20"/><div><strong>原生 Bits RPC</strong><span>直接配置 PSM、方法和请求模板，无需包装脚本。</span></div></article><article><Code2 :size="20"/><div><strong>平台托管脚本</strong><span>在页面编辑 Python、Shell 或 Node.js，自动保存版本。</span></div></article><article><Terminal :size="20"/><div><strong>本地命令</strong><span>保留高级入口，以 argv 数组执行，不经过 Shell 拼接。</span></div></article></section>
  <section class="panel"><div class="panel-header"><h2>工具注册表</h2><span class="badge gray">{{ total }} 个</span></div><div v-if="!loading&&!items.length" class="empty"><Wrench :size="32"/><strong>还没有工具</strong><span>先注册原子能力，再组合成带审批和审计的工具包。</span></div><div v-else class="table-wrap"><table><thead><tr><th>名称</th><th>工作区</th><th>类型</th><th>执行目标</th><th>状态</th><th /></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><div class="entity-title">{{ item.name }}</div><div class="entity-subtitle">{{ item.description||'暂无描述' }}</div></td><td><span class="badge">{{ workspaceName(item.workspaceId) }}</span></td><td><span class="badge gray">{{ kindLabel(item) }}</span></td><td><code>{{ kindSummary(item) }}</code></td><td><span class="badge" :class="{gray:!item.enabled}">{{item.enabled?'启用':'停用'}}</span></td><td><div class="actions"><button class="ghost-button" @click="edit(item)"><Pencil :size="15"/>编辑</button><button class="danger-button" @click="remove(item)"><Trash2 :size="15"/></button></div></td></tr></tbody></table></div><PaginationBar :total="total" :offset="offset" :page-size="pageSize" :loading="loading" @change="value=>{offset=value;load()}"/></section>

  <div v-if="open" class="dialog-backdrop" @mousedown.self="open=false"><form class="dialog large" @submit.prevent="save"><header class="dialog-header"><div><h2>{{ form.id?'编辑工具':'注册工具' }}</h2><p>执行类型决定平台如何保存和运行这个原子能力。</p></div><button type="button" class="icon-button" @click="open=false"><X :size="19"/></button></header><div class="dialog-body">
    <div class="field-grid"><div class="field"><label>名称</label><input v-model.trim="form.name" required placeholder="例如：预算单重保"/></div><div class="field"><label>工作区</label><select v-model="form.workspaceId" required><option v-for="space in workspaces" :key="space.id" :value="space.id">{{space.name}}</option></select></div></div>
    <div class="field"><label>描述</label><input v-model.trim="form.description" placeholder="这个工具做什么、何时使用"/></div>
    <div class="executor-picker"><label :class="{active:form.kind==='bits_rpc'}"><input v-model="form.kind" type="radio" value="bits_rpc"/><Network :size="18"/><span><strong>Bits RPC</strong><small>结构化配置</small></span></label><label :class="{active:form.kind==='script'}"><input v-model="form.kind" type="radio" value="script"/><Code2 :size="18"/><span><strong>托管脚本</strong><small>在线编辑与版本</small></span></label><label :class="{active:form.kind==='command'}"><input v-model="form.kind" type="radio" value="command"/><Terminal :size="18"/><span><strong>本地命令</strong><small>高级 argv 模式</small></span></label></div>

    <template v-if="form.kind==='bits_rpc'">
      <div class="field-grid"><div class="field"><label>PSM / Service</label><input v-model.trim="form.rpcService" required class="mono" placeholder="life.marketing.budget_c"/></div><div class="field"><label>方法</label><input v-model.trim="form.rpcMethod" required class="mono" placeholder="EnsureBudget"/></div></div>
      <div class="field-grid rpc-grid"><div class="field"><label>VRegion</label><input v-model.trim="form.rpcVregion" class="mono" placeholder="China-North"/></div><div class="field"><label>环境</label><input v-model.trim="form.rpcEnvironment" class="mono" placeholder="prod"/></div><div class="field"><label>集群</label><input v-model.trim="form.rpcCluster" class="mono" placeholder="default"/></div></div>
      <div class="field"><label>请求 JSON 模板</label><textarea v-model="form.rpcRequestText" rows="13" required class="mono"/><small>用 <code v-text="'{{field}}'"/> 引用输入参数；整值占位会保留数字、布尔和对象类型。</small></div>
      <details class="advanced-config"><summary>高级运行配置</summary><div class="field"><label>RPC CLI</label><input v-model.trim="form.command" class="mono" placeholder="gdpa-cli"/></div></details>
    </template>

    <template v-else-if="form.kind==='script'">
      <div class="field-grid"><div class="field"><label>语言</label><select v-model="form.scriptLanguage"><option value="python">Python 3</option><option value="shell">Shell</option><option value="node">Node.js</option></select></div><div class="field"><label>当前版本</label><div class="readonly-value">{{form.id ? `v${versions[0]?.version||1}` : '保存后生成 v1'}}</div></div></div>
      <div class="field"><label>脚本内容</label><textarea v-model="form.scriptContent" rows="18" required class="mono code-editor" spellcheck="false"/><small>保存后由平台写入工作区 <code>.codybothub/tools/&lt;tool-id&gt;/</code>；每次内容变化都会保留新版本。</small></div>
      <div class="field"><label>脚本参数（每行一个 argv）</label><textarea v-model="form.argumentsText" rows="5" class="mono" placeholder="{{budgetBindId}}"/></div>
      <details v-if="versions.length" class="version-history"><summary><History :size="15"/>历史版本（{{versions.length}}）</summary><ol><li v-for="version in versions" :key="version.version"><strong>v{{version.version}}</strong><span>{{new Date(version.createdAt).toLocaleString()}}</span><small>{{version.language}}</small></li></ol></details>
    </template>

    <template v-else><div class="field"><label>可执行文件</label><input v-model.trim="form.command" required class="mono" placeholder="/usr/bin/example"/></div><div class="field"><label>参数模板（每行一个 argv）</label><textarea v-model="form.argumentsText" rows="8" required class="mono"/></div></template>

    <div class="field"><label>输入 JSON Schema</label><textarea v-model="form.schemaText" rows="10" class="mono"/></div>
    <div class="field-grid"><div class="field"><label>超时（秒）</label><input v-model.number="form.timeoutSeconds" type="number" min="1" max="900"/></div><label class="check-card"><input v-model="form.enabled" type="checkbox"/><span><strong>启用工具</strong><small>停用后关联工具包不能执行它。</small></span></label></div>
    <div v-if="error" class="error-banner">{{error}}</div>
  </div><footer class="dialog-actions"><button type="button" class="ghost-button" @click="open=false">取消</button><button class="button" :disabled="saving">{{saving?'保存中…':'保存工具'}}</button></footer></form></div>
</div></template>

<style scoped>
.tools-page{max-width:1440px}.tool-kind-intro{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}.tool-kind-intro article{display:flex;gap:12px;align-items:flex-start;padding:17px 18px;background:var(--surface);border:1px solid var(--border);border-radius:14px}.tool-kind-intro svg{color:var(--primary)}.tool-kind-intro strong,.tool-kind-intro span{display:block}.tool-kind-intro strong{font-size:12px}.tool-kind-intro span{margin-top:5px;color:var(--muted);font-size:10px;line-height:1.5}.executor-picker{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.executor-picker label{display:flex;align-items:center;gap:10px;padding:14px;color:var(--muted);background:var(--surface-raised);border:1px solid var(--border);border-radius:11px;cursor:pointer}.executor-picker label.active{color:var(--text);background:var(--primary-soft);border-color:var(--primary-border)}.executor-picker input{position:absolute;opacity:0}.executor-picker svg{color:var(--primary)}.executor-picker span,.executor-picker strong,.executor-picker small{display:block}.executor-picker strong{font-size:11px}.executor-picker small{margin-top:3px;color:var(--muted);font-size:9px}.rpc-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.readonly-value{height:42px;display:flex;align-items:center;padding:0 12px;color:var(--text-soft);background:var(--surface-raised);border:1px solid var(--border);border-radius:9px;font:600 11px ui-monospace,monospace}.code-editor{line-height:1.65;tab-size:2}.field>small{margin-top:7px;color:var(--muted);font-size:9px}.version-history{padding:13px 15px;background:var(--surface-raised);border:1px solid var(--border);border-radius:10px}.version-history summary{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;cursor:pointer}.version-history ol{margin:12px 0 0;padding:0;list-style:none}.version-history li{display:grid;grid-template-columns:50px 1fr auto;gap:10px;padding:8px 0;border-top:1px solid var(--border);font-size:10px}.version-history li span,.version-history li small{color:var(--muted)}@media(max-width:760px){.tool-kind-intro,.executor-picker,.rpc-grid{grid-template-columns:1fr}}
</style>
