import { describe, expect, it } from 'vitest'
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
