import { describe, expect, it } from 'vitest'
import { buildCopilotContext, buildRouteContext, scheduledRuntimePermissions } from '../src/runtime-contexts.js'

describe('runtime execution contexts', () => {
  it('uses native read-only or full-access permissions for scheduled runs', () => {
    expect(scheduledRuntimePermissions('read_only')).toEqual({ sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } })
    expect(scheduledRuntimePermissions('yolo')).toEqual({ sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(scheduledRuntimePermissions('maintenance').sandbox).toBe('read-only')
  })
  it('keeps the admin Copilot read-only and route execution explicitly privileged', () => {
    const input = { workspacePath: process.cwd(), accountId: 'admin', workspaceName: 'test', workspaceId: 'ws', platformContext: 'context' }
    expect(buildCopilotContext(input as never).turn.sandboxPolicy).toEqual({ type: 'readOnly' })
    const route = { workspace: { path: process.cwd() }, turnInstructions: 'investigate' }
    expect(buildRouteContext(route as never, '', 'package-1=id-1', 'resources').turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  })

  it('attaches only the current sender to turn context and escapes identity fields', () => {
    const route = { workspace: { path: process.cwd() }, turnInstructions: 'investigate' }
    const context = buildRouteContext(route as never, '', '', '', { openId: 'ou_user', name: 'A&B', email: 'a"b@example.com' })
    expect(context.turn?.additionalContext?.['cody-bot-hub-sender']?.value).toContain('<sender type="user" open_id="ou_user" name="A&amp;B" email="a&quot;b@example.com" />')
    expect(buildRouteContext(route as never).turn?.additionalContext).not.toHaveProperty('cody-bot-hub-sender')
  })
})
