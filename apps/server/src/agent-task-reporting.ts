import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { ResolvedRoute } from './types.js'

const implementation = 'skills/mk_biz/domain/common/agent-task-lifecycle/scripts/agent_task.py'
export const supportsAgentTaskReporting = (workspace: string): boolean => existsSync(path.join(workspace, implementation)) && existsSync(path.join(workspace, 'config/agent-task-base.json'))

// Core merges these overrides with the parent environment; explicit undefined
// removes host credentials and compatibility identity from the engine process.
export function reportingRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.keys(env).filter(key => key.startsWith('BOTMUX_') || key.startsWith('AGENT_TASK_COLLECTOR_')).map(key => [key, undefined]))
}

export type ReportingContext = { workspace: string; appId: string; chatId: string; sessionId: string; messageId: string; requester: string; threadId: string }
export function reportingContext(route: ResolvedRoute, message: ChannelInboundMessage, threadId: string): ReportingContext {
  if (message.provider !== 'feishu' || !message.messageId) throw new Error('Task reporting requires a real inbound Feishu message')
  return { workspace: realpathSync.native(route.workspace.path), appId: route.bot.appId, chatId: message.conversation.id, sessionId: route.threadChannelId, messageId: message.messageId, requester: message.sender.type === 'user' ? message.sender.id : '', threadId }
}

export const reportingTool = {
  type: 'function' as const, name: 'agent_task',
  description: '当前飞书机器人任务上报的受管 CLI。宿主绑定真实 app/chat/session/入站消息，不能指定身份或目的地。主动注册用 register；name 仅预览，用户明确确认当前名称后才传 confirmationId。日常未注册不查询注册、不追补历史。任务记录使用 start/wait/resume/finish；回复由 CodyBotHub 发送，不调用 BotMux。',
  inputSchema: { type: 'object', properties: {
    command: { type: 'string', enum: ['register', 'start', 'wait', 'resume', 'finish', 'show', 'sync'] },
    name: { type: 'string' }, confirmationId: { type: 'string' },
    kind: { type: 'string', enum: ['qa', 'oncall', 'alarm'] }, taskKey: { type: 'string' }, description: { type: 'string' },
    roundId: { type: 'string', description: 'start 返回的轮次 ID；不接受其它会话轮次' }, eventKey: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] }, summary: { type: 'string' }, fields: { type: 'object' },
  }, required: ['command'], additionalProperties: false },
}

const allowed: Record<string, string[]> = {
  register: ['name', 'confirmationId'], start: ['kind', 'taskKey', 'description', 'fields'],
  wait: ['roundId', 'eventKey'], resume: ['roundId', 'eventKey'], finish: ['roundId', 'status', 'summary', 'fields'], show: ['roundId'], sync: [],
}
const str = (args: Record<string, unknown>, key: string, required = false, max = 1000): string => {
  const value = args[key]
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error(`Invalid ${key}`)
  return value
}
export function reportingArguments(context: ReportingContext, args: Record<string, unknown>): string[] {
  const command = str(args, 'command', true), keys = allowed[command]
  if (!keys || Object.keys(args).some(key => key !== 'command' && !keys.includes(key))) throw new Error('Unsupported reporting arguments')
  const argv = [command]
  const add = (key: string, flag: string, required = false, max = 1000) => { const value = str(args, key, required, max); if (value) argv.push(flag, value) }
  if (command === 'register') {
    if (args.name !== undefined && args.confirmationId !== undefined) throw new Error('Preview a name before confirmation')
    add('name', '--name', false, 64); add('confirmationId', '--confirm', false, 32)
  }
  if (command === 'start') {
    const kind = str(args, 'kind', true)
    if (!['qa', 'oncall', 'alarm'].includes(kind)) throw new Error('Invalid kind')
    argv.push('--kind', kind, '--scenario-id', kind, '--round-id', context.messageId)
    add('taskKey', '--task-key', true, 44); add('description', '--description', true, 256)
  }
  if (['wait', 'resume', 'finish', 'show'].includes(command)) add('roundId', '--round-id', true, 32)
  if (command === 'wait' || command === 'resume') add('eventKey', '--event-key', true, 128)
  if (command === 'finish') {
    const status = str(args, 'status', true)
    if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error('Invalid status')
    argv.push('--status', status); add('summary', '--summary', true)
  }
  if (args.fields !== undefined) {
    if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields) || Object.values(args.fields).some(v => typeof v !== 'string' || !v.trim() || v.length > 256)) throw new Error('Invalid scenario fields')
    argv.push('--fields-json', JSON.stringify(args.fields))
  }
  return argv
}

// Imports the canonical implementation with its sibling modules and validates a
// round before any lifecycle mutation. Never call the legacy runpy-only shim.
const bootstrap = `import json,os,runpy,sqlite3,sys
from pathlib import Path
entry,db_path=sys.argv[1:3]
argv=json.load(sys.stdin)
config=Path(entry).resolve().parents[6]/'config/agent-task-base.json'
if json.loads(config.read_text()).get('transport')!='collector':
 raise SystemExit('CodyBotHub requires collector transport')
if argv[0] in ('wait','resume','finish','show'):
 if not Path(db_path).is_file(): raise SystemExit('Round does not belong to this conversation')
 with sqlite3.connect(Path(db_path).as_uri()+'?mode=ro',uri=True) as db:
  row=db.execute('SELECT context FROM rounds WHERE id=?',(argv[argv.index('--round-id')+1],)).fetchone()
  ctx=json.loads(row[0]) if row else {}
  if any(ctx.get(k)!=os.environ.get(v) for k,v in [('app_id','BOTMUX_LARK_APP_ID'),('chat_id','BOTMUX_CHAT_ID'),('session_id','BOTMUX_SESSION_ID')]):
   raise SystemExit('Round does not belong to this conversation')
sys.path.insert(0,str(Path(entry).parent))
sys.argv=[entry,'--db',db_path,*argv]
runpy.run_path(entry,run_name='__main__')
`

export type ReportingRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input: string }) => Promise<unknown>
const run: ReportingRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = '', settled = false
  const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGTERM'); reject(new Error(message)) } }
  const timer = setTimeout(() => fail('Task reporting timed out; check status before retrying confirmation'), 120_000)
  child.on('error', () => fail('Task reporting process unavailable'))
  child.stdin.on('error', () => undefined)
  child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 262_144) fail('Task reporting response too large') })
  child.stderr.on('data', chunk => { errors += chunk.toString(); if (errors.length > 262_144) fail('Task reporting error response too large') })
  child.on('close', code => {
    clearTimeout(timer)
    if (settled) return
    settled = true
    try {
      const result = JSON.parse(output || errors) as Record<string, unknown>
      if (code !== 0) reject(new Error(typeof result.error === 'string' ? result.error : 'Task reporting failed'))
      else resolve(result)
    } catch { reject(new Error('Task reporting failed; registration or Base receipt is unconfirmed')) }
  })
  child.stdin.end(options.input)
})

export class AgentTaskReporting {
  constructor(private readonly directory: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly runner: ReportingRunner = run) {}
  async invoke(context: ReportingContext, args: Record<string, unknown>): Promise<unknown> {
    if (!context.appId || !context.chatId || !context.sessionId || !context.messageId) throw new Error('Trusted Feishu app/chat/session/message context is unavailable')
    if (!supportsAgentTaskReporting(context.workspace)) throw new Error('Workspace has no agent-task-lifecycle implementation')
    if (!this.env.AGENT_TASK_COLLECTOR_URL || !this.env.AGENT_TASK_COLLECTOR_TOKEN) throw new Error('Host must configure AGENT_TASK_COLLECTOR_URL and AGENT_TASK_COLLECTOR_TOKEN')
    const argv = reportingArguments(context, args)
    const key = createHash('sha256').update(JSON.stringify([context.appId, context.chatId, context.sessionId])).digest('hex')
    return this.runner('python3', ['-c', bootstrap, path.join(context.workspace, implementation), path.join(this.directory, 'agent-task-clients', `${key}.sqlite3`)], {
      cwd: context.workspace, input: JSON.stringify(argv),
      env: { ...this.env, BOTMUX_LARK_APP_ID: context.appId, BOTMUX_CHAT_ID: context.chatId, BOTMUX_SESSION_ID: context.sessionId, BOTMUX_ROOT_MESSAGE_ID: context.messageId, BOTMUX_SENDER_OPEN_ID: context.requester, CODEX_THREAD_ID: context.threadId },
    })
  }
}
