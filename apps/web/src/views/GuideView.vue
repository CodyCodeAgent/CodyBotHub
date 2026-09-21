<script setup lang="ts">
import {
  ArrowRight, BookOpenCheck, Bot, BrainCircuit, Check, CheckCircle2, ChevronRight,
  CircleDot, Code2, Database, Eye, FileSearch, FolderRoot, Gauge, GitBranch, History,
  Layers3, LockKeyhole, MessageSquareText, Network, Puzzle, Rocket, Route, Search,
  ServerCog, ShieldCheck, Sparkles, TimerReset, Workflow,
} from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref } from 'vue'

const activeSection = ref('overview')
const activeRole = ref<'owner' | 'builder' | 'operator'>('owner')
let observer: IntersectionObserver | null = null

const navigation = [
  ['overview', '系统定位'], ['architecture', '系统架构'], ['configuration', '配置关系'],
  ['journeys', '按角色使用'], ['pipeline', '消息处理链路'], ['example', '真实案例'],
  ['threads', '会话与经验'], ['operations', '日常运维'],
]

const values = [
  { icon: Route, title: '消息知道该去哪里', text: '按 Bot、群、消息类型、文本和卡片标题识别场景，选择正确的工作区和业务能力。' },
  { icon: Code2, title: 'AI 能接触真实上下文', text: 'Codex 在授权目录中读取代码、知识库与 Skill，并按权限调用工具完成调查。' },
  { icon: GitBranch, title: '会话不会越聊越乱', text: '群模式或话题模式决定基础会话边界；同一 Thread Channel 内的任务严格串行。' },
  { icon: BrainCircuit, title: '处理经验可以复用', text: '系统从已完成任务提取画像；相似问题可以引用结论，或继续原 Codex Thread。' },
]

const planes = [
  { icon: ServerCog, tag: 'CONTROL PLANE', title: '管理与编排层', text: '定义谁能做什么，以及消息命中后该使用哪套能力。', items: ['账号与操作审计', '工作区与文件边界', 'Bot、场景与权限', '模型、Prompt 与技能包'] },
  { icon: Workflow, tag: 'EXECUTION PLANE', title: '消息与执行层', text: '把飞书事件可靠地转换为可排队、可恢复的 Codex 任务。', items: ['飞书长连接与消息去重', '场景路由与上下文组装', 'Thread Channel 串行队列', '流式卡片回复与失败重试'] },
  { icon: BrainCircuit, tag: 'INTELLIGENCE PLANE', title: '知识与经验层', text: '让每次处理都能使用现有知识，并为后续问题留下可复用经验。', items: ['Skill 与知识资源索引', '代码、日志和数据库调查', '经验画像与相似度路由', '结论、证据与 Thread 沉淀'] },
]

const roles = {
  owner: {
    label: '平台管理员', title: '先建立安全、可控的运行底座', description: '适合第一次部署平台，或要接入一个新的飞书应用。',
    steps: [
      ['创建工作区', '选择本地目录，定义基础 Prompt、权限和默认模型。', '/workspaces', '配置工作区'],
      ['接入飞书 Bot', '填写现有应用凭证，关联一个或多个工作区并选择默认工作区。', '/bots', '接入 Bot'],
      ['配置账号与操作人', '管理平台登录账号，并限制哪些飞书用户可以绑定场景。', '/accounts', '管理账号'],
      ['检查运行状态', '确认飞书连接、SQLite、队列和服务状态都正常。', '/', '查看总览'],
    ],
  },
  builder: {
    label: '能力配置者', title: '把业务规则组装成可复用场景', description: '适合告警排查、知识问答、代码分析等业务能力的负责人。',
    steps: [
      ['确认可用 Skill', '在工作区和 Codex Skill 目录中确认系统能识别到需要的能力。', '/skills', '查看 Skill'],
      ['注册工具与工具包', '把 Bits RPC 等原子接口注册为工具，再编排执行顺序、确认卡片和审批人。', '/tool-packages', '配置工具包'],
      ['组装技能包', '把专项 Prompt、首选 Skill 和回退策略组合成能力包。', '/packages', '创建技能包'],
      ['定义场景路由', '配置群、消息类型、关键词或卡片标题，并选择唯一工作区。', '/scenes', '创建场景'],
      ['用真实消息验证', '在飞书中发送消息，再从记录查看实际路由、模型、Skill 和 Thread。', '/messages', '查看记录'],
    ],
  },
  operator: {
    label: '运营与排障', title: '从总览发现问题，再沿完整链路定位', description: '适合观察使用效果、分析失败任务和优化经验复用。',
    steps: [
      ['观察总体趋势', '查看累计处理、成功率、平均耗时、群排行和场景分布。', '/', '打开总览'],
      ['定位单条消息', '使用记录 ID、飞书消息 ID 或 Thread ID 检索输入、回复和错误。', '/messages', '查消息'],
      ['检查会话边界', '确认群或话题绑定到哪个 Thread Channel，以及队列是否阻塞。', '/conversation-threads', '查会话'],
      ['优化经验路由', '检查画像、阈值和复用结果，判断是否需要调整场景规则。', '/thread-routing', '看经验'],
    ],
  },
} as const

const pipeline = [
  { icon: MessageSquareText, title: '接收消息', text: '飞书长连接接收文本、富文本、文件或卡片；按消息 ID 去重，并先打表情确认。', output: '标准化消息' },
  { icon: Route, title: '匹配场景', text: '按优先级判断群、消息类型、文本条件和卡片标题；未命中时允许用户选择场景。', output: '场景 + 工作区' },
  { icon: Layers3, title: '组装上下文', text: '叠加五层 Prompt，选择模型、推理强度、技能包、知识资源与权限。', output: '执行配置快照' },
  { icon: GitBranch, title: '选择会话', text: '按群/话题模式确定基础 Channel，再在同一场景范围内判断是否复用历史经验。', output: 'Codex Thread' },
  { icon: BrainCircuit, title: '排队执行', text: '任务先写入 SQLite；同一 Channel 串行进入 Codex，读取代码、知识并调用允许的工具。', output: '证据与结论' },
  { icon: Sparkles, title: '回复与沉淀', text: '飞书卡片持续展示处理进度，完成后保存回复、耗时、路由快照和经验画像。', output: '可追溯结果' },
]

const promptLayers = [
  ['平台', '所有 Agent 共同遵守的安全与表达规范'], ['工作区', '项目边界、代码结构、知识库与通用工作方法'],
  ['Bot', '该机器人的角色、默认行为和权限约束'], ['场景', '当前业务问题的目标、判断口径和输出要求'],
  ['技能包', '专项 Skill、调查步骤与领域知识补充'],
]

const example = [
  ['输入', '告警卡片进入群聊', '卡片标题包含 Argos-CRITICAL，正文携带服务名、规则、时间和异常指标。'],
  ['路由', '命中“预算告警初判”', '系统根据群 ID 与卡片标题，选择 AI Hub 工作区、告警技能包和指定模型。'],
  ['调查', 'Codex 主动收集证据', '读取相关代码与知识，查询日志、数据库或指标；Skill 不完整时继续基于现状探索。'],
  ['交付', '飞书中持续更新结果', '先反馈处理状态，完成后给出结论、事实时间线、判断依据、建议动作和未闭合项。'],
]

const outcomes = [
  ['fresh', '低于经验阈值', '全新处理', '创建新的 Codex Thread，从当前证据独立调查。'],
  ['reference', '达到经验阈值', '引用历史经验', '创建新 Thread，同时注入相似问题的特征、证据与历史结论。'],
  ['reuse', '达到复用阈值', '继续历史会话', '进入原 Codex Thread，直接使用完整调查上下文和已有工具记录。'],
]

const operations = [
  { icon: Gauge, title: '运行总览', text: '观察累计处理、每日趋势、失败率、平均耗时、群与场景分布。', to: '/', action: '打开总览' },
  { icon: Search, title: '消息记录', text: '从一条飞书消息追到场景、模型、技能包、Thread、回复和错误。', to: '/messages', action: '检索消息' },
  { icon: GitBranch, title: '会话线程', text: '查看群/话题与 Codex Thread 的关系、任务数量以及最后活跃时间。', to: '/conversation-threads', action: '查看线程' },
  { icon: History, title: '操作记录', text: '追溯账号与配置变更，确认是谁在什么时间修改了什么内容。', to: '/audit-logs', action: '查看审计' },
]

onMounted(() => {
  if (!('IntersectionObserver' in window)) return
  observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
    if (visible?.target.id) activeSection.value = visible.target.id
  }, { rootMargin: '-18% 0px -66% 0px', threshold: [0, .1, .35] })
  document.querySelectorAll<HTMLElement>('.guide-section').forEach(section => observer?.observe(section))
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="page guide-page">
    <section class="guide-hero" aria-labelledby="guide-title">
      <div class="hero-grid" aria-hidden="true" />
      <div class="hero-copy">
        <div class="hero-status"><span />CODYBOTHUB · SYSTEM HANDBOOK</div>
        <h1 id="guide-title">让飞书里的每条消息，<b>进入正确的 AI 工作流</b></h1>
        <p>CodyBotHub 是连接飞书与 Codex 的企业 Agent 控制台。它负责识别业务场景、装配代码与知识、管理会话边界、可靠执行任务，并把每次结果沉淀成可追溯、可复用的经验。</p>
        <div class="hero-actions"><RouterLink class="button" to="/workspaces"><Rocket :size="17" />开始接入第一个 Bot</RouterLink><a class="ghost-button" href="#architecture"><BookOpenCheck :size="17" />理解系统架构</a></div>
        <div class="assurances"><span><Check :size="14" />本地工作区边界</span><span><Check :size="14" />SQLite 持久队列</span><span><Check :size="14" />完整审计链路</span></div>
      </div>
      <div class="hero-console" aria-label="实时消息处理链路">
        <div class="console-bar"><i /><i /><i /><small>LIVE MESSAGE PIPELINE</small><em>ONLINE</em></div>
        <div class="console-message"><div class="message-avatar"><MessageSquareText :size="20" /></div><div><small>飞书告警卡片 · 10:24:07</small><strong>【Argos-CRITICAL】支付预算流水异常</strong><span>群：营销预算告警群</span></div></div>
        <div class="console-route"><span><Route :size="14" />预算告警初判</span><ChevronRight :size="15" /><span><FolderRoot :size="14" />AI Hub</span></div>
        <div class="console-agent">
          <header><div><BrainCircuit :size="18" /><strong>Codex investigation</strong></div><span>RUNNING</span></header>
          <p><i class="done"><Check :size="11" /></i><span>读取告警上下文与历史经验</span><code>0.8s</code></p>
          <p><i class="done"><Check :size="11" /></i><span>查询日志、代码与数据记录</span><code>18.4s</code></p>
          <p><i><CircleDot :size="11" /></i><span>组织证据链与处置建议</span><code>...</code></p>
        </div>
        <footer><span><Database :size="13" />任务已持久化</span><span><GitBranch :size="13" />Thread 已绑定</span></footer>
      </div>
    </section>

    <section class="proof-strip"><div><strong>5 层</strong><span>Prompt 按职责叠加</span></div><div><strong>3 种</strong><span>经验复用决策</span></div><div><strong>1 条</strong><span>消息到结论的审计链</span></div><div><strong>0 丢失</strong><span>任务先落库再执行</span></div></section>

    <div class="guide-layout">
      <aside class="guide-nav" aria-label="系统介绍目录">
        <div class="nav-heading"><Network :size="15" />阅读导航</div>
        <a v-for="item in navigation" :key="item[0]" :href="`#${item[0]}`" :class="{ active: activeSection === item[0] }"><span>{{ item[1] }}</span><ChevronRight :size="13" /></a>
        <div class="nav-help"><Sparkles :size="15" /><p>第一次使用？从“按角色使用”开始，只看与你有关的步骤。</p></div>
      </aside>

      <main class="guide-content">
        <section id="overview" class="guide-section">
          <header class="section-heading"><div><p>01 · SYSTEM POSITIONING</p><h2>它不是一个聊天机器人，<br />而是一套 Agent 运行系统</h2></div><p>普通 Bot 只负责把问题转发给模型。CodyBotHub 还负责决定模型在什么边界里工作、携带哪些业务知识、使用哪个历史会话，以及整个过程如何恢复和审计。</p></header>
          <div class="value-grid"><article v-for="item in values" :key="item.title"><div class="card-icon"><component :is="item.icon" :size="20" /></div><h3>{{ item.title }}</h3><p>{{ item.text }}</p></article></div>
          <div class="callout"><Bot :size="24" /><div><strong>一句话理解</strong><p>飞书是入口，工作区是边界，场景是路由，技能包是能力，Thread 是记忆，Codex 是执行者，CodyBotHub 把它们组织成一条可靠的生产链路。</p></div></div>
        </section>

        <section id="architecture" class="guide-section">
          <header class="section-heading"><div><p>02 · ARCHITECTURE</p><h2>三层架构，各自解决一个核心问题</h2></div><p>管理、执行和经验分层后，业务配置不会侵入 Codex 底座，飞书接入也不会和具体 Skill 紧耦合。</p></header>
          <div class="plane-stack"><article v-for="(plane, index) in planes" :key="plane.title"><span class="plane-index">0{{ index + 1 }}</span><div class="plane-title"><div class="card-icon"><component :is="plane.icon" :size="20" /></div><div><small>{{ plane.tag }}</small><h3>{{ plane.title }}</h3></div></div><p>{{ plane.text }}</p><ul><li v-for="item in plane.items" :key="item"><CheckCircle2 :size="14" />{{ item }}</li></ul></article></div>
          <div class="foundation"><Database :size="20" /><div><strong>SQLite 是可靠性底座</strong><p>配置、消息、路由快照、队列任务、回复、Thread 映射和审计记录统一持久化。进程重启后，未完成的排队任务能够继续执行。</p></div><span>LOCAL · TRANSACTIONAL · RECOVERABLE</span></div>
        </section>

        <section id="configuration" class="guide-section">
          <header class="section-heading"><div><p>03 · CONFIGURATION MODEL</p><h2>先看懂对象关系，再开始配置</h2></div><p>工作区独立存在；Bot 必须挂工作区；场景必须从该 Bot 已关联的工作区中选择一个；技能包在场景执行时提供专项能力。</p></header>
          <div class="relation-board">
            <div class="relation-column"><span>资源边界</span><RouterLink class="relation-card" to="/workspaces"><FolderRoot :size="20" /><div><strong>工作区</strong><small>本地目录 · Prompt · 权限 · 知识</small></div><em>独立创建</em></RouterLink></div>
            <div class="relation-arrow"><small>关联一个或多个</small><ArrowRight :size="22" /></div>
            <div class="relation-column"><span>接入与默认策略</span><RouterLink class="relation-card" to="/bots"><Bot :size="20" /><div><strong>飞书 Bot</strong><small>凭据 · 默认工作区 · 会话模式 · 模型</small></div><em>必须选工作区</em></RouterLink></div>
            <div class="relation-arrow"><small>消息命中</small><ArrowRight :size="22" /></div>
            <div class="relation-column"><span>业务编排</span><RouterLink class="relation-card mini" to="/scenes"><Workflow :size="20" /><div><strong>场景路由</strong><small>群 · 匹配器 · 唯一工作区</small></div></RouterLink><RouterLink class="relation-card mini" to="/packages"><Puzzle :size="20" /><div><strong>技能包</strong><small>Skill · Prompt · 工具包授权</small></div></RouterLink></div>
            <div class="relation-arrow"><small>创建或复用</small><ArrowRight :size="22" /></div>
            <div class="relation-column"><span>持续执行上下文</span><RouterLink class="relation-card" to="/conversation-threads"><GitBranch :size="20" /><div><strong>Thread Channel</strong><small>群/话题边界 · 队列 · Codex Thread</small></div><em>串行执行</em></RouterLink></div>
          </div>
          <div class="prompt-composer"><div><small>FINAL CONTEXT</small><h3>最终 Prompt 不是一段巨大的配置</h3><p>规则按作用范围逐层叠加。越靠后的内容越接近当前任务，公共要求无需在每个场景里重复维护。</p></div><div class="layer-list"><div v-for="(layer, index) in promptLayers" :key="layer[0]"><span>0{{ index + 1 }}</span><strong>{{ layer[0] }} Prompt</strong><p>{{ layer[1] }}</p></div></div></div>
        </section>

        <section id="journeys" class="guide-section">
          <header class="section-heading"><div><p>04 · GET STARTED BY ROLE</p><h2>你现在要做什么？</h2></div><p>不需要从头读完整个平台。选择你的角色，按四步完成当前目标。</p></header>
          <div class="role-tabs" role="tablist"><button v-for="(role, key) in roles" :key="key" :class="{ active: activeRole === key }" role="tab" :aria-selected="activeRole === key" @click="activeRole = key">{{ role.label }}</button></div>
          <div class="journey-panel"><div class="journey-intro"><span>{{ roles[activeRole].label }}</span><h3>{{ roles[activeRole].title }}</h3><p>{{ roles[activeRole].description }}</p></div><ol><li v-for="(step, index) in roles[activeRole].steps" :key="step[0]"><span>{{ index + 1 }}</span><div><h4>{{ step[0] }}</h4><p>{{ step[1] }}</p></div><RouterLink :to="step[2]">{{ step[3] }}<ArrowRight :size="14" /></RouterLink></li></ol></div>
        </section>

        <section id="pipeline" class="guide-section">
          <header class="section-heading"><div><p>05 · MESSAGE LIFECYCLE</p><h2>一条消息怎样变成可交付的结果</h2></div><p>每一步都有明确输入和输出，并保存到消息记录中。出现问题时，可以准确知道失败发生在哪一层。</p></header>
          <div class="pipeline-list"><article v-for="(step, index) in pipeline" :key="step.title"><span class="pipeline-number">0{{ index + 1 }}</span><div class="pipeline-icon"><component :is="step.icon" :size="20" /></div><div><h3>{{ step.title }}</h3><p>{{ step.text }}</p></div><small>OUTPUT · {{ step.output }}</small></article></div>
          <div class="fallback-grid"><article><CheckCircle2 :size="18" /><div><strong>没有命中场景</strong><p>用户可选择场景；暂不选择时，仍可在默认工作区继续对话。</p></div></article><article><TimerReset :size="18" /><div><strong>同一 Thread 正在执行</strong><p>新消息与工具包都进入持久队列，等待当前任务结束后串行执行。</p></div></article><article><ShieldCheck :size="18" /><div><strong>工具包需要确认</strong><p>飞书卡片校验操作人后执行，并把真实接口结果续写回原 Codex Thread。</p></div></article></div>
        </section>

        <section id="example" class="guide-section">
          <header class="section-heading"><div><p>06 · REAL-WORLD EXAMPLE</p><h2>以一条线上告警为例</h2></div><p>下面是一条告警从进入飞书，到产出可执行排查结论的完整过程。</p></header>
          <div class="example-layout"><div class="example-card"><header><span>FEISHU · INTERACTIVE CARD</span><em>10:24</em></header><h3>【Argos-CRITICAL】【华北】支付预算流水异常</h3><dl><div><dt>服务</dt><dd>life.marketing.budget</dd></div><div><dt>规则</dt><dd>状态更新时间晚于 5min</dd></div><div><dt>样本</dt><dd>record_id=7686727454044245034</dd></div></dl><span class="reaction"><Check :size="14" />机器人已收到，开始处理</span></div><div class="example-timeline"><article v-for="(step, index) in example" :key="step[0]"><span>{{ index + 1 }}</span><div><small>{{ step[0] }}</small><h3>{{ step[1] }}</h3><p>{{ step[2] }}</p></div></article></div></div>
          <div class="answer-anatomy"><div><FileSearch :size="21" /><span><small>EXPECTED DELIVERY</small><strong>一份合格结果应该能让人复核</strong></span></div><div class="answer-parts"><span>结论</span><span>配置 / 数据事实</span><span>运行现象</span><span>判断依据</span><span>建议动作</span><span>未闭合项</span></div><p>系统不要求 Skill 覆盖所有情况。Skill 提供首选路径；信息不足时，Codex 仍可结合代码、知识库、日志和当前证据继续调查，并明确哪些部分尚未闭合。</p></div>
        </section>

        <section id="threads" class="guide-section">
          <header class="section-heading"><div><p>07 · THREAD & EXPERIENCE</p><h2>Thread 管连续对话，画像管跨会话经验</h2></div><p>Thread 保存完整执行上下文；经验画像把已完成问题压缩成可比较的结构化特征与结论。</p></header>
          <div class="thread-model"><article><div class="card-icon"><MessageSquareText :size="20" /></div><span>基础会话边界</span><h3>Bot + 群，或 Bot + 群 + 话题</h3><p>由 Bot 会话模式决定。话题模式下，同一话题中的后续 @ 会继续进入原 Channel。</p></article><ArrowRight :size="22" /><article><div class="card-icon"><GitBranch :size="20" /></div><span>Thread Channel</span><h3>持久映射 + 串行队列</h3><p>Channel 保存 Codex Thread 关系。同一 Channel 同时只运行一个任务，其余消息安全排队。</p></article><ArrowRight :size="22" /><article><div class="card-icon"><BrainCircuit :size="20" /></div><span>经验路由</span><h3>只在同一业务范围比较</h3><p>候选经验限定在同一 Bot、工作区和场景，再结合结构化特征、文本相似度与时间衰减评分。</p></article></div>
          <div class="outcome-grid"><article v-for="item in outcomes" :key="item[2]" :class="item[0]"><span>{{ item[1] }}</span><h3>{{ item[2] }}</h3><p>{{ item[3] }}</p></article></div><RouterLink class="inline-cta" to="/thread-routing">查看当前画像、规则和复用记录<ArrowRight :size="15" /></RouterLink>
        </section>

        <section id="operations" class="guide-section">
          <header class="section-heading"><div><p>08 · OPERATIONS</p><h2>上线之后，四个页面管住全链路</h2></div><p>先从总览判断是否异常，再逐层下钻到消息、Thread 和配置变更。</p></header>
          <div class="ops-grid"><RouterLink v-for="item in operations" :key="item.title" :to="item.to"><div class="card-icon"><component :is="item.icon" :size="20" /></div><h3>{{ item.title }}</h3><p>{{ item.text }}</p><span>{{ item.action }}<ArrowRight :size="14" /></span></RouterLink></div>
          <div class="trust-grid"><article><LockKeyhole :size="19" /><div><strong>权限可控</strong><p>工作区限定文件范围，Bot 与场景配置允许的工具、网络和操作人。</p></div></article><article><Eye :size="19" /><div><strong>过程可见</strong><p>消息、路由、模型、Skill、Thread、耗时、回复与错误都能查询。</p></div></article><article><Database :size="19" /><div><strong>任务可恢复</strong><p>先落库再执行；重启和排空期间的任务不会因为进程切换而消失。</p></div></article></div>
          <div class="closing"><div><p>READY TO BUILD</p><h2>从一个真实场景开始，而不是从一堆配置开始</h2><span>选择一个工作区，接入 Bot，再用一条真实飞书消息验证完整链路。成功之后，把同一套工作方式复制给更多场景和团队。</span></div><div><RouterLink class="button" to="/workspaces">开始配置<ArrowRight :size="16" /></RouterLink><RouterLink class="ghost-button" to="/messages">查看现有消息</RouterLink></div></div>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.guide-page{max-width:1540px}.guide-hero{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(420px,.9fr);gap:68px;align-items:center;min-height:570px;padding:62px;background:linear-gradient(128deg,color-mix(in srgb,var(--primary) 13%,transparent),transparent 44%),linear-gradient(320deg,color-mix(in srgb,var(--cyan) 7%,transparent),transparent 48%),var(--surface);border:1px solid var(--border);border-radius:24px;box-shadow:var(--shadow)}.guide-hero:before{content:'';position:absolute;z-index:-1;right:-180px;top:-220px;width:520px;height:520px;background:radial-gradient(circle,color-mix(in srgb,var(--primary) 22%,transparent),transparent 68%)}.hero-grid{position:absolute;inset:0;z-index:-1;opacity:.23;background-image:linear-gradient(color-mix(in srgb,var(--border) 55%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--border) 55%,transparent) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(90deg,#000,transparent 76%)}.hero-status{display:inline-flex;align-items:center;gap:9px;color:var(--cyan);font:750 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em}.hero-status span{width:7px;height:7px;background:var(--green);border-radius:50%;box-shadow:0 0 0 5px color-mix(in srgb,var(--green) 12%,transparent),0 0 18px var(--green)}.hero-copy h1{max-width:800px;margin:20px 0 0;font-size:clamp(42px,4.7vw,68px);line-height:1.06;letter-spacing:-.055em}.hero-copy h1 b{display:block;color:var(--primary);text-shadow:0 0 28px color-mix(in srgb,var(--primary) 22%,transparent)}.hero-copy>p{max-width:780px;margin:25px 0 0;color:var(--text-soft);font-size:16px;line-height:1.85}.hero-actions,.assurances{display:flex;flex-wrap:wrap;gap:11px;margin-top:30px}.hero-actions a{text-decoration:none}.assurances{gap:18px;margin-top:24px;color:var(--muted);font-size:12px}.assurances span{display:flex;align-items:center;gap:6px}.assurances svg{color:var(--green)}
.hero-console{overflow:hidden;padding:0 19px 18px;background:color-mix(in srgb,var(--surface-input) 91%,transparent);border:1px solid var(--primary-border);border-radius:18px;box-shadow:0 28px 70px rgba(0,0,0,.25);backdrop-filter:blur(18px)}.console-bar{height:47px;display:flex;align-items:center;gap:6px;margin:0 -19px 17px;padding:0 17px;border-bottom:1px solid var(--border)}.console-bar i{width:7px;height:7px;background:var(--border-strong);border-radius:50%}.console-bar i:first-child{background:var(--danger)}.console-bar i:nth-child(2){background:var(--warning)}.console-bar i:nth-child(3){background:var(--green)}.console-bar small{margin-left:7px;color:var(--muted);font:700 9px ui-monospace,monospace;letter-spacing:.1em}.console-bar em{margin-left:auto;color:var(--green);font:700 8px ui-monospace,monospace;font-style:normal}.console-message{display:grid;grid-template-columns:42px 1fr;gap:12px;padding:14px;background:var(--surface-raised);border:1px solid var(--border);border-radius:12px}.message-avatar{width:42px;height:42px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border:1px solid var(--primary-border);border-radius:11px}.console-message small,.console-message strong,.console-message span{display:block}.console-message small,.console-message span{color:var(--muted);font-size:9px}.console-message strong{margin:6px 0;font-size:12px}.console-route{height:56px;display:flex;align-items:center;justify-content:center;gap:8px;color:var(--muted)}.console-route span{display:flex;align-items:center;gap:6px;padding:7px 9px;color:var(--text-soft);background:var(--surface-raised);border:1px solid var(--border);border-radius:8px;font-size:9px}.console-route span svg{color:var(--primary)}.console-agent{padding:15px;background:linear-gradient(135deg,var(--primary-soft),transparent 55%),var(--surface-raised);border:1px solid var(--primary-border);border-radius:12px}.console-agent header,.console-agent header div,.console-agent p,.hero-console footer{display:flex;align-items:center}.console-agent header{justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--border)}.console-agent header div{gap:8px}.console-agent header svg{color:var(--primary)}.console-agent header strong{font-size:11px}.console-agent header>span{color:var(--cyan);font:700 8px ui-monospace,monospace}.console-agent p{gap:9px;margin:11px 0 0;color:var(--muted);font-size:9px}.console-agent p i{width:18px;height:18px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-radius:50%}.console-agent p i.done{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent)}.console-agent p span{flex:1}.console-agent code{font-size:8px}.hero-console footer{justify-content:space-between;padding-top:14px;color:var(--muted);font-size:8px}.hero-console footer span{display:flex;align-items:center;gap:5px}
.proof-strip{display:grid;grid-template-columns:repeat(4,1fr);margin:16px 0 46px;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-soft)}.proof-strip div{padding:22px 25px;border-left:1px solid var(--border)}.proof-strip div:first-child{border-left:0}.proof-strip strong,.proof-strip span{display:block}.proof-strip strong{font:760 23px ui-monospace,monospace}.proof-strip span{margin-top:7px;color:var(--muted);font-size:11px}.guide-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:52px;align-items:start}.guide-nav{position:sticky;top:24px;display:grid;gap:3px;padding:12px;background:color-mix(in srgb,var(--surface) 92%,transparent);border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow-soft);backdrop-filter:blur(18px)}.nav-heading{display:flex;align-items:center;gap:8px;padding:8px 10px 12px;color:var(--text-soft);border-bottom:1px solid var(--border);font-size:12px;font-weight:700}.nav-heading svg{color:var(--primary)}.guide-nav>a{display:flex;align-items:center;justify-content:space-between;min-height:39px;padding:0 10px;color:var(--muted);border:1px solid transparent;border-radius:8px;font-size:11px;text-decoration:none;transition:.18s}.guide-nav>a svg{opacity:0}.guide-nav>a:hover,.guide-nav>a.active{color:var(--text);background:var(--primary-soft);border-color:var(--primary-border)}.guide-nav>a:hover svg,.guide-nav>a.active svg{opacity:1}.nav-help{display:flex;gap:9px;margin-top:7px;padding:12px 10px;color:var(--muted);background:var(--surface-raised);border-radius:9px}.nav-help svg{flex:none;color:var(--primary)}.nav-help p{margin:0;font-size:9px;line-height:1.55}.guide-content{min-width:0}.guide-section{scroll-margin-top:24px;padding:12px 0 76px}.guide-section+.guide-section{padding-top:68px;border-top:1px solid var(--border)}.section-heading{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.65fr);gap:52px;align-items:end;margin-bottom:29px}.section-heading>div>p,.closing>div>p{margin:0 0 11px;color:var(--primary);font:750 10px ui-monospace,monospace;letter-spacing:.14em}.section-heading h2{max-width:800px;margin:0;font-size:clamp(28px,3.2vw,40px);line-height:1.2;letter-spacing:-.04em}.section-heading>p{margin:0;color:var(--muted);font-size:13px;line-height:1.75}
.value-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:13px}.value-grid article,.plane-stack article,.thread-model article,.ops-grid>a{background:var(--surface);border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow-soft)}.value-grid article{min-height:190px;padding:24px;transition:.18s}.value-grid article:hover,.ops-grid>a:hover,.relation-card:hover{transform:translateY(-2px);border-color:var(--primary-border)}.card-icon{width:40px;height:40px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border:1px solid var(--primary-border);border-radius:11px}.value-grid h3{margin:21px 0 9px;font-size:15px}.value-grid p{margin:0;color:var(--muted);font-size:12px;line-height:1.72}.callout{display:flex;align-items:center;gap:17px;margin-top:14px;padding:20px 22px;background:linear-gradient(100deg,var(--primary-soft),transparent 70%),var(--surface);border:1px solid var(--primary-border);border-radius:14px}.callout>svg{flex:none;color:var(--cyan)}.callout strong{font-size:12px}.callout p{margin:6px 0 0;color:var(--text-soft);font-size:12px;line-height:1.65}
.plane-stack{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.plane-stack article{position:relative;overflow:hidden;padding:25px}.plane-index{position:absolute;right:18px;top:13px;color:color-mix(in srgb,var(--muted) 35%,transparent);font:800 42px ui-monospace,monospace}.plane-title{position:relative;display:flex;align-items:center;gap:13px}.plane-title small{color:var(--primary);font:700 8px ui-monospace,monospace;letter-spacing:.12em}.plane-title h3{margin:5px 0 0;font-size:15px}.plane-stack article>p{min-height:62px;margin:20px 0;color:var(--muted);font-size:11px;line-height:1.7}.plane-stack ul{display:grid;gap:9px;margin:0;padding:16px 0 0;border-top:1px solid var(--border);list-style:none}.plane-stack li{display:flex;align-items:center;gap:8px;color:var(--text-soft);font-size:10px}.plane-stack li svg{color:var(--green)}.foundation{display:grid;grid-template-columns:auto 1fr auto;gap:15px;align-items:center;margin-top:14px;padding:19px 22px;background:var(--surface-input);border:1px solid var(--border);border-radius:13px}.foundation>svg{color:var(--primary)}.foundation strong{font-size:12px}.foundation p{margin:5px 0 0;color:var(--muted);font-size:10px}.foundation>span{color:var(--muted);font:700 8px ui-monospace,monospace;letter-spacing:.1em}
.relation-board{display:grid;grid-template-columns:1fr auto 1fr auto 1.15fr auto 1fr;gap:10px;align-items:center;padding:22px;background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 5%,transparent),transparent 55%),var(--surface-input);border:1px solid var(--border);border-radius:17px}.relation-column{display:grid;gap:8px}.relation-column>span{color:var(--muted);font:700 8px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}.relation-card{min-height:108px;display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;padding:15px;color:var(--text);background:var(--surface-raised);border:1px solid var(--border);border-radius:12px;text-decoration:none;transition:.18s}.relation-card.mini{min-height:75px}.relation-card>svg{color:var(--primary)}.relation-card strong,.relation-card small{display:block}.relation-card strong{font-size:12px}.relation-card small{margin-top:5px;color:var(--muted);font-size:8px}.relation-card em{grid-column:1/-1;align-self:end;color:var(--primary);font:700 8px ui-monospace,monospace;font-style:normal}.relation-arrow{display:grid;place-items:center;gap:7px;color:var(--primary)}.relation-arrow small{max-width:65px;color:var(--muted);font-size:8px;text-align:center}.prompt-composer{display:grid;grid-template-columns:.62fr 1.38fr;gap:34px;margin-top:15px;padding:25px;background:linear-gradient(110deg,var(--primary-soft),transparent 48%),var(--surface);border:1px solid var(--primary-border);border-radius:16px}.prompt-composer>div>small{color:var(--cyan);font:700 9px ui-monospace,monospace}.prompt-composer h3{margin:12px 0 9px;font-size:18px}.prompt-composer>div>p{margin:0;color:var(--muted);font-size:11px;line-height:1.7}.layer-list{display:grid;gap:6px}.layer-list>div{display:grid;grid-template-columns:26px 125px 1fr;gap:10px;align-items:center;padding:10px 12px;background:var(--surface-raised);border:1px solid var(--border);border-radius:9px}.layer-list span{color:var(--primary);font:700 9px ui-monospace,monospace}.layer-list strong{font-size:10px}.layer-list p{margin:0;color:var(--muted);font-size:9px}
.role-tabs{display:inline-flex;gap:5px;margin-bottom:13px;padding:5px;background:var(--surface);border:1px solid var(--border);border-radius:12px}.role-tabs button{min-height:40px;padding:0 16px;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer}.role-tabs button.active{color:var(--text);background:var(--primary-soft);border-color:var(--primary-border)}.journey-panel{display:grid;grid-template-columns:.6fr 1.4fr;gap:36px;padding:27px;background:var(--surface);border:1px solid var(--border);border-radius:17px;box-shadow:var(--shadow-soft)}.journey-intro{padding:7px 8px}.journey-intro>span{color:var(--primary);font:700 9px ui-monospace,monospace}.journey-intro h3{margin:14px 0 10px;font-size:22px}.journey-intro p{margin:0;color:var(--muted);font-size:12px;line-height:1.7}.journey-panel ol{display:grid;margin:0;padding:0;list-style:none}.journey-panel li{display:grid;grid-template-columns:28px 1fr auto;gap:13px;align-items:center;padding:15px 0;border-top:1px solid var(--border)}.journey-panel li:first-child{border-top:0}.journey-panel li>span{width:26px;height:26px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-radius:8px;font:700 10px ui-monospace,monospace}.journey-panel h4{margin:0 0 5px;font-size:12px}.journey-panel li p{margin:0;color:var(--muted);font-size:10px}.journey-panel a,.inline-cta{display:inline-flex;align-items:center;gap:5px;color:var(--primary);font-size:10px;font-weight:700;text-decoration:none;white-space:nowrap}
.pipeline-list{display:grid;gap:9px}.pipeline-list article{display:grid;grid-template-columns:52px 42px 1fr auto;gap:14px;align-items:center;min-height:104px;padding:16px 19px 16px 0;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-soft)}.pipeline-number{align-self:stretch;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-right:1px solid var(--primary-border);font:750 10px ui-monospace,monospace}.pipeline-icon{width:40px;height:40px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-radius:10px}.pipeline-list h3{margin:0 0 6px;font-size:13px}.pipeline-list p{margin:0;color:var(--muted);font-size:10px;line-height:1.6}.pipeline-list article>small{padding:7px 9px;color:var(--cyan);background:color-mix(in srgb,var(--cyan) 6%,transparent);border:1px solid color-mix(in srgb,var(--cyan) 18%,transparent);border-radius:7px;font:700 8px ui-monospace,monospace;white-space:nowrap}.fallback-grid,.trust-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:13px}.fallback-grid article,.trust-grid article{display:flex;gap:11px;padding:16px;background:var(--surface-raised);border:1px solid var(--border);border-radius:11px}.fallback-grid svg,.trust-grid svg{flex:none;color:var(--green)}.fallback-grid strong,.trust-grid strong{font-size:10px}.fallback-grid p,.trust-grid p{margin:5px 0 0;color:var(--muted);font-size:9px;line-height:1.55}
.example-layout{display:grid;grid-template-columns:.78fr 1.22fr;gap:15px}.example-card{padding:24px;background:linear-gradient(150deg,color-mix(in srgb,var(--danger) 7%,transparent),transparent 45%),var(--surface);border:1px solid color-mix(in srgb,var(--danger) 23%,var(--border));border-radius:16px}.example-card header{display:flex;justify-content:space-between;color:var(--muted);font:700 8px ui-monospace,monospace}.example-card header em{color:var(--danger);font-style:normal}.example-card h3{margin:22px 0;font-size:17px;line-height:1.5}.example-card dl{display:grid;gap:8px;margin:0}.example-card dl>div{display:grid;grid-template-columns:54px 1fr;gap:8px;padding:10px;background:var(--surface-raised);border-radius:8px}.example-card dt{color:var(--muted);font-size:9px}.example-card dd{overflow:hidden;margin:0;font:600 9px ui-monospace,monospace;text-overflow:ellipsis}.reaction{display:inline-flex;align-items:center;gap:7px;margin-top:18px;padding:8px 10px;color:var(--green);background:color-mix(in srgb,var(--green) 8%,transparent);border-radius:8px;font-size:9px}.example-timeline{display:grid;gap:8px}.example-timeline article{display:grid;grid-template-columns:30px 1fr;gap:13px;padding:16px 18px;background:var(--surface);border:1px solid var(--border);border-radius:12px}.example-timeline article>span{width:28px;height:28px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-radius:8px;font:700 9px ui-monospace,monospace}.example-timeline small{color:var(--primary);font:700 8px ui-monospace,monospace}.example-timeline h3{margin:6px 0;font-size:12px}.example-timeline p{margin:0;color:var(--muted);font-size:10px;line-height:1.55}.answer-anatomy{display:grid;grid-template-columns:.65fr 1.35fr;gap:18px 30px;margin-top:14px;padding:23px;background:linear-gradient(110deg,var(--primary-soft),transparent 48%),var(--surface);border:1px solid var(--primary-border);border-radius:15px}.answer-anatomy>div:first-child{display:flex;align-items:center;gap:12px}.answer-anatomy>div:first-child svg{color:var(--primary)}.answer-anatomy small,.answer-anatomy strong{display:block}.answer-anatomy small{color:var(--muted);font:700 8px ui-monospace,monospace}.answer-anatomy strong{margin-top:5px;font-size:14px}.answer-parts{display:flex;flex-wrap:wrap;gap:7px;align-content:center}.answer-parts span{padding:7px 9px;background:var(--surface-raised);border:1px solid var(--border);border-radius:7px;font-size:9px}.answer-anatomy>p{grid-column:1/-1;margin:0;padding-top:16px;color:var(--muted);border-top:1px solid var(--border);font-size:11px;line-height:1.7}
.thread-model{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:13px;align-items:center}.thread-model>svg{color:var(--primary)}.thread-model article{min-height:218px;padding:22px}.thread-model article>span{display:block;margin-top:17px;color:var(--primary);font:700 8px ui-monospace,monospace}.thread-model h3{margin:9px 0;font-size:14px;line-height:1.45}.thread-model p{margin:0;color:var(--muted);font-size:10px;line-height:1.65}.outcome-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin:13px 0 17px}.outcome-grid article{padding:20px;background:var(--surface-raised);border:1px solid var(--border);border-top:3px solid var(--muted);border-radius:12px}.outcome-grid .reference{border-top-color:var(--primary)}.outcome-grid .reuse{border-top-color:var(--green)}.outcome-grid span{color:var(--muted);font:700 8px ui-monospace,monospace}.outcome-grid h3{margin:14px 0 7px;font-size:13px}.outcome-grid p{margin:0;color:var(--muted);font-size:10px;line-height:1.6}
.ops-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px}.ops-grid>a{display:block;padding:21px;color:var(--text);text-decoration:none;transition:.18s}.ops-grid h3{margin:18px 0 8px;font-size:13px}.ops-grid p{min-height:68px;margin:0 0 16px;color:var(--muted);font-size:10px;line-height:1.6}.ops-grid>a>span{display:flex;align-items:center;gap:5px;color:var(--primary);font-size:10px;font-weight:700}.closing{display:flex;align-items:end;justify-content:space-between;gap:40px;margin-top:15px;padding:32px;background:linear-gradient(120deg,color-mix(in srgb,var(--primary) 14%,transparent),transparent 54%),var(--surface);border:1px solid var(--primary-border);border-radius:18px}.closing h2{max-width:760px;margin:0;font-size:25px}.closing>div>span{display:block;max-width:820px;margin-top:12px;color:var(--muted);font-size:11px;line-height:1.7}.closing>div:last-child{display:flex;flex:none;gap:9px}.closing a{text-decoration:none}
@media(max-width:1260px){.guide-hero{grid-template-columns:1fr}.hero-console{max-width:760px}.guide-layout{grid-template-columns:1fr}.guide-nav{top:8px;z-index:5;display:flex;overflow-x:auto;padding:6px}.nav-heading,.nav-help{display:none}.guide-nav>a{flex:none}.relation-board{grid-template-columns:1fr}.relation-arrow{min-height:45px}.relation-arrow svg{transform:rotate(90deg)}.relation-arrow small{max-width:none}.ops-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:900px){.guide-hero{padding:42px 30px}.proof-strip,.plane-stack,.fallback-grid,.trust-grid{grid-template-columns:repeat(2,1fr)}.proof-strip div:nth-child(3){border-left:0;border-top:1px solid var(--border)}.proof-strip div:nth-child(4){border-top:1px solid var(--border)}.section-heading,.journey-panel,.prompt-composer,.answer-anatomy{grid-template-columns:1fr;gap:20px}.answer-anatomy>p{grid-column:auto}.thread-model{grid-template-columns:1fr}.thread-model>svg{justify-self:center;transform:rotate(90deg)}.thread-model article{min-height:0}.closing{align-items:stretch;flex-direction:column}}
@media(max-width:680px){.guide-hero{min-height:0;padding:31px 21px;border-radius:18px}.hero-copy h1{font-size:39px}.hero-copy>p{font-size:14px}.hero-actions,.closing>div:last-child{align-items:stretch;flex-direction:column}.hero-actions a,.closing a{justify-content:center}.assurances{display:grid;gap:8px}.hero-console{padding:0 12px 13px}.console-bar{margin:0 -12px 13px}.console-route{flex-wrap:wrap}.hero-console footer{align-items:flex-start;flex-direction:column;gap:7px}.proof-strip,.value-grid,.plane-stack,.fallback-grid,.outcome-grid,.ops-grid,.trust-grid{grid-template-columns:1fr}.proof-strip div{border-top:1px solid var(--border);border-left:0}.proof-strip div:first-child{border-top:0}.section-heading h2{font-size:30px}.foundation{grid-template-columns:auto 1fr}.foundation>span{grid-column:1/-1}.layer-list>div{grid-template-columns:24px 1fr}.layer-list p{grid-column:2}.role-tabs{display:flex;overflow-x:auto}.role-tabs button{flex:none}.journey-panel{padding:20px 17px}.journey-panel li{grid-template-columns:28px 1fr}.journey-panel a{grid-column:2}.pipeline-list article{grid-template-columns:44px 36px 1fr;padding-right:13px}.pipeline-list article>small{grid-column:2/-1;justify-self:start}.example-layout{grid-template-columns:1fr}.closing{padding:24px 21px}}
@media(prefers-reduced-motion:reduce){.value-grid article,.ops-grid>a,.relation-card,.guide-nav>a{transition:none}}
</style>
