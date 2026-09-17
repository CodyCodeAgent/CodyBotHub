<script setup lang="ts">
import { ArrowUp, ChevronRight, Folder, X } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import { api, type DirectoryListing } from '../api'

const props = defineProps<{ visible: boolean; initialPath?: string }>()
const emit = defineEmits<{ close: []; select: [path: string] }>()
const listing = ref<DirectoryListing | null>(null)
const loading = ref(false)
const error = ref('')

const browse = async (path?: string) => {
  loading.value = true; error.value = ''
  try { listing.value = await api.directories(path) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading.value = false }
}

watch(() => props.visible, visible => {
  if (visible) void browse(props.initialPath?.trim() || undefined)
  else { listing.value = null; error.value = '' }
})
</script>

<template>
  <div v-if="visible" class="dialog-backdrop directory-picker-backdrop" @mousedown.self="emit('close')">
    <section class="dialog directory-picker" role="dialog" aria-modal="true" aria-labelledby="directory-picker-title">
      <header class="dialog-header"><div><h2 id="directory-picker-title">选择本地目录</h2><p>浏览 CodyBotHub 服务所在机器允许访问的目录。</p></div><button type="button" class="icon-button" aria-label="关闭目录选择器" @click="emit('close')"><X :size="19" /></button></header>
      <div class="dialog-body">
        <div v-if="listing" class="directory-browser">
          <div class="directory-roots"><button v-for="root in listing.roots" :key="root.path" type="button" class="directory-root" :class="{ active: root.path === listing.current }" @click="browse(root.path)"><Folder :size="14" />{{ root.name }}</button></div>
          <div class="directory-current"><code>{{ listing.current }}</code><button type="button" class="ghost-button compact" :disabled="!listing.parent || loading" @click="browse(listing.parent!)"><ArrowUp :size="14" />上级</button></div>
          <div v-if="loading" class="directory-status">正在读取目录…</div>
          <div v-else class="directory-list"><button v-for="entry in listing.directories" :key="entry.path" type="button" @click="browse(entry.path)"><ChevronRight :size="15" /><strong>{{ entry.name }}</strong><code>{{ entry.path }}</code></button><p v-if="!listing.directories.length" class="directory-status">当前目录没有子目录。</p></div>
        </div>
        <div v-else-if="loading" class="directory-status">正在读取目录…</div>
        <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
      </div>
      <footer class="dialog-actions"><button type="button" class="ghost-button" @click="emit('close')">取消</button><button type="button" class="button" :disabled="!listing || loading" @click="listing && emit('select', listing.current)">使用此目录</button></footer>
    </section>
  </div>
</template>
