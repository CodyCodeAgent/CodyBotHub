import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentTaskReporting, reportingArguments, reportingContext, reportingRuntimeEnvironment, supportsAgentTaskReporting, type ReportingContext, type ReportingRunner } from '../src/agent-task-reporting.js'
import { buildRouteContext } from '../src/runtime-contexts.js'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hub-agent-reporting-')); roots.push(root)
  const scripts = path.join(root, 'skills/mk_biz/domain/common/agent-task-lifecycle/scripts')
  mkdirSync(scripts, { recursive: true }); mkdirSync(path.join(root, 'config'))
  writeFileSync(path.join(root, 'config/agent-task-base.json'), JSON.stringify({ transport: 'collector' }))
  writeFileSync(path.join(scripts, 'helper.py'), 'value = "canonical-sibling"\n')
  writeFileSync(path.join(scripts, 'agent_task.py'), `import json,os,sqlite3,sys\nfrom pathlib import Path\nimport helper\na=sys.argv[1:]\np=Path(a[1]);p.parent.mkdir(parents=True,exist_ok=True)\nwith sqlite3.connect(p) as db:\n db.execute('CREATE TABLE IF NOT EXISTS rounds(id TEXT,context TEXT)')\n if 'start' in a: db.execute('INSERT INTO rounds VALUES (?,?)',('a'*32,json.dumps({'app_id':os.environ['BOTMUX_LARK_APP_ID'],'chat_id':os.environ['BOTMUX_CHAT_ID'],'session_id':os.environ['BOTMUX_SESSION_ID']})))\nprint(json.dumps({'argv':a,'app':os.environ['BOTMUX_LARK_APP_ID'],'sibling':helper.value}))\n`)
  const context: ReportingContext = { workspace: root, appId: 'cli_bot-a', chatId: 'chat-a', sessionId: 'session-a', messageId: 'actual-current-message', requester: 'actor', threadId: 'native-thread' }
  return { root, context }
}
const env = { AGENT_TASK_COLLECTOR_URL: 'http://127.0.0.1:8765/v1/task-rounds', AGENT_TASK_COLLECTOR_TOKEN: 'host-only-test-credential-not-a-real-secret' }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('managed task reporting', () => {
  it('removes the host credential and compatibility identity from shared engines', () => {
    const source = { ...env, BOTMUX_LARK_APP_ID: 'another-bot', CODEX_THREAD_ID: 'native' }
    const child = { ...source, ...reportingRuntimeEnvironment(source) }
    expect(child.AGENT_TASK_COLLECTOR_TOKEN).toBeUndefined()
    expect(child.BOTMUX_LARK_APP_ID).toBeUndefined()
    expect(child.CODEX_THREAD_ID).toBe('native')
    expect(source.AGENT_TASK_COLLECTOR_TOKEN).toBe(env.AGENT_TASK_COLLECTOR_TOKEN)
  })
  it('rejects MCP and synthetic messages as real Feishu telemetry rounds', () => {
    expect(() => reportingContext({} as never, { provider: 'mcp', messageId: 'synthetic' } as never, 'thread')).toThrow('real inbound Feishu')
    expect(() => reportingContext({} as never, { provider: 'feishu', messageId: '' } as never, 'thread')).toThrow('real inbound Feishu')
  })
  it('exposes the managed entry only for installed workspaces (old routes had no entry)', () => {
    const { root } = fixture()
    const route = { workspace: { path: root }, turnInstructions: '' }
    const ctx = buildRouteContext(route as never)
    expect(ctx.thread.dynamicTools?.[0].tools.map(tool => tool.name)).toContain('agent_task')
    expect(JSON.stringify(ctx)).not.toContain(env.AGENT_TASK_COLLECTOR_TOKEN)
    expect(supportsAgentTaskReporting(tmpdir())).toBe(false)
  })
  it('binds the actual message id and rejects model supplied identity or historical ids', () => {
    const { context } = fixture()
    expect(reportingArguments(context, { command: 'start', kind: 'qa', taskKey: 'explain', description: '解释规则' })).toContain(context.messageId)
    for (const key of ['appId', 'chatId', 'sessionId', 'messageId', 'roundId', 'config', 'db', 'notify', 'send']) {
      expect(() => reportingArguments(context, { command: 'start', kind: 'qa', taskKey: 'explain', description: '解释规则', [key]: 'foreign' })).toThrow()
    }
  })
  it('keeps concurrent bot environments and client ledgers independent', async () => {
    const { root, context } = fixture()
    const runner = vi.fn<ReportingRunner>().mockResolvedValue({ registered: false, state: 'awaiting_name' })
    const reporting = new AgentTaskReporting(root, env, runner)
    const other = { ...context, appId: 'cli_bot-b', chatId: 'chat-b', sessionId: 'session-b' }
    await Promise.all([reporting.invoke(context, { command: 'register' }), reporting.invoke(other, { command: 'register' })])
    const calls = runner.mock.calls
    expect(calls[0][2].env.BOTMUX_LARK_APP_ID).toBe(context.appId)
    expect(calls[1][2].env.BOTMUX_LARK_APP_ID).toBe(other.appId)
    expect(calls[0][1].at(-1)).not.toEqual(calls[1][1].at(-1))
    expect(JSON.stringify(calls.map(c => c[1]))).not.toContain(env.AGENT_TASK_COLLECTOR_TOKEN)
    expect(env).not.toHaveProperty('BOTMUX_LARK_APP_ID')
  })
  it('keeps preview and confirmation as distinct invocations', async () => {
    const { root, context } = fixture()
    const runner = vi.fn<ReportingRunner>().mockResolvedValue({ state: 'awaiting_confirmation', registered: false })
    const reporting = new AgentTaskReporting(root, env, runner)
    await expect(reporting.invoke(context, { command: 'register', name: '机器人' })).resolves.toMatchObject({ registered: false })
    expect(JSON.parse(runner.mock.calls[0][2].input)).toEqual(['register', '--name', '机器人'])
    expect(() => reportingArguments(context, { command: 'register', name: '机器人', confirmationId: 'a'.repeat(32) })).toThrow()
    expect(reportingArguments(context, { command: 'register', confirmationId: 'a'.repeat(32) })).toEqual(['register', '--confirm', 'a'.repeat(32)])
  })
  it('refuses missing host configuration and missing trusted message context', async () => {
    const { root, context } = fixture()
    const runner = vi.fn<ReportingRunner>()
    await expect(new AgentTaskReporting(root, {}, runner).invoke(context, { command: 'register' })).rejects.toThrow('Host must configure')
    await expect(new AgentTaskReporting(root, env, runner).invoke({ ...context, messageId: '' }, { command: 'register' })).rejects.toThrow('Trusted Feishu')
    expect(runner).not.toHaveBeenCalled()
  })
  it('loads sibling modules through the canonical CLI and refuses another conversation round', async () => {
    const { root, context } = fixture()
    const reporting = new AgentTaskReporting(root, env)
    const result = await reporting.invoke(context, { command: 'start', kind: 'qa', taskKey: 'explain', description: '解释规则' })
    expect(result).toMatchObject({ app: context.appId, sibling: 'canonical-sibling' })
    await expect(reporting.invoke(context, { command: 'show', roundId: 'a'.repeat(32) })).resolves.toMatchObject({ app: context.appId })
    await expect(reporting.invoke({ ...context, sessionId: 'other-session' }, { command: 'show', roundId: 'a'.repeat(32) })).rejects.toThrow('unconfirmed')
  })
  it('does not fall back to direct Base credentials', async () => {
    const { root, context } = fixture()
    writeFileSync(path.join(root, 'config/agent-task-base.json'), JSON.stringify({ transport: 'direct_base' }))
    await expect(new AgentTaskReporting(root, env).invoke(context, { command: 'register' })).rejects.toThrow('unconfirmed')
  })
})
