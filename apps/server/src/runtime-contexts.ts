import { realpathSync } from 'node:fs'
import type { ExecutionContext } from '@codycodeagent/cody-web-core/session'
import type { CopilotExecutionInput } from './runtime.js'
import type { ResolvedRoute } from './types.js'

export function buildRouteContext(route: ResolvedRoute, resourceInstructions = '', toolContract = '', authorizedNames = ''): ExecutionContext {
    const cwd = realpathSync.native(route.workspace.path)
    const developerInstructions = [route.turnInstructions, toolContract].filter(Boolean).join('\n\n')
    return {
      thread: {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        runtimeWorkspaceRoots: [cwd],
        baseInstructions: null,
        developerInstructions: developerInstructions || null,
        experimentalRawEvents: false,
        ephemeral: false,
        dynamicTools: [{
          type: 'namespace',
          name: 'codybothub',
          description: 'CodyBotHub 中由管理员注册、可审批、可审计的业务操作。',
          tools: [{
            type: 'function',
            name: 'invoke_tool_package',
            description: `在完成分析并有足够证据后，申请或执行当前技能包关联的工具包。需要审批时会发送飞书确认卡片。${toolContract ? ` 当前允许：${authorizedNames}` : ' 当前场景没有授权工具包。'}`,
            inputSchema: {
              type: 'object',
              properties: {
                packageId: { type: 'string', description: '工具包 ID，只能使用当前上下文列出的 ID' },
                arguments: { type: 'object', description: '工具包所需业务参数' },
                reason: { type: 'string', description: '执行原因、证据和预期影响' },
              },
              required: ['packageId', 'arguments', 'reason'], additionalProperties: false,
            },
          }],
        }],
      },
      turn: {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        summary: 'detailed',
        additionalContext: developerInstructions || resourceInstructions ? {
          'cody-bot-hub-route': { kind: 'application', value: [developerInstructions, resourceInstructions].filter(Boolean).join('\n\n') },
        } : null,
      },
    }
}

export function buildCopilotContext(input: CopilotExecutionInput): ExecutionContext {
    const cwd = realpathSync.native(input.workspacePath)
    const instructions = [
      '你是 CodyBotHub 平台管理员 Copilot。使用简洁中文帮助管理员查询平台、查找飞书人员和生成配置草稿。',
      '所有平台事实必须通过 codybothub_admin 工具查询，不要猜测 ID、配置或人员信息。',
      '你运行在只读沙箱中。不得直接编辑工作区、数据库或平台配置。需要创建托管脚本时，先完成脚本、参数和 Schema 设计，再调用 propose_managed_script 生成待确认草稿。需要调整 Bot 操作人时，先确认唯一人员 Open ID 和 Bot，再调用 propose_bot_operator。所有草稿只有管理员点击应用后才会生效。',
      '查找人员基本信息时调用 search_feishu_user。当用户询问“我或某人在指定 Bot 应用下的 Open ID”时，先用 inspect_platform 找到准确 Bot ID，再调用 resolve_feishu_bot_user；用户说“我”时 query 传 me。只有 resolve_feishu_bot_user 返回的 Open ID 可用于 Bot 操作人或工具包审批人授权。search_feishu_user 返回的 Open ID 属于 lark-cli 用户应用命名空间，不得直接授权。',
      '生成脚本时使用参数 argv，不把用户输入拼进 shell 命令；给出明确错误、超时和 JSON 输出。',
      `当前账号：${input.accountId}；当前工作区：${input.workspaceName}（${input.workspaceId}）。`,
      `平台概览：${input.platformContext}`,
    ].join('\n\n')
    return {
      thread: {
        cwd, approvalPolicy: 'never', sandbox: 'read-only', runtimeWorkspaceRoots: [cwd], baseInstructions: null, developerInstructions: instructions, experimentalRawEvents: false, ephemeral: false,
        dynamicTools: [{
          type: 'namespace', name: 'codybothub_admin', description: 'CodyBotHub 平台管理查询与可确认草稿工具。', tools: [
            { type: 'function', name: 'inspect_platform', description: '查询平台工作区、Bot、场景、技能包、工具和工具包。', inputSchema: { type: 'object', properties: { resource: { type: 'string', enum: ['all', 'workspaces', 'bots', 'scenes', 'skillPackages', 'tools', 'toolPackages'] }, query: { type: 'string' } }, additionalProperties: false } },
            { type: 'function', name: 'search_feishu_user', description: '按姓名或邮箱搜索飞书员工并返回 Open ID、邮箱和部门。', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
            { type: 'function', name: 'resolve_feishu_bot_user', description: '在指定 CodyBotHub Bot 的飞书应用命名空间下，从该 Bot 已收到消息的用户和应用管理员中按姓名解析可授权的 Open ID。用户说“我”时 query 传 me。', inputSchema: { type: 'object', properties: { botId: { type: 'string', description: 'inspect_platform 返回的目标 Bot ID' }, query: { type: 'string', description: '人员姓名，或 me 表示当前 lark-cli 登录用户' } }, required: ['botId', 'query'], additionalProperties: false } },
            { type: 'function', name: 'propose_managed_script', description: '创建平台托管脚本草稿。只生成待确认提案，不直接保存工具。', inputSchema: { type: 'object', properties: {
              name: { type: 'string' }, description: { type: 'string' }, language: { type: 'string', enum: ['python', 'shell', 'node'] }, scriptContent: { type: 'string' },
              argumentsTemplate: { type: 'array', items: { type: 'string' } }, inputSchema: { type: 'object' }, timeoutSeconds: { type: 'number' },
            }, required: ['name', 'description', 'language', 'scriptContent', 'argumentsTemplate', 'inputSchema'], additionalProperties: false } },
            { type: 'function', name: 'propose_bot_operator', description: '创建添加或移除 Bot 操作人的配置草稿。调用前必须已确认目标 Bot 应用命名空间下的准确 Open ID，不得使用 search_feishu_user 返回的个人应用 Open ID。', inputSchema: { type: 'object', properties: {
              botId: { type: 'string', description: 'inspect_platform 返回的 Bot ID' }, openId: { type: 'string', description: '目标 Bot 卡片回调提示或当前飞书应用返回的 ou_ Open ID' }, personName: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove'] },
            }, required: ['botId', 'openId', 'action'], additionalProperties: false } },
          ],
        }],
      },
      turn: { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, summary: 'concise', additionalContext: { 'cody-bot-hub-admin': { kind: 'application', value: instructions } } },
    }
}
