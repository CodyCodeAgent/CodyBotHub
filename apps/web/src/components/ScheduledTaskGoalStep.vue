<script setup lang="ts">
import { GitBranch, RefreshCw } from 'lucide-vue-next'
import ModelConfigFields from './ModelConfigFields.vue'
import type { ScheduledSubmoduleOption } from '../scheduled-editor'
import type { ModelCatalog, ScheduledTaskInput, SkillPackage, SkillSource, ToolPackage, Workspace, WorkspaceRepository } from '../types'
defineProps<{
  form: ScheduledTaskInput
  workspaces: Workspace[]
  workspace: Workspace | undefined
  catalog: ModelCatalog
  inheritedModel: string
  eligiblePackages: SkillPackage[]
  eligibleTools: ToolPackage[]
  eligibleSources: SkillSource[]
  isSync: boolean
  checking: boolean
  repository: WorkspaceRepository | null
  moduleOptions: Array<ScheduledSubmoduleOption & { initialized: boolean; commit: string }>
}>()
const skillRoots = defineModel<string>('skillRoots', { required: true })
const preserveLocalFiles = defineModel<string>('preserveLocalFiles', { required: true })
const emit = defineEmits<{ inspect: []; changeWorkspace: [] }>()
const inspect = () => emit('inspect')
const changeWorkspace = () => emit('changeWorkspace')
</script>
<template>
<section class="panel">
                <div class="panel-header"><h2>告诉 AI 要做什么</h2></div>
                <div class="scheduler-form-body">
                  <div class="field">
                    <label for="task-name">任务名称 *</label
                    ><input
                      id="task-name"
                      v-model.trim="form.name"
                      maxlength="120"
                      required
                      placeholder="例如：AI Hub 资源同步"
                    />
                  </div>
                  <div class="field">
                    <label for="task-description">用途说明</label
                    ><input
                      id="task-description"
                      v-model="form.description"
                      maxlength="2000"
                      placeholder="便于列表中快速看懂这个任务"
                    />
                  </div>
                  <div class="field-grid">
                    <div class="field">
                      <label for="task-workspace">工作区 *</label
                      ><select id="task-workspace" v-model="form.workspaceId" @change="changeWorkspace">
                        <option value="" disabled>请选择</option>
                        <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option></select
                      ><small>{{ workspace?.path }} · 不需要绑定 Bot 或场景。</small>
                    </div>
                    <div class="field">
                      <label for="task-engine">AI 引擎</label
                      ><select id="task-engine" v-model="form.runtimeKind">
                        <option value="codex">Codex</option>
                        <option value="traex">TraeX</option>
                      </select>
                    </div>
                  </div>
                  <ModelConfigFields
                    :catalog="catalog"
                    v-model:model="form.model"
                    v-model:reasoning-effort="form.reasoningEffort"
                    inherit-label="继承平台默认模型"
                    :inherited-model="inheritedModel"
                  />
                  <div class="field">
                    <label for="task-prompt">任务 Prompt *</label
                    ><textarea
                      id="task-prompt"
                      v-model="form.prompt"
                      rows="10"
                      required
                      placeholder="目标、信息来源、操作边界、完成标准和输出要求…"
                    /><small v-pre
                      >支持 {{ current_time }}、{{ last_success_at }}、{{ last_result_summary }}、{{
                        run_id
                      }}。其他占位文本保持原样。</small
                    >
                  </div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-header"><h2>任务可以使用的能力</h2></div>
                <div class="scheduler-form-body">
                  <div class="field">
                    <label for="task-mode">能力模式</label
                    ><select id="task-mode" v-model="form.mode">
                      <option value="read_only">只读分析</option>
                      <option value="maintenance">维护与工具执行</option></select
                    ><small>AI 原生沙箱为只读；受管同步和授权工具包通过平台工具执行。</small>
                  </div>
                  <div class="field">
                    <span class="field-label">技能包</span>
                    <div class="check-grid">
                      <label v-for="p in eligiblePackages" :key="p.id" class="check-card"
                        ><input v-model="form.skillPackageIds" type="checkbox" :value="p.id" /><span>{{
                          p.name
                        }}</span></label
                      >
                    </div>
                    <small v-if="!eligiblePackages.length">当前工作区没有技能包，仍可使用原生工作区技能与知识。</small>
                  </div>
                  <div v-if="form.mode === 'maintenance'" class="field">
                    <span class="field-label">允许申请或执行的工具包</span>
                    <div class="check-grid">
                      <label v-for="t in eligibleTools" :key="t.id" class="check-card"
                        ><input v-model="form.toolPackageIds" type="checkbox" :value="t.id" /><span
                          >{{ t.name }}
                          <small>{{ t.approvalRequired ? '需要人工确认' : '按配置自动执行' }}</small></span
                        ></label
                      >
                    </div>
                    <small>只有明确选中的工具包可以调用，原审批人和配置规则继续生效。</small>
                  </div>
                </div>
              </section>
              <section v-if="isSync || form.mode === 'maintenance'" class="panel">
                <div class="panel-header">
                  <h2><GitBranch :size="17" />工作区资源同步</h2>
                  <button
                    class="ghost-button compact"
                    type="button"
                    :disabled="checking || !form.workspaceId"
                    @click="inspect"
                  >
                    <RefreshCw :size="14" />{{ checking ? '检查中…' : '识别仓库' }}
                  </button>
                </div>
                <div class="scheduler-form-body">
                  <p class="scheduler-hint">
                    这些配置只在 AI 调用受管同步工具时生效。工作区本地修改会被保留，不自动清理。
                  </p>
                  <div v-if="repository" class="notice">
                    当前分支：{{ repository.branch || '游离 HEAD' }} · {{ repository.commit.slice(0, 12) }}<br />{{
                      repository.changes
                        ? '存在本地修改：保留清单内维持本机版本，清单外需先处理'
                        : '当前未检测到主仓库文件修改'
                    }}
                  </div>
                  <div class="field">
                    <label for="sync-branch">主仓库跟踪分支</label
                    ><input id="sync-branch" v-model.trim="form.sync.branch" placeholder="master / main" />
                  </div>
                  <div class="field">
                    <label for="preserve-local-files">本机保留文件（每行一个精确相对路径）</label>
                    <textarea
                      id="preserve-local-files"
                      v-model="preserveLocalFiles"
                      rows="3"
                      placeholder=".codex/config.toml"
                    />
                    <small
                      >仅支持主仓库已跟踪的普通文件；不支持目录、通配符、符号链接或暂存改动。这些文件保留本机完整内容，远端修改只记录，不合并；其他代码修改仍会阻止同步。Prompt
                      可在清单内选择，不能扩展范围。</small
                    >
                  </div>
                  <p v-if="moduleOptions.length && !moduleOptions.some((m) => m.selected)" class="scheduler-hint">
                    尚未选择子模块：此次只更新主仓库，不会更新子模块中的知识库和服务代码。
                  </p>
                  <details v-if="moduleOptions.length">
                    <summary>
                      选择子模块与更新策略（已选 {{ moduleOptions.filter((m) => m.selected).length }} /
                      {{ moduleOptions.length }}）
                    </summary>
                    <div class="actions scheduler-module-actions">
                      <button
                        class="ghost-button compact"
                        type="button"
                        @click="moduleOptions.forEach((m) => (m.selected = m.initialized))"
                      >
                        选择已初始化服务</button
                      ><button
                        class="ghost-button compact"
                        type="button"
                        @click="moduleOptions.forEach((m) => (m.selected = false))"
                      >
                        清空选择
                      </button>
                    </div>
                    <div class="scheduler-module-list">
                      <div v-for="m in moduleOptions" :key="m.path" class="scheduler-module">
                        <label class="check-card"
                          ><input v-model="m.selected" type="checkbox" :disabled="!m.initialized" /><span
                            >{{ m.path
                            }}<small>{{ m.initialized ? m.commit.slice(0, 10) : '未初始化，保留现状' }}</small></span
                          ></label
                        >
                        <div v-if="m.selected" class="field-grid">
                          <label
                            >更新方式<select v-model="m.mode">
                              <option value="pinned">跟随主仓库提交</option>
                              <option value="branch">指定分支最新版本</option>
                              <option value="merge">合并远端，保留本地提交</option>
                            </select></label
                          ><label v-if="m.mode !== 'pinned'"
                            >目标分支<input v-model.trim="m.branch" placeholder="请填写实际分支" /></label
                          ><label class="check-card"
                            ><input v-model="m.required" type="checkbox" /><span>必选项，失败则停止应用</span></label
                          >
                        </div>
                        <small v-if="m.selected && m.mode === 'merge'"
                          >只自动应用无冲突的合并，不推送远端；有冲突则保留现状，按必选/可选策略报告。</small
                        >
                      </div>
                    </div>
                  </details>
                  <label class="check-card"
                    ><input v-model="form.sync.installSkills" type="checkbox" /><span
                      >扫描并自动安装、更新技能<small>按内容比较，保留虚拟环境、本地配置与认证文件。</small></span
                    ></label
                  >
                  <div v-if="form.sync.installSkills" class="field">
                    <label for="skill-roots">技能扫描目录（每行一个相对路径）</label
                    ><textarea id="skill-roots" v-model="skillRoots" rows="3" />
                  </div>
                  <details v-if="eligibleSources.length">
                    <summary>额外同步平台配置的独立技能源</summary>
                    <label v-for="source in eligibleSources" :key="source.id" class="check-card"
                      ><input v-model="form.sync.sourceIds" type="checkbox" :value="source.id" /><span
                        >{{ source.name }}<small>{{ source.branch }} · 沿用该来源的安装及知识库配置</small></span
                      ></label
                    >
                  </details>
                </div>
              </section>
</template>
