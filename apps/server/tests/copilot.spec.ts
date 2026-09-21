import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CopilotService } from '../src/copilot.js'
import { HubStore } from '../src/db.js'
import type { CodyBotRuntime } from '../src/runtime.js'

describe('CopilotService', () => {
  it('keeps generated scripts as reviewable drafts until an administrator applies them', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'codybothub-copilot-'))
    const store = new HubStore(':memory:')
    const account = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    const workspace = store.createWorkspace({ name: 'Copilot', path: directory })
    const runtime = { resetCopilotSession: () => undefined } as unknown as CodyBotRuntime
    const service = new CopilotService(store, runtime)
    const session = service.session(account.id, workspace.id).session

    const result = await service.invokeTool({
      tool: 'propose_managed_script', sessionId: session.id, accountId: account.id, workspaceId: workspace.id,
      arguments: { name: 'Lookup budget', description: 'Read-only lookup', language: 'python', scriptContent: 'print("ok")', argumentsTemplate: ['{{budgetId}}'], inputSchema: { type: 'object', required: ['budgetId'] }, timeoutSeconds: 30 },
    })
    expect(store.listTools()).toHaveLength(0)
    const draft = store.getCopilotProposal(String(result.proposalId), account.id)
    expect(draft).toMatchObject({ status: 'draft', kind: 'managed_script', payload: { name: 'Lookup budget' } })

    const applied = service.applyProposal(draft.id, account)
    expect(applied.proposal.status).toBe('applied')
    expect(applied.target).toMatchObject({ type: 'tool', name: 'Lookup budget' })
    const tool = store.listTools()[0]!
    expect(tool).toMatchObject({ id: applied.target.id, name: 'Lookup budget', scriptLanguage: 'python', scriptVersion: 1 })
    const source = path.join(directory, '.codybothub', 'tools', tool.id, 'main.py')
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(source, 'utf8')).toBe('print("ok")')
    expect(() => service.applyProposal(draft.id, account)).toThrow('already applied')
    store.close(); rmSync(directory, { recursive: true, force: true })
  })

  it('turns Bot operator changes into explicit proposals before updating configuration', async () => {
    const store = new HubStore(':memory:')
    const account = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    const workspace = store.createWorkspace({ name: 'Copilot', path: '/tmp/copilot-operator' })
    const bot = store.createBot({ name: 'Budget Bot', defaultWorkspaceId: workspace.id, operatorIds: ['ou_existing'] })
    const service = new CopilotService(store, { resetCopilotSession: () => undefined } as unknown as CodyBotRuntime)
    const session = service.session(account.id, workspace.id).session

    const result = await service.invokeTool({
      tool: 'propose_bot_operator', sessionId: session.id, accountId: account.id, workspaceId: workspace.id,
      arguments: { botId: bot.id, openId: 'ou_123abc', personName: '勾超', action: 'add' },
    })
    expect(store.listBots().find(item => item.id === bot.id)?.operatorIds).toEqual(['ou_existing'])
    const draft = store.getCopilotProposal(String(result.proposalId), account.id)
    expect(draft).toMatchObject({ kind: 'bot_operator', status: 'draft', payload: { botId: bot.id, openId: 'ou_123abc', action: 'add' } })

    const applied = service.applyProposal(draft.id, account)
    expect(applied.target).toEqual({ type: 'bot', id: bot.id, name: bot.name })
    expect(store.listBots().find(item => item.id === bot.id)?.operatorIds).toEqual(['ou_123abc', 'ou_existing'])
    expect(applied.proposal.result).toMatchObject({ action: 'add', openId: 'ou_123abc' })
    store.close()
  })

  it('persists Copilot messages and resets its Codex thread', () => {
    const store = new HubStore(':memory:')
    const account = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    const workspace = store.createWorkspace({ name: 'Copilot', path: '/tmp' })
    let resetId = ''
    const service = new CopilotService(store, { resetCopilotSession: id => { resetId = id } } as unknown as CodyBotRuntime)
    const session = service.session(account.id, workspace.id).session
    store.addCopilotMessage(session.id, 'user', 'hello')
    store.setCopilotCoreThread(session.id, 'thread-1')
    expect(service.session(account.id, workspace.id)).toMatchObject({ session: { coreThreadId: 'thread-1' }, messages: [{ content: 'hello' }] })
    expect(service.reset(session.id, account.id)).toMatchObject({ session: { coreThreadId: '' }, messages: [], proposals: [] })
    expect(resetId).toBe(session.id)
    store.close()
  })
})
