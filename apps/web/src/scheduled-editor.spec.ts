import { describe, expect, it } from 'vitest'
import {
  applySyncDraft,
  createScheduledTaskInput,
  validateDeliveryStep,
  validateTaskStep
} from './scheduled-editor'

describe('scheduled task editor state', () => {
  it('creates isolated default form values', () => {
    const first = createScheduledTaskInput()
    const second = createScheduledTaskInput()
    first.schedule.weekdays.push(2)
    first.sync.skillRoots.push('custom')
    expect(second.schedule.weekdays).toEqual([1])
    expect(second.sync.skillRoots).toEqual(['skills', '.agents/skills'])
  })

  it('normalizes multiline sync settings and selected submodules', () => {
    const form = createScheduledTaskInput()
    applySyncDraft(
      form,
      ' skills\n\n.agents/skills\nskills ',
      ' config/local.toml\nconfig/local.toml\n ',
      [
        { path: 'services/api', selected: true, mode: 'branch', branch: 'main', required: true },
        { path: 'services/docs', selected: false, mode: 'pinned', branch: '', required: false }
      ]
    )
    expect(form.sync.skillRoots).toEqual(['skills', '.agents/skills'])
    expect(form.sync.preserveLocalFiles).toEqual(['config/local.toml'])
    expect(form.sync.submodules).toEqual([
      { path: 'services/api', mode: 'branch', branch: 'main', required: true }
    ])
  })

  it('validates required task identity without mutating the form', () => {
    const form = createScheduledTaskInput()
    expect(validateTaskStep(form)).toBe('请填写任务名称、工作区与 Prompt。')
    Object.assign(form, { name: 'Daily check', workspaceId: 'workspace-1', prompt: 'Inspect health' })
    expect(validateTaskStep(form)).toBe('')
  })

  it('requires complete delivery settings and an approval destination', () => {
    const form = createScheduledTaskInput()
    form.output.botId = 'bot-1'
    expect(validateDeliveryStep(form, [])).toBe('发送 Bot 和接收群需要同时配置。')
    form.output.chatId = 'chat-1'
    expect(validateDeliveryStep(form, [])).toBe('')
    form.output = { botId: '', chatId: '', when: 'always' }
    form.toolPackageIds = ['tool-1']
    expect(validateDeliveryStep(form, [{ id: 'tool-1', approvalRequired: true }])).toBe(
      '所选工具包需要人工审批，请设置发送 Bot 与接收群。'
    )
  })
})
