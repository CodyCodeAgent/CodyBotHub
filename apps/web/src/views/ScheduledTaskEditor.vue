<script setup lang="ts">
import { ArrowLeft, ArrowRight, Check, Clock3, Archive } from 'lucide-vue-next'
import ScheduledTaskGoalStep from '../components/ScheduledTaskGoalStep.vue'
import ScheduledTaskPlanStep from '../components/ScheduledTaskPlanStep.vue'
import ScheduledTaskReviewStep from '../components/ScheduledTaskReviewStep.vue'
import { formatTime } from '../scheduled'
import { useScheduledTaskEditor } from '../composables/useScheduledTaskEditor'
const { id, step, loading, saving, error, notice, dirty, workspaces, catalog, inheritedModel, dates, previewError, repository, checking, skillRoots, preserveLocalFiles, moduleOptions, form, workspace, eligiblePackages, eligibleTools, eligibleSources, eligibleBots, eligibleChats, isSync, editTitle, inspect, changeWorkspace, next, previousStep, save, archive } = useScheduledTaskEditor()
</script>
<template>
  <div class="page scheduler">
    <RouterLink class="scheduler-back" to="/scheduled-tasks"><ArrowLeft :size="15" />返回任务列表</RouterLink>
    <header class="page-header">
      <div>
        <p class="eyebrow">Configure an AI task</p>
        <h1>{{ editTitle }}</h1>
        <p class="page-description">目标、能力、执行计划分别配置。保存配置不会立即执行，启用后按计划触发。</p>
      </div>
      <button v-if="id" class="danger-button" @click="archive"><Archive :size="16" />归档任务</button>
    </header>
    <div v-if="loading" class="empty">正在加载工作区、能力与模型目录…</div>
    <template v-else
      ><div v-if="notice" class="notice" role="status">{{ notice }}</div>
      <div class="scheduler-steps">
        <span
          v-for="(label, i) in ['目标与能力', '计划与输出', '检查并保存']"
          :key="label"
          :class="{ active: step === i + 1 }"
          ><b>{{ i + 1 }}</b
          >{{ label }}</span
        >
      </div>
      <form @submit.prevent="step === 3 ? save() : next()">
        <div class="scheduler-editor-grid">
          <div class="scheduler-editor-main">
            <ScheduledTaskGoalStep v-if="step === 1" :form="form" :workspaces="workspaces" :workspace="workspace" :catalog="catalog" :inherited-model="inheritedModel" :eligible-packages="eligiblePackages" :eligible-tools="eligibleTools" :eligible-sources="eligibleSources" :is-sync="isSync" :checking="checking" :repository="repository" :module-options="moduleOptions" v-model:skill-roots="skillRoots" v-model:preserve-local-files="preserveLocalFiles" @inspect="inspect" @change-workspace="changeWorkspace" />
            <ScheduledTaskPlanStep v-else-if="step === 2" :form="form" :preview-error="previewError" :eligible-bots="eligibleBots" :eligible-chats="eligibleChats" />
            <ScheduledTaskReviewStep v-else :form="form" :workspace="workspace" :inherited-model="inheritedModel" :is-sync="isSync" />
            <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
          </div>
          <aside class="scheduler-preview">
            <section class="panel">
              <div class="panel-header">
                <h2><Clock3 :size="17" />任务预览</h2>
                <span class="badge gray">{{ dirty ? '未保存' : '配置草稿' }}</span>
              </div>
              <div class="scheduler-form-body">
                <h2>{{ form.name || '尚未命名' }}</h2>
                <dl class="scheduler-definition">
                  <div>
                    <dt>工作区</dt>
                    <dd>{{ workspace?.name || '请选择' }}</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>{{ form.model || inheritedModel || '引擎账户默认' }}</dd>
                  </div>
                  <div>
                    <dt>模式</dt>
                    <dd>{{ form.mode === 'maintenance' ? '维护与工具执行' : '只读分析' }}</dd>
                  </div>
                  <div>
                    <dt>Thread</dt>
                    <dd>{{ form.contextMode === 'fresh' ? '每次新建' : '任务专属，串行复用' }}</dd>
                  </div>
                </dl>
                <span class="field-label">未来三次执行预览</span>
                <div class="scheduler-next-dates">
                  <template v-if="dates.length"
                    ><div v-for="date in dates" :key="date">
                      {{ formatTime(date, form.schedule.timezone) }}
                    </div></template
                  ><span v-else>{{ previewError || '计算中…' }}</span
                  ><small>{{ form.schedule.timezone }} · 若未启用则不触发</small>
                </div>
                <p class="scheduler-hint">关闭页面不影响任务。停机错过的周期不批量补跑。</p>
              </div>
            </section>
          </aside>
        </div>
        <footer class="scheduler-form-footer">
          <span>步骤 {{ step }} / 3</span>
          <div class="actions">
            <RouterLink class="ghost-button" to="/scheduled-tasks">取消</RouterLink
            ><button v-if="step > 1" class="ghost-button" type="button" @click="previousStep">
              <ArrowLeft :size="15" />上一步</button
            ><button class="button" :disabled="saving">
              <component :is="step === 3 ? Check : ArrowRight" :size="16" />{{
                saving ? '保存中…' : step === 3 ? '保存任务' : '下一步'
              }}
            </button>
          </div>
        </footer>
      </form></template
    >
  </div>
</template>
