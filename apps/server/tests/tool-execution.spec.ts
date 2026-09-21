import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HubStore } from '../src/db.js'
import { ToolPackageRunner, type ToolStepResult } from '../src/tool-execution.js'

const nodeTool = (store: HubStore, workspaceId: string, name: string, script: string) => store.createTool({
  workspaceId,
  name,
  description: '',
  executorType: 'command',
  command: process.execPath,
  argumentsTemplate: ['-e', script, '{{target}}'],
  inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } },
  timeoutSeconds: 5,
  enabled: true,
})

describe('ToolPackageRunner', () => {
  it('executes a platform-managed script and materializes its source in the Workspace', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'codybothub-script-'))
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Managed script', path: directory })
    const tool = store.createTool({
      workspaceId: workspace.id, name: 'Managed node', description: '', executorType: 'command', command: '',
      argumentsTemplate: ['{{target}}'], inputSchema: { type: 'object', required: ['target'] },
      scriptLanguage: 'node', scriptContent: 'process.stdout.write(`managed:${process.argv.at(-1)}`)', timeoutSeconds: 5, enabled: true,
    })
    const result = await new ToolPackageRunner(store).runTool(tool, { target: 'value' }, directory)
    expect(result.stdout).toBe('managed:value')
    expect(readFileSync(path.join(directory, '.codybothub', 'tools', tool.id, 'main.js'), 'utf8')).toContain('managed:')
    store.close(); rmSync(directory, { recursive: true, force: true })
  })

  it('builds a native Bits RPC request from structured configuration', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Native RPC', path: '/tmp' })
    const tool = store.createTool({
      workspaceId: workspace.id, name: 'EnsureBudget', description: '', executorType: 'bits_rpc', command: '/bin/echo', argumentsTemplate: [],
      inputSchema: { type: 'object', required: ['budgetBindId', 'bindIdType'] },
      rpcConfig: { service: 'life.marketing.budget_c', method: 'EnsureBudget', vregion: 'China-North', environment: 'prod', cluster: 'default', requestTemplate: { AccountIdentity: { BudgetBindID: '{{budgetBindId}}', BindIDType: '{{bindIdType}}' } } },
      timeoutSeconds: 5, enabled: true,
    })
    const result = await new ToolPackageRunner(store).runTool(tool, { budgetBindId: '123', bindIdType: 2 }, '/tmp')
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as { psm: string; func_name: string; request: string }
    expect(payload).toMatchObject({ psm: 'life.marketing.budget_c', func_name: 'EnsureBudget' })
    expect(JSON.parse(payload.request)).toEqual({ AccountIdentity: { BudgetBindID: '123', BindIDType: 2 } })
    store.close()
  })

  it('versions managed script content when it changes', () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Versions', path: '/tmp' })
    const created = store.createTool({ workspaceId: workspace.id, name: 'Versioned', description: '', executorType: 'command', command: '', argumentsTemplate: [], inputSchema: {}, scriptLanguage: 'python', scriptContent: 'print(1)', timeoutSeconds: 5, enabled: true })
    const updated = store.updateTool(created.id, { ...created, scriptContent: 'print(2)' })
    expect(updated.scriptVersion).toBe(2)
    expect(store.listToolScriptVersions(created.id).map(item => item.content)).toEqual(['print(2)', 'print(1)'])
    store.close()
  })

  it('keeps administrator-fixed step arguments authoritative over model input', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Tools', path: '/tmp' })
    const tool = nodeTool(store, workspace.id, 'Fixed argument', 'process.stdout.write(process.argv.at(-1))')
    const pack = store.createToolPackage({
      workspaceId: workspace.id,
      name: 'Fixed workflow',
      description: '', prompt: '', approvalRequired: false, approverIds: [], cardTitle: '', cardDescription: '', enabled: true,
      steps: [{ toolId: tool.id, toolName: tool.name, phase: 'execute', position: 0, arguments: { target: 'administrator-value' } }],
    })

    const result = await new ToolPackageRunner(store).run(pack, { target: 'model-value' }, '/tmp')
    expect(result[0]?.stdout).toBe('administrator-value')
    store.close()
  })

  it('retains successful step results when a later step fails', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Partial results', path: '/tmp' })
    const first = nodeTool(store, workspace.id, 'Precheck', 'process.stdout.write(process.argv.at(-1))')
    const second = nodeTool(store, workspace.id, 'Failing execute', 'process.stderr.write(process.argv.at(-1)); process.exit(2)')
    const pack = store.createToolPackage({
      workspaceId: workspace.id,
      name: 'Partial workflow',
      description: '', prompt: '', approvalRequired: false, approverIds: [], cardTitle: '', cardDescription: '', enabled: true,
      steps: [
        { toolId: first.id, toolName: first.name, phase: 'precheck', position: 0, arguments: {} },
        { toolId: second.id, toolName: second.name, phase: 'execute', position: 1, arguments: {} },
      ],
    })

    try {
      await new ToolPackageRunner(store).run(pack, { target: 'evidence' }, '/tmp')
      throw new Error('Expected the second step to fail')
    } catch (error) {
      const partial = error && typeof error === 'object' && 'partialResults' in error ? error.partialResults as ToolStepResult[] : []
      expect(partial).toHaveLength(1)
      expect(partial[0]).toMatchObject({ toolId: first.id, phase: 'precheck', stdout: 'evidence' })
    }
    store.close()
  })
})
