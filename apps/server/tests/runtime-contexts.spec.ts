import { describe, expect, it } from 'vitest'
import { buildCopilotContext, buildRouteContext } from '../src/runtime-contexts.js'

describe('runtime execution contexts', () => {
  it('keeps the admin Copilot read-only and route execution explicitly privileged', () => {
    const input = { workspacePath: process.cwd(), accountId: 'admin', workspaceName: 'test', workspaceId: 'ws', platformContext: 'context' }
    expect(buildCopilotContext(input as never).turn.sandboxPolicy).toEqual({ type: 'readOnly' })
    const route = { workspace: { path: process.cwd() }, turnInstructions: 'investigate' }
    expect(buildRouteContext(route as never, '', 'package-1=id-1', 'resources').turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  })
})
