<script setup lang="ts">
import { Activity, ArrowRight, BookOpenCheck, Bot, Boxes, BrainCircuit, CheckCircle2, Code2, Database, FolderRoot, GitBranch, Layers3, LockKeyhole, MessageSquareText, Puzzle, Rocket, ShieldCheck, Sparkles, Workflow } from 'lucide-vue-next'

const setupSteps = [
  { number: '01', title: '创建工作区', text: '指向一个本地代码目录。Codex 会在这个边界内读取代码、知识库和 Skill。', to: '/workspaces', action: '配置工作区' },
  { number: '02', title: '接入飞书 Bot', text: '填写已有应用凭证，选择默认工作区、会话模式、模型和操作人。', to: '/bots', action: '配置 Bot' },
  { number: '03', title: '定义场景路由', text: '用群、消息类型、文本或卡片标题匹配业务场景，并指定工作区与 Prompt。', to: '/scenes', action: '建立场景' },
  { number: '04', title: '组装技能包', text: '把 Skill 和专项 Prompt 组合成可复用能力，按场景选择优先、混合或严格模式。', to: '/packages', action: '管理技能包' },
  { number: '05', title: '启用经验复用', text: '为场景开启相似问题匹配，设置“引用经验”和“继续会话”两级阈值。', to: '/thread-routing', action: '配置经验复用' },
  { number: '06', title: '从飞书开始使用', text: '把 Bot 拉入群后 @ 它。命中场景时自动执行；未匹配时可选择场景或使用默认工作区。', to: '/messages', action: '查看处理记录' },
]

const concepts = [
  { icon: FolderRoot, title: '工作区', text: '代码、知识和 Skill 的本地边界，也是执行权限的根目录。' },
  { icon: Bot, title: '飞书 Bot', text: '连接飞书应用与 Codex，定义默认工作区、模型、权限和会话边界。' },
  { icon: Workflow, title: '场景', text: '可复用的消息路由模板，把一类群消息导向指定工作区、Prompt 和技能包。' },
  { icon: Puzzle, title: '技能包', text: '面向某类任务的 Skill + Prompt 组合，控制首选能力和回退策略。' },
  { icon: GitBranch, title: 'Thread Channel', text: '群或话题的持久执行通道，绑定 Codex Thread，并保证同一通道的消息串行执行。' },
  { icon: BrainCircuit, title: '经验画像', text: '从已完成问题中沉淀的特征、历史结论和 Thread，供后续相似问题复用。' },
]

const strengths = [
  { icon: Layers3, title: '五层 Prompt 精准叠加', text: '平台 → 工作区 → Bot → 场景 → 技能包。公共规则只写一次，业务差异逐层收敛。' },
  { icon: Code2, title: '不只会聊天，还能实际干活', text: 'Codex 可在工作区内阅读代码、搜索知识、调用 Skill 和工具，把回答变成有证据的调查结果。' },
  { icon: BrainCircuit, title: '问题处理会越用越熟', text: '系统自动提取服务、事件、告警规则等特征。高相似问题可继续原 Thread，中等相似问题会带着历史结论重新验证。' },
  { icon: MessageSquareText, title: '飞书体验是完整的', text: '收到消息后先打表情确认，处理中逐步更新回复，最终用可读的 Markdown 结果卡片完成交付。' },
  { icon: Database, title: '全链路可追溯', text: '每条消息的路由、技能、模型、Thread、耗时、回复和错误都保留在 SQLite，方便复盘与审计。' },
  { icon: ShieldCheck, title: '可控、可隔离、可运维', text: '工作区限定文件边界，Bot 权限和操作人可配置，账号、操作日志、任务队列和失败记录都可见。' },
]
</script>

<template>
  <div class="page guide-page">
    <section class="guide-hero">
      <div class="hero-copy">
        <p class="eyebrow">Product guide</p>
        <h1>把飞书 Bot 变成<br /><span>真正会干活的 AI 团队</span></h1>
        <p>CodyBotHub 是一个面向企业场景的飞书 Agent 管理平台。它把消息路由、Codex 会话、本地代码、知识库、Skill 和历史经验组合到同一条可配置、可追溯的处理链路中。</p>
        <div class="hero-actions"><RouterLink class="button" to="/workspaces"><Rocket :size="16" />开始配置</RouterLink><a class="ghost-button" href="#quick-start"><BookOpenCheck :size="16" />查看使用流程</a></div>
      </div>
      <div class="hero-system" aria-label="CodyBotHub 处理链路">
        <div class="system-label"><span />LIVE AGENT PIPELINE</div>
        <div class="system-node accent"><MessageSquareText :size="18" /><div><strong>飞书消息</strong><small>群聊 · 话题 · 卡片</small></div></div>
        <div class="system-line"><span>场景识别</span></div>
        <div class="system-node"><Workflow :size="18" /><div><strong>路由与能力编排</strong><small>Workspace · Prompt · Skills</small></div></div>
        <div class="system-line"><span>上下文组装</span></div>
        <div class="system-node"><BrainCircuit :size="18" /><div><strong>Codex 调查与执行</strong><small>代码 · 知识 · 工具</small></div></div>
        <div class="system-line"><span>沉淀经验</span></div>
        <div class="system-node success"><Sparkles :size="18" /><div><strong>结果与经验复用</strong><small>Thread · Profile · Audit</small></div></div>
      </div>
    </section>

    <section class="proof-strip" aria-label="核心特性"><div><strong>5 层</strong><span>Prompt 叠加</span></div><div><strong>3 级</strong><span>经验路由</span></div><div><strong>100%</strong><span>处理链路可追溯</span></div><div><strong>多 Bot</strong><span>独立工作区与权限</span></div></section>

    <div class="guide-layout">
      <aside class="guide-nav"><strong>本页导航</strong><a href="#overview">系统是什么</a><a href="#quick-start">六步开始使用</a><a href="#concepts">核心概念</a><a href="#pipeline">消息如何处理</a><a href="#experience">经验如何复用</a><a href="#strengths">为什么它很强</a><a href="#operations">日常运维</a></aside>

      <div class="guide-content">
        <section id="overview" class="guide-section">
          <p class="section-index">01 · OVERVIEW</p><h2>不是又一个问答 Bot</h2>
          <p class="lead">CodyBotHub 管理的是一整套“消息进来后，AI 该去哪里、用什么能力、带着哪些上下文、在哪个会话里工作、结果如何沉淀”的生命周期。</p>
          <div class="value-grid"><article><Boxes :size="19" /><strong>统一管理</strong><p>一个平台管理多个 Bot、工作区、场景和技能包。</p></article><article><LockKeyhole :size="19" /><strong>边界清晰</strong><p>每个场景只能访问选中工作区内的代码与知识。</p></article><article><Activity :size="19" /><strong>可观测</strong><p>从收消息到回复、Thread 和耗时，每一步都有记录。</p></article></div>
        </section>

        <section id="quick-start" class="guide-section">
          <p class="section-index">02 · QUICK START</p><h2>六步把一个 Bot 投入使用</h2><p class="section-copy">先建立文件和权限边界，再接入 Bot，最后通过场景和技能包组装业务能力。</p>
          <div class="step-list"><article v-for="step in setupSteps" :key="step.number"><span class="step-number">{{ step.number }}</span><div><h3>{{ step.title }}</h3><p>{{ step.text }}</p></div><RouterLink :to="step.to">{{ step.action }}<ArrowRight :size="13" /></RouterLink></article></div>
        </section>

        <section id="concepts" class="guide-section">
          <p class="section-index">03 · CONCEPTS</p><h2>理解这六个概念，就理解了整个系统</h2>
          <div class="concept-grid"><article v-for="item in concepts" :key="item.title"><div class="concept-icon"><component :is="item.icon" :size="18" /></div><h3>{{ item.title }}</h3><p>{{ item.text }}</p></article></div>
          <div class="prompt-formula"><span>最终上下文</span><code>平台 Prompt + 工作区 Prompt + Bot Prompt + 场景 Prompt + 技能包 Prompt</code><p>分层设计让全局规则、项目知识和业务特例各归其位，避免一个巨大 Prompt 难以维护。</p></div>
        </section>

        <section id="pipeline" class="guide-section">
          <p class="section-index">04 · MESSAGE PIPELINE</p><h2>一条飞书消息如何被处理</h2>
          <div class="pipeline"><div><span>1</span><strong>接收与去重</strong><p>长连接收到文本或卡片，按消息 ID 去重，并在原消息上打表情确认。</p></div><div><span>2</span><strong>匹配场景</strong><p>按优先级检查群 ID、消息类型、文本关键词和卡片标题。</p></div><div><span>3</span><strong>组装能力</strong><p>确定工作区、Prompt、技能包、知识资源、模型和推理强度。</p></div><div><span>4</span><strong>选择 Thread</strong><p>按 Bot 的群/话题模式找到 Channel，必要时根据经验规则复用历史 Thread。</p></div><div><span>5</span><strong>排队执行</strong><p>任务先持久化，同一 Channel 串行处理，避免 Codex Thread 被并发占用。</p></div><div><span>6</span><strong>回复与沉淀</strong><p>流式更新飞书回复，保留完整记录，并异步刷新经验画像。</p></div></div>
          <div class="fallback-note"><CheckCircle2 :size="18" /><div><strong>没有匹配场景也能工作</strong><p>用户可选择场景；暂不选择时，Bot 会在默认工作区中继续对话。</p></div></div>
        </section>

        <section id="experience" class="guide-section">
          <p class="section-index">05 · EXPERIENCE REUSE</p><h2>相同经验的问题，不必每次从零开始</h2><p class="section-copy">系统只在同一 Bot、工作区和场景内比较。它结合结构化特征、文本相似度和时间衰减，把新消息分到三种处理方式。</p>
          <div class="decision-grid"><article class="fresh"><span>&lt; 经验阈值</span><h3>全新处理</h3><p>创建新的 Channel 和 Codex Thread，独立调查。</p></article><article class="reference"><span>≥ 经验阈值</span><h3>引用历史经验</h3><p>新建 Thread，但把相似问题的特征和结论注入本轮。</p></article><article class="reuse"><span>≥ 复用阈值</span><h3>继续历史会话</h3><p>直接进入原 Codex Thread，保留完整调查上下文。</p></article></div>
          <RouterLink class="inline-cta" to="/thread-routing">查看当前经验库与复用记录<ArrowRight :size="14" /></RouterLink>
        </section>

        <section id="strengths" class="guide-section">
          <p class="section-index">06 · WHY IT MATTERS</p><h2>它强在哪里</h2><p class="section-copy">强大不是因为功能多，而是每个能力都进入了同一条可管理的生产链路。</p>
          <div class="strength-grid"><article v-for="item in strengths" :key="item.title"><component :is="item.icon" :size="20" /><div><h3>{{ item.title }}</h3><p>{{ item.text }}</p></div></article></div>
        </section>

        <section id="operations" class="guide-section">
          <p class="section-index">07 · OPERATIONS</p><h2>日常怎么管</h2>
          <div class="ops-grid"><article><h3>每天先看运行总览</h3><p>关注处理中任务、失败数、成功率、平均耗时和经验命中。</p><RouterLink to="/">打开总览<ArrowRight :size="13" /></RouterLink></article><article><h3>问题排查看消息记录</h3><p>通过记录 ID、消息 ID 或 Thread ID 搜索，查看实际路由、模型、技能和错误。</p><RouterLink to="/messages">查看记录<ArrowRight :size="13" /></RouterLink></article><article><h3>效果优化看经验复用</h3><p>检查画像特征是否稳定、阈值是否合理，以及新问题被分到了哪个 Thread。</p><RouterLink to="/thread-routing">查看经验<ArrowRight :size="13" /></RouterLink></article><article><h3>变更追溯看操作记录</h3><p>账号、配置修改和关键操作均有审计快照，方便回溯。</p><RouterLink to="/audit-logs">查看审计<ArrowRight :size="13" /></RouterLink></article></div>
          <div class="closing"><div><p class="eyebrow">READY TO SCALE</p><h2>从一个 Bot 开始，长成一套可复用的 AI 工作方式</h2><p>新增业务不需要再造一套机器人：创建场景、组装技能包、选择工作区，就可以把已有底座复制到新团队和新流程。</p></div><RouterLink class="button" to="/scenes">创建下一个场景<ArrowRight :size="15" /></RouterLink></div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide-page{max-width:1480px}.guide-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(390px,.72fr);gap:56px;align-items:center;padding:46px 48px;background:linear-gradient(130deg,color-mix(in srgb,var(--primary) 15%,transparent),transparent 47%),var(--surface);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow-soft)}.guide-hero::after{content:'';position:absolute;right:-140px;top:-190px;width:460px;height:460px;background:radial-gradient(circle,color-mix(in srgb,var(--primary) 15%,transparent),transparent 68%);pointer-events:none}.hero-copy{position:relative;z-index:1}.hero-copy h1{max-width:760px;font-size:clamp(36px,4.4vw,62px);line-height:1.05}.hero-copy h1 span{color:var(--primary)}.hero-copy>p:not(.eyebrow){max-width:760px;margin:22px 0 0;color:var(--text-soft);font-size:15px;line-height:1.8}.hero-actions{display:flex;gap:10px;margin-top:28px}.hero-actions a{text-decoration:none}.hero-system{position:relative;z-index:1;padding:19px;background:color-mix(in srgb,var(--surface-raised) 88%,transparent);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)}.system-label{display:flex;align-items:center;gap:8px;margin-bottom:15px;color:var(--muted);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.system-label span{width:7px;height:7px;background:var(--green);border-radius:50%;box-shadow:0 0 0 4px rgba(52,211,153,.1)}.system-node{display:flex;align-items:center;gap:12px;padding:14px;color:var(--text-soft);background:var(--surface);border:1px solid var(--border);border-radius:11px}.system-node svg{color:var(--primary)}.system-node.accent{border-color:var(--primary-border)}.system-node.success svg{color:var(--green)}.system-node strong,.system-node small{display:block}.system-node strong{font-size:12px}.system-node small{margin-top:4px;color:var(--muted);font-size:9px}.system-line{height:31px;display:flex;align-items:center;margin-left:22px;padding-left:18px;border-left:1px dashed var(--border-strong)}.system-line span{color:var(--muted);font:600 8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.proof-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:16px 0 42px;background:var(--surface);border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow-soft)}.proof-strip div{padding:20px 24px;border-left:1px solid var(--border)}.proof-strip div:first-child{border-left:0}.proof-strip strong,.proof-strip span{display:block}.proof-strip strong{font:750 20px ui-monospace,SFMono-Regular,Menlo,monospace}.proof-strip span{margin-top:7px;color:var(--muted);font-size:10px}.guide-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:46px;align-items:start}.guide-nav{position:sticky;top:24px;display:grid;gap:4px;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:13px}.guide-nav strong{padding:5px 8px 10px;color:var(--text-soft);font-size:11px}.guide-nav a{padding:8px;color:var(--muted);border-radius:7px;font-size:10px;text-decoration:none}.guide-nav a:hover{color:var(--text);background:var(--surface-raised)}.guide-content{min-width:0}.guide-section{scroll-margin-top:25px;padding:10px 0 64px}.guide-section+.guide-section{padding-top:56px;border-top:1px solid var(--border)}.section-index{margin-bottom:10px;color:var(--primary);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em}.guide-section>h2{max-width:880px;margin:0;font-size:clamp(25px,3vw,34px);letter-spacing:-.03em}.lead,.section-copy{max-width:900px;margin:15px 0 25px;color:var(--muted);font-size:13px;line-height:1.8}.value-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.value-grid article,.concept-grid article{padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:14px}.value-grid svg{color:var(--primary)}.value-grid strong{display:block;margin:14px 0 8px;font-size:13px}.value-grid p,.concept-grid p{margin:0;color:var(--muted);font-size:10px;line-height:1.65}.step-list{display:grid;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-soft)}.step-list article{display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;gap:18px;padding:21px 23px;border-top:1px solid var(--border)}.step-list article:first-child{border-top:0}.step-number{color:var(--primary);font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace}.step-list h3{margin:0 0 7px;font-size:13px}.step-list p{margin:0;color:var(--muted);font-size:10px;line-height:1.55}.step-list a,.ops-grid a,.inline-cta{display:inline-flex;align-items:center;gap:5px;color:var(--primary);font-size:10px;font-weight:700;text-decoration:none}.concept-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:25px}.concept-icon{width:36px;height:36px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border:1px solid var(--primary-border);border-radius:10px}.concept-grid h3{margin:16px 0 8px;font-size:13px}.prompt-formula{margin-top:14px;padding:21px 23px;background:linear-gradient(115deg,var(--primary-soft),transparent 52%),var(--surface);border:1px solid var(--primary-border);border-radius:14px}.prompt-formula span{display:block;color:var(--muted);font-size:9px}.prompt-formula code{display:block;margin:10px 0;color:var(--text);font-size:12px;white-space:normal}.prompt-formula p{margin:0;color:var(--muted);font-size:10px;line-height:1.6}.pipeline{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:25px}.pipeline>div{padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:14px}.pipeline>div>span{width:25px;height:25px;display:grid;place-items:center;color:var(--primary);background:var(--primary-soft);border-radius:8px;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace}.pipeline strong{display:block;margin:14px 0 8px;font-size:12px}.pipeline p{margin:0;color:var(--muted);font-size:10px;line-height:1.6}.fallback-note{display:flex;gap:12px;margin-top:14px;padding:17px 19px;background:rgba(52,211,153,.07);border:1px solid rgba(52,211,153,.22);border-radius:12px}.fallback-note svg{flex:0 0 auto;color:var(--green)}.fallback-note strong{font-size:11px}.fallback-note p{margin:5px 0 0;color:var(--muted);font-size:10px}.decision-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:25px 0 17px}.decision-grid article{padding:21px;background:var(--surface);border:1px solid var(--border);border-top:3px solid var(--muted);border-radius:13px}.decision-grid .reference{border-top-color:var(--primary)}.decision-grid .reuse{border-top-color:var(--green)}.decision-grid span{color:var(--muted);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace}.decision-grid h3{margin:16px 0 8px;font-size:13px}.decision-grid p{margin:0;color:var(--muted);font-size:10px;line-height:1.6}.strength-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:25px}.strength-grid article{display:flex;gap:15px;padding:21px;background:var(--surface);border:1px solid var(--border);border-radius:14px}.strength-grid svg{flex:0 0 auto;color:var(--primary)}.strength-grid h3{margin:1px 0 8px;font-size:13px}.strength-grid p{margin:0;color:var(--muted);font-size:10px;line-height:1.65}.ops-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:25px}.ops-grid article{padding:21px;background:var(--surface);border:1px solid var(--border);border-radius:14px}.ops-grid h3{margin:0 0 9px;font-size:13px}.ops-grid p{min-height:48px;margin:0 0 13px;color:var(--muted);font-size:10px;line-height:1.6}.closing{display:flex;align-items:end;justify-content:space-between;gap:30px;margin-top:16px;padding:28px 30px;background:linear-gradient(120deg,var(--primary-soft),transparent 55%),var(--surface);border:1px solid var(--primary-border);border-radius:17px}.closing h2{max-width:760px;margin:0;font-size:22px}.closing p:not(.eyebrow){max-width:780px;margin:12px 0 0;color:var(--muted);font-size:11px;line-height:1.65}.closing>.button{flex:0 0 auto}@media(max-width:1150px){.guide-hero{grid-template-columns:1fr}.guide-layout{grid-template-columns:1fr}.guide-nav{position:static;display:flex;overflow-x:auto}.guide-nav strong{display:none}.guide-nav a{flex:0 0 auto}.concept-grid,.pipeline{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.guide-hero{padding:30px 24px}.hero-copy h1{font-size:34px}.hero-system{padding:13px}.proof-strip,.value-grid,.concept-grid,.pipeline,.decision-grid,.strength-grid,.ops-grid{grid-template-columns:1fr}.proof-strip div{border-top:1px solid var(--border);border-left:0}.proof-strip div:first-child{border-top:0}.step-list article{grid-template-columns:32px 1fr}.step-list a{grid-column:2}.closing{align-items:stretch;flex-direction:column}.closing>.button{align-self:flex-start}}
</style>
