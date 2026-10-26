<script setup lang="ts">
import { scheduleLabel } from '../scheduled'
import type { ScheduledTaskInput, Workspace } from '../types'
defineProps<{ form: ScheduledTaskInput; workspace: Workspace | undefined; inheritedModel: string; isSync: boolean }>()
</script>
<template>
<section class="panel">
                <div class="panel-header"><h2>检查并保存</h2></div>
                <div class="scheduler-form-body">
                  <h2>{{ form.name }}</h2>
                  <p class="scheduler-hint">
                    {{ workspace?.name }} · {{ form.runtimeKind }} ·
                    {{ form.mode === 'maintenance' ? '维护与工具执行' : '只读分析' }}
                  </p>
                  <pre class="scheduler-prompt">{{ form.prompt }}</pre>
                  <dl class="scheduler-definition">
                    <div>
                      <dt>执行计划</dt>
                      <dd>{{ scheduleLabel(form.schedule) }} · {{ form.schedule.timezone }}</dd>
                    </div>
                    <div>
                      <dt>模型</dt>
                      <dd>
                        {{ form.model || inheritedModel || '引擎账户默认' }} ·
                        {{ form.reasoningEffort || '默认推理强度' }}
                      </dd>
                    </div>
                    <div>
                      <dt>结果输出</dt>
                      <dd>{{ form.output.botId ? '平台记录，并发送到 ' + form.output.chatId : '仅保存在平台' }}</dd>
                    </div>
                    <div v-if="isSync">
                      <dt>同步范围</dt>
                      <dd>主仓库 + {{ form.sync.submodules.length }} 个子模块</dd>
                    </div>
                    <div v-if="isSync">
                      <dt>本机保留</dt>
                      <dd>
                        {{ (form.sync.preserveLocalFiles || []).join('、') || '无；任何已跟踪本地修改都会阻止更新' }}
                      </dd>
                    </div>
                    <div>
                      <dt>配置生效</dt>
                      <dd>本次保存只影响后续执行；当前运行使用原配置快照。</dd>
                    </div>
                  </dl>
                  <label class="check-card"
                    ><input v-model="form.enabled" type="checkbox" /><span
                      >保存后启用自动执行<small>默认保持暂停，可以先手动执行一次。</small></span
                    ></label
                  >
                </div>
              </section>
</template>
