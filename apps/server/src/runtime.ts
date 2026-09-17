import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { channelCommandId, type ChannelInboundMessage } from '@codycodeagent/cody-web-core/channel'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { createAppServerHost, type AppServerHost } from '@codycodeagent/cody-web-core/runtime'
import { buildTurnUserInput, CodexSessionManager, type CodexSkillOption, type ExecutionContext, type ExecutionPolicyProvider, type TurnInput, type TurnInputSkill } from '@codycodeagent/cody-web-core/session'
import type { HubStore } from './db.js'
import type { ResolvedRoute } from './types.js'

export type RuntimeAttachment = {
  path: string
  type: ChannelInboundMessage['attachments'][number]['type']
  name: string
  sizeBytes: number
}

export type RuntimeProgress = {
  phase: 'thinking' | 'answering'
  reasoning: string
  answer: string
}

export class CodyBotRuntime {
  private host: AppServerHost | null = null
  private manager: CodexSessionManager | null = null
  private readonly attached = new Set<string>()
  private readonly attaching = new Map<string, Promise<void>>()

  constructor(private readonly store: HubStore, private readonly runtimeDirectory: string, private readonly codexCommand = 'codex') {}

  async execute(route: ResolvedRoute, message: ChannelInboundMessage, attachments: RuntimeAttachment[] = [], onProgress?: (progress: RuntimeProgress) => void): Promise<string> {
    const conversation = this.store.getOrCreateConversation(route, message.conversation.id, message.conversation.rootId ?? '')
    const manager = await this.ensureManager()
    await this.ensureConversation(manager, conversation, route)
    const activeThreadId = manager.snapshot(conversation.id)?.threadId ?? conversation.threadId
    manager.setContext(conversation.id, this.context(route))
    const skills = this.resolveSkills(route)
    const localImages = attachments.filter(attachment => attachment.type === 'image').map(attachment => ({ path: attachment.path }))
    const turn: TurnInput = {
      input: buildTurnUserInput({
        text: this.turnText(route, this.messageText(message.text, attachments)),
        ...(skills.length ? { skills } : {}),
        ...(localImages.length ? { localImages } : {}),
      }),
      runtimeWorkspaceRoots: [realpathSync.native(route.workspace.path)],
      approvalPolicy: 'never',
      ...this.permissions(route),
    }
    let turnId = ''
    let reasoning = ''
    let answer = ''
    const applyProgress = (event: CodexEvent): void => {
      if (event.threadId !== activeThreadId || (turnId && event.turnId && event.turnId !== turnId)) return
      const text = typeof event.data.text === 'string' ? event.data.text : ''
      if (event.type === 'reasoning.delta' && text) reasoning += text
      if (event.type === 'reasoning.break' && reasoning && !reasoning.endsWith('\n\n')) reasoning += '\n\n'
      if (event.type === 'assistant.delta' && text) answer += text
      if (event.type === 'assistant.completed' && text) answer = text
      if ((event.type === 'reasoning.delta' || event.type === 'reasoning.break' || event.type === 'assistant.delta' || event.type === 'assistant.completed') && onProgress) {
        onProgress({ phase: answer ? 'answering' : 'thinking', reasoning, answer })
      }
    }
    const unsubscribe = manager.subscribe(applyProgress)
    try {
      const submission = manager.submit(conversation.id, turn, 'queue', channelCommandId(message))
      turnId = (await submission.started).turnId
      const outcome = await submission.completed
      if (outcome.terminalEvent.type === 'turn.failed') throw new Error(String(outcome.terminalEvent.data.error || 'Codex Turn failed'))
      return outcome.assistantText.trim() || answer.trim() || '任务已完成，但没有可显示的文本结果。'
    } finally {
      unsubscribe()
    }
  }

  async dispose(): Promise<void> {
    await this.manager?.dispose()
    await this.host?.dispose()
    this.manager = null
    this.host = null
    this.attached.clear()
  }

  async listSkills(workspacePath: string): Promise<CodexSkillOption[]> {
    const manager = await this.ensureManager()
    return manager.listSkills([realpathSync.native(workspacePath)])
  }

  private async ensureManager(): Promise<CodexSessionManager> {
    if (this.manager) return this.manager
    const policy: ExecutionPolicyProvider = {
      evaluate: operation => /approval/iu.test(operation.method)
        ? ({ action: 'allow', reason: 'CodyBotHub YOLO mode automatically approves tool execution.' })
        : ({ action: 'deny', reason: 'CodyBotHub cannot answer interactive questions without a user response.' }),
    }
    this.host = createAppServerHost({
      command: /(?:^|\s)app-server(?:\s|$)/u.test(this.codexCommand) ? this.codexCommand : `"${this.codexCommand}" app-server --stdio`,
      cwd: this.runtimeDirectory,
      initializeParams: { clientInfo: { name: 'cody-bot-hub', title: 'CodyBotHub', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } },
    })
    this.manager = new CodexSessionManager({ host: this.host, policy })
    await this.host.ensureInitialized()
    return this.manager
  }

  private async ensureConversation(manager: CodexSessionManager, conversation: { id: string; threadId: string }, route: ResolvedRoute): Promise<void> {
    if (this.attached.has(conversation.id)) return
    const pending = this.attaching.get(conversation.id)
    if (pending) return pending
    const attach = (async () => {
      if (conversation.threadId) await manager.resume({ id: conversation.id, threadId: conversation.threadId }, this.context(route))
      else {
        const binding = await manager.create(conversation.id, this.context(route))
        this.store.setConversationThread(conversation.id, binding.threadId)
      }
      this.attached.add(conversation.id)
    })().finally(() => this.attaching.delete(conversation.id))
    this.attaching.set(conversation.id, attach)
    return attach
  }

  private context(route: ResolvedRoute): ExecutionContext {
    const cwd = realpathSync.native(route.workspace.path)
    return {
      thread: {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        runtimeWorkspaceRoots: [cwd],
        baseInstructions: route.systemPrompt || null,
        experimentalRawEvents: false,
        ephemeral: false,
      },
      turn: { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
    }
  }

  private permissions(_route: ResolvedRoute): Pick<TurnInput, 'sandboxPolicy'> {
    return { sandboxPolicy: { type: 'dangerFullAccess' } }
  }

  private resolveSkills(route: ResolvedRoute): TurnInputSkill[] {
    const result: TurnInputSkill[] = []
    for (const name of route.skillPackages.flatMap(item => item.skills)) {
      const candidates = path.isAbsolute(name) ? [name] : [
        path.join(route.workspace.path, '.agents', 'skills', name, 'SKILL.md'),
        path.join(route.workspace.path, '.codex', 'skills', name, 'SKILL.md'),
        path.join(route.workspace.path, 'skills', name, 'SKILL.md'),
      ]
      const skillPath = candidates.find(existsSync)
      if (skillPath) result.push({ name: path.basename(path.dirname(skillPath)), path: skillPath })
    }
    return [...new Map(result.map(item => [item.path, item])).values()]
  }

  private turnText(route: ResolvedRoute, text: string): string {
    const skillNames = route.skillPackages.flatMap(item => item.skills)
    const restrictions = route.skillPackages.some(item => item.fallbackMode === 'package_only')
      ? '本场景只允许使用技能包中列出的 Skill。'
      : route.skillPackages.some(item => item.fallbackMode === 'mixed')
        ? '同时检索技能包和当前 Codex 环境中的其他 Skill。'
        : skillNames.length ? '优先使用技能包中的 Skill；无法满足时再检索当前 Codex 环境中的其他 Skill。' : ''
    return [skillNames.length ? `当前场景技能包：${skillNames.join('、')}。${restrictions}` : '', text].filter(Boolean).join('\n\n')
  }

  private messageText(text: string, attachments: RuntimeAttachment[]): string {
    const files = attachments.filter(attachment => attachment.type !== 'image')
    if (!files.length) return text
    const manifest = files.map(attachment => [
      `- ${attachment.type}：${attachment.name}`,
      `  本地路径：${attachment.path}`,
      `  大小：${attachment.sizeBytes} 字节`,
    ].join('\n')).join('\n')
    return [text, `以下飞书附件已经下载到本机。需要读取内容时，请直接读取列出的本地路径：\n${manifest}`].filter(Boolean).join('\n\n')
  }
}
