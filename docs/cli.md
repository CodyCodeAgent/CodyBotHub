# CLI 群消息接入（第一版）

CLI 将外部数字员工、机器人或服务账号提交的群消息交给 Hub 的执行 Bot，返回持久化 Task 和结果。身份与执行 Bot 独立：Token 确定身份，身份的默认 Bot 决定工作区、场景、模型和技能。消息中的 sender 只表示原始消息作者，不用于鉴权。

## 本地启动

要求 Node.js 22.16+、pnpm 11.7.0。安装依赖后可直接使用仓库内 CLI，无需全局安装。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm cli --help
```

默认 UI 为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:4310`。请使用独立的测试数据目录；应用不会自动读取 `.env`。

```bash
CODY_BOT_HUB_DATA_DIR=/absolute/path/to/local-test-data pnpm dev
```

## 管理员创建身份

1. 初始化本地管理员，创建工作区和执行 Bot。仅用 CLI 时，Bot 的 App ID、Secret 可以留空，不会连接飞书。
2. 按现有方式为这个 Bot 配置模型、场景和技能包。
3. 打开「交互身份」，填写名称、类型、默认执行 Bot。默认仅允许这个 Bot；可展开额外 Bot 授权。
4. 点击「创建并领取 Token」，将仅显示一次的 Token 存入调用方的 Secret 配置。
5. 多个实例代表同一逻辑身份时，在「Token 管理」分别签发 Token；可以单独吊销。停用身份会使全部 Token 无法继续调用。

```bash
export CODYBOTHUB_URL=http://127.0.0.1:4310
# 从受保护的环境或 Secret 配置注入 CODYBOTHUB_TOKEN，不要写入仓库。
pnpm cli identity whoami
```

## 机器人自行注册

管理员在「交互身份」填写名称、默认 Bot 和授权范围，点击「生成机器人注册邀请」。将邀请码注入机器人的 `CODYBOTHUB_REGISTRATION_TOKEN`，执行：

```bash
pnpm cli identity register
```

注册邀请 15 分钟内有效且只能使用一次；目标 Bot 和授权范围由管理员预先确定，注册请求不能改变这些权限。CLI 以 JSON 返回身份和新 Token，此时应把 `token` 保存为 `CODYBOTHUB_TOKEN`，之后使用普通交互 Token。注册 Token 和普通 Token 均仅保存 SHA-256 哈希。

## 提交消息

### 先查询场景，再由上游数字人选择

```bash
pnpm cli scene list --json
# 可选：只查询一个已授权 Bot 的场景。
pnpm cli scene list --bot-id BOT_UUID --json
```

场景目录通过当前交互 Token 鉴权，只返回授权 Bot 下已启用的场景；没有可用场景时返回空数组。查询不启动模型、不创建 Task、Thread 或话题绑定。

```json
{
  "matchSemantics": {
    "acrossFields": "AND",
    "withinField": "OR",
    "emptyField": "unrestricted",
    "textMatch": "case_insensitive_substring",
    "idMatch": "exact",
    "priority": "ascending"
  },
  "scenes": [
    {
      "sceneId": "11111111-1111-4111-8111-111111111111",
      "botId": "22222222-2222-4222-8222-222222222222",
      "botName": "支付助手",
      "name": "支付故障排查",
      "description": "分析支付服务告警、超时和错误率异常。",
      "priority": 100,
      "isFallback": false,
      "conversationMode": "topic",
      "executionMode": "read_only",
      "matcher": {
        "chatIds": ["oc_payment_alerts"],
        "messageTypes": ["text", "interactive"],
        "textIncludes": ["支付", "payment"],
        "cardTitleIncludes": []
      }
    }
  ]
}
```

管理员在「场景路由 → 编辑场景 → 对外能力说明」维护 description（最多 2000 字符）；已有场景默认为空，可逐个补齐。目录不包含内部 Prompt、工作区路径或技能包的内部配置。

路由规则的不同字段之间为 AND，同一字段内为 OR，空字段不限制；群 ID 和消息类型精确匹配，正文/标题按不区分大小写的子串匹配。目录沿用现有路由排序：优先级数值小的在前，同优先级按名称排序。四类匹配条件都为空时标记 `isFallback: true`，表示兜底场景，不应据此把所有消息都委托给 Hub。

上游 AI 可结合说明与规则决定是否委托，选中后直接传 sceneId：

```bash
pnpm cli message submit --scene-id SCENE_UUID --input message.json --json
```

也可以在消息 JSON 中添加 `"sceneId": "SCENE_UUID"`。服务端从场景确定所属 Bot，调用方无需填写 botId；如果同时填写，两者必须一致，且 Bot 必须属于身份授权范围。目录查询和提交之间场景被停用、删除或失去授权时会返回错误。

显式指定场景时不要求 matcher 命中，也不再按关键词选择其他场景；这些 matcher 是自动选择规则，身份授权才是执行权限边界。群和话题继续决定 Thread 连续性，切换同一 Bot 下的场景不会拆分 Thread。在话题模式下，显式选定的场景会被后续未指定场景、且未命中新规则的消息继承。

未选择场景时，上游数字人可以自行处理消息；CLI 不自动替它做委托判断。原有不传 sceneId 的提交方式继续支持自动路由。

可以直接传入常见字段：

```bash
pnpm cli message submit \
  --chat-id oc_example \
  --message-id om_example \
  --sender-id ou_example \
  --text '请分析这个告警' \
  --json
```

也可保存以下 JSON 为 `message.json`，用 `pnpm cli message submit --input message.json --json` 提交。`--input -` 从 stdin 读取 JSON，可以搭配 `--scene-id`、`--bot-id`；若 flag 与 JSON 中的对应 ID 不一致则报错，不会覆盖。其他消息字段 flags 不可与 `--input` 混用。

```json
{
  "chatId": "oc_example",
  "chatName": "测试群",
  "topicId": "om_topic_root",
  "messageId": "om_example",
  "sender": {
    "id": "ou_example",
    "name": "消息作者",
    "type": "user",
    "appId": "cli_source_app",
    "idType": "open_id"
  },
  "message": {
    "type": "card",
    "title": "服务错误率告警",
    "text": "payments 服务错误率升高，请分析。",
    "raw": { "service": "payments" }
  },
  "createdAt": "2026-10-28T21:00:00+08:00"
}
```

最小必填：`chatId`、`messageId`、`sender.id`、`message.text`。`botId` 可省略：有 sceneId 时使用场景所属 Bot，否则使用身份默认 Bot；显式传入时必须在该身份授权范围内。`eventId` 可省略，服务端使用 `messageId`。完整 Schema 可通过带 Token 的 `GET /api/v1/message-schema` 获取，它与服务端入参校验使用同一个定义。消息类型支持飞书原生的 `interactive`（卡片）和 `media`，同时保留已有 `card`、`video` 值，自动匹配时按类型原值精确比较。

所有可选字段见 `packages/contracts/src/interaction.ts`。可提供 `mentions`、`addressedToBot` 和 `metadata`；CLI 为显式提交，服务端始终处理，不用 `addressedToBot` 决定是否执行。首版图片、文件等仅接受提取后的文本与元数据，不上传、下载或读取客户端本地附件路径。

## 等待与输出

```bash
# 默认等待，最长 300 秒；任务 ID 输出到 stderr，回答输出到 stdout。
pnpm cli message submit --input message.json

# 立即返回 JSON Task 快照。
pnpm cli message submit --input message.json --async

pnpm cli task get TASK_UUID --json
pnpm cli task wait TASK_UUID --timeout 600 --json
```

JSON 包含 `taskId`、`status`、`answer`、`error`、`progress`、`route`、`createdAt` 和 `updatedAt`。`route` 包含 Bot、Scene、Workspace 和 Thread Channel 标识及路由来源。Token 只能读取同一身份提交的 CLI Task，不能通过该接口读取其他身份、MCP 或飞书 Task。

退出码：`0` 成功（包括异步接受、查询中的任务）；`1` Agent 失败或任务取消；`2` 参数、鉴权或 HTTP 错误；`124` 等待超时；`130` 被 Ctrl-C 中断。等待超时与 Ctrl-C 均不取消已被服务端接受的任务，可用同一个 Task ID 继续等待。

## 路由、隔离与恢复

管理端的「消息记录」和「运行总览」统一包含飞书消息、CLI/API 和 MCP 的 Agent 执行任务；目录查询不计入处理量。可按入口筛选，在消息记录中搜索 Task ID，并查看输入、返回调用方的结果、状态和耗时。CLI/MCP 任务不提供飞书消息的重试按钮，也不会因此向群发消息。

新任务保存执行时的场景、技能包装配、实际模型、原生 Thread 引用和调查工具快照。旧任务直接从持久化 Task 展示，不改写历史数据；未保存的装配和执行信息标为未记录，不按当前配置推算技能包使用量。技能包装配与实际工具调用分别展示；`completed` 表示执行结束，不表示业务问题已经解决。

- 场景匹配使用真实 `chatId`、消息类型、正文和标题，沿用 Hub 的匹配优先级与群绑定。
- 指定 sceneId 时固定使用该场景，返回 `routeSource: explicit`；排空恢复与重启恢复保留选择。场景已停用、被删除或移出原 Bot 时，尚未开始的显式任务失败，不改投默认场景。
- 会话按「CLI + 身份 + 执行 Bot + 群 + 有效话题」隔离。同一身份的多个 Token 共享会话；不同身份与飞书入口不会共享 Thread。话题是否参与由 Bot 的会话模式决定；话题模式下无 `topicId` 时使用 `messageId` 作为新话题根。CLI 首版不跨会话进行画像相似度 Thread 复用。
- CLI 的话题场景继承也按身份隔离；内部绑定表保存带入口和身份命名空间的群键，原始群 ID 保存在 Task 输入与审计中。
- 「身份 + 执行 Bot + messageId」为幂等键。重投仅改变 `eventId` 时返回原 Task；其他字段变化（包括同一 Bot 下换 sceneId）返回 409，不重新执行。重试时应保留同一 Bot 和 sceneId；改变默认 Bot 后建议显式传原 `botId`。
- 同一 Thread Channel 串行，不同群可并行。任务持久化后恢复排队；已进入 running 的任务在进程重启时标记失败，不自动重放。排空期间接受并持久排队，恢复后执行。停用身份或移除 Bot 授权会阻止尚未开始的任务执行，已运行任务不会强制中断。
- 任务使用原生只读沙箱，并移除 Tool Package 调用。不发送飞书消息、卡片或表情，也不进入飞书审批流程。调用方负责把结果回复给原群。

## HTTP API

普通交互 Token 通过 `Authorization: Bearer <token>` 传入。远端调用应通过 HTTPS。CLI 不跟随重定向，避免凭据被转发。

| Method | Path | 功能 |
| --- | --- | --- |
| POST | `/api/v1/identities/register` | 使用一次性注册 Token 注册，body 为 `{}` |
| GET | `/api/v1/identity` | 当前身份、授权 Bot 和 Credential ID |
| GET | `/api/v1/scenes?botId=BOT_UUID` | 查询可用场景、对外说明、规则及兜底标记；botId 可省略 |
| GET | `/api/v1/message-schema` | JSON Schema |
| POST | `/api/v1/messages?waitMs=0` | 提交，返回 202；内联等待最多 25000ms |
| GET | `/api/v1/tasks/:id` | 查询本人身份的 Task |
| GET | `/api/v1/tasks/:id/wait?timeoutMs=25000` | 长轮询，单次最多 25 秒 |

管理员 Cookie API：`GET/POST /api/identities`、`PUT /api/identities/:id`、`GET/POST /api/identities/:id/credentials`、`DELETE /api/identities/:id/credentials/:credentialId`、`POST /api/identity-invitations`。交互 Token 没有管理端权限。

## 本地验证

```bash
pnpm check

# 可选：需要已安装、已登录的 Codex，真实执行两轮只读 Turn。
pnpm --filter @cody-bot-hub/server exec tsx scripts/verify-cli-local.ts
```

自动测试覆盖身份与 Token、单次注册、权限隔离、幂等、场景目录过滤与无副作用、显式场景选择与恢复、场景停用/删除、话题和群隔离、串行与并行、排空恢复、故障、真实 CLI 子进程和等待超时。真实 Turn 验证脚本先通过 CLI 查询场景，再指定一个不命中 matcher 的场景执行两轮原生会话，验证话题继承与幂等；使用临时 SQLite、工作区和动态 loopback 端口，不启动飞书 Provider；结束后删除自己的临时测试目录，不触及已有 Hub 数据，不部署服务。
