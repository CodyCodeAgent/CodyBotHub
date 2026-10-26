<script setup lang="ts">
import type { Bot, ChatMetadata, ScheduledTaskInput } from '../types'
defineProps<{ form: ScheduledTaskInput; previewError: string; eligibleBots: Bot[]; eligibleChats: ChatMetadata[] }>()
</script>
<template>
<section class="panel">
                <div class="panel-header"><h2>什么时候执行</h2></div>
                <div class="scheduler-form-body">
                  <div class="field">
                    <label for="schedule-kind">周期类型</label
                    ><select id="schedule-kind" v-model="form.schedule.kind">
                      <option value="interval">按间隔</option>
                      <option value="daily">每天</option>
                      <option value="weekly">每周</option>
                      <option value="cron">自定义 Cron</option>
                    </select>
                  </div>
                  <div class="field-grid">
                    <div v-if="form.schedule.kind === 'interval'" class="field">
                      <label for="schedule-interval">间隔（分钟）</label
                      ><input
                        id="schedule-interval"
                        v-model.number="form.schedule.intervalMinutes"
                        type="number"
                        min="1"
                        max="525600"
                      />
                    </div>
                    <div v-else-if="form.schedule.kind !== 'cron'" class="field">
                      <label for="schedule-time">执行时间</label
                      ><input id="schedule-time" v-model="form.schedule.time" type="time" />
                    </div>
                    <div v-else class="field">
                      <label for="schedule-cron">5 段 Cron</label
                      ><input id="schedule-cron" v-model="form.schedule.cron" placeholder="0 9 * * 1-5" />
                    </div>
                    <div class="field">
                      <label for="schedule-timezone">时区</label
                      ><input id="schedule-timezone" v-model.trim="form.schedule.timezone" list="timezones" /><datalist
                        id="timezones"
                      >
                        <option>Asia/Shanghai</option>
                        <option>UTC</option>
                        <option>America/Los_Angeles</option>
                      </datalist>
                    </div>
                  </div>
                  <div v-if="form.schedule.kind === 'weekly'" class="check-grid">
                    <label v-for="(day, i) in ['日', '一', '二', '三', '四', '五', '六']" :key="i" class="check-card"
                      ><input v-model="form.schedule.weekdays" type="checkbox" :value="i" />周{{ day }}</label
                    >
                  </div>
                  <div v-if="previewError" class="error-banner" role="alert">{{ previewError }}</div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-header"><h2>结果与审批发送到哪里</h2></div>
                <div class="scheduler-form-body">
                  <div class="notice">最终报告始终保存到平台。需要发送群报告或审批卡片时，再配置下面的 Bot 和群。</div>
                  <div class="field-grid">
                    <div class="field">
                      <label for="output-bot">发送 Bot</label
                      ><select id="output-bot" v-model="form.output.botId">
                        <option value="">仅保存在平台</option>
                        <option v-for="bot in eligibleBots" :key="bot.id" :value="bot.id">{{ bot.name }}</option>
                      </select>
                    </div>
                    <div class="field">
                      <label for="output-chat">接收群 Chat ID</label
                      ><input
                        id="output-chat"
                        v-model.trim="form.output.chatId"
                        :disabled="!form.output.botId"
                        list="known-task-chats"
                        placeholder="选择已知群或输入 oc_…"
                      /><datalist id="known-task-chats">
                        <option v-for="chat in eligibleChats" :key="chat.chatId" :value="chat.chatId">
                          {{ chat.name || chat.chatId }}
                        </option>
                      </datalist>
                    </div>
                  </div>
                  <div v-if="form.output.botId" class="field">
                    <label for="output-when">报告通知策略</label
                    ><select id="output-when" v-model="form.output.when">
                      <option value="always">每次有最终结果都发送</option>
                      <option value="attention">仅失败、警告或中断时发送</option></select
                    ><small>工具包审批卡片独立发送；报告发送失败可单独重试，不重跑任务。</small>
                  </div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-header"><h2>执行策略</h2></div>
                <div class="scheduler-form-body">
                  <div class="field-grid">
                    <div class="field">
                      <label for="task-timeout">单次运行时限（分钟）</label
                      ><input id="task-timeout" v-model.number="form.timeoutMinutes" type="number" min="1" max="240" />
                    </div>
                    <div class="field">
                      <label for="task-overlap">上次未结束时</label
                      ><select id="task-overlap" v-model="form.overlap">
                        <option value="skip">跳过本次，并留记录</option>
                        <option value="merge">合并为一次待执行任务</option>
                      </select>
                    </div>
                  </div>
                  <details>
                    <summary>高级配置</summary>
                    <div class="field scheduler-advanced">
                      <label for="task-context">Thread 上下文</label
                      ><select id="task-context" v-model="form.contextMode">
                        <option value="fresh">每次新建 Thread，参考上次成功摘要</option>
                        <option value="reuse">复用该任务专属 Thread</option></select
                      ><small>任务线程独立于群会话，不会与机器人对话抢占绑定。审批结果续写本次任务 Thread。</small>
                    </div>
                    <p class="scheduler-hint">
                      进程中断后的未知副作用不会自动重试整轮；审批最长等待 6 小时，拒绝后本轮不重复申请。
                    </p>
                  </details>
                </div>
              </section>
</template>
