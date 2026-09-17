<script setup lang="ts">
import { Bot, Boxes, MessageSquareText, Puzzle, Workflow } from 'lucide-vue-next'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'

const router = useRouter()
const setupRequired = ref(false)
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)
onMounted(async () => { setupRequired.value = (await api.authStatus()).setupRequired })
const submit = async () => {
  error.value = ''
  if (setupRequired.value && password.value !== confirmPassword.value) { error.value = '两次输入的密码不一致'; return }
  loading.value = true
  try {
    if (setupRequired.value) await api.setup(password.value)
    else await api.login(password.value)
    await router.push('/')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败' }
  finally { loading.value = false }
}
</script>

<template>
  <div class="auth-page">
    <section class="auth-form-side">
      <form class="auth-card" @submit.prevent="submit">
        <div class="brand"><div class="brand-mark"><Bot :size="22" /></div><div><strong>CodyBotHub</strong><span>Feishu Agent Control</span></div></div>
        <p class="eyebrow">{{ setupRequired ? '首次启动' : '安全登录' }}</p>
        <h1>{{ setupRequired ? '创建管理员密码' : '欢迎回来' }}</h1>
        <p>{{ setupRequired ? '此密码用于保护 Bot 配置、工作区和飞书凭据。至少输入 10 个字符。' : '登录后管理工作区、Bot、场景路由和技能包。' }}</p>
        <div class="auth-fields">
          <div class="field"><label for="password">管理员密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" minlength="10" required autofocus placeholder="输入密码" /></div>
          <div v-if="setupRequired" class="field"><label for="confirm">确认密码</label><input id="confirm" v-model="confirmPassword" type="password" autocomplete="new-password" minlength="10" required placeholder="再次输入密码" /></div>
          <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
          <button class="button full" type="submit" :disabled="loading">{{ loading ? '正在处理…' : setupRequired ? '创建并进入平台' : '登录' }}</button>
        </div>
      </form>
    </section>
    <section class="auth-visual" aria-hidden="true">
      <div class="visual-card">
        <span class="visual-kicker">One control plane</span>
        <h2>把飞书消息路由到正确的工作区和能力</h2>
        <div class="flow">
          <div class="flow-row"><MessageSquareText :size="20" /><div><strong>飞书消息</strong><span>群、话题、卡片模板</span></div></div>
          <div class="flow-row"><Workflow :size="20" /><div><strong>场景匹配</strong><span>优先级与确定性路由</span></div></div>
          <div class="flow-row"><Boxes :size="20" /><div><strong>工作区上下文</strong><span>本地目录与分层 Prompt</span></div></div>
          <div class="flow-row"><Puzzle :size="20" /><div><strong>技能包</strong><span>场景优先、Core 能力兜底</span></div></div>
        </div>
      </div>
    </section>
  </div>
</template>
