import { describe, expect, it } from 'vitest'
import { HubStore } from '../src/db.js'
import { ToolCatalogRepository } from '../src/persistence/tool-catalog-repository.js'

describe('ToolCatalogRepository', () => {
  it('owns tool, package and execution aggregates while HubStore keeps compatibility', () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Tools', path: '/tmp/tools-repository' })
    const tools = new ToolCatalogRepository(store.db, store.botScenes)
    const tool = tools.createTool({ workspaceId: workspace.id, name: 'Echo', description: '', executorType: 'command', command: 'printf', argumentsTemplate: [], inputSchema: {}, timeoutSeconds: 5, enabled: true })
    const pack = tools.createToolPackage({ workspaceId: workspace.id, name: 'Echo pack', description: '', prompt: '', approvalRequired: true, approverIds: [], cardTitle: '', cardDescription: '', enabled: true, steps: [{ toolId: tool.id, toolName: tool.name, phase: 'execute', position: 0, arguments: {} }] })
    const skill = tools.createSkillPackage({ workspaceId: workspace.id, name: 'Echo skill', description: '', prompt: '', skills: [], toolPackageIds: [pack.id], fallbackMode: 'package_first' })
    expect(store.getTool(tool.id)).toMatchObject({ name: 'Echo' })
    expect(store.getToolPackage(pack.id)).toMatchObject({ name: 'Echo pack' })
    expect(store.listSkillPackages()).toContainEqual(expect.objectContaining({ id: skill.id, toolPackageIds: [pack.id] }))
    store.close()
  })
})
