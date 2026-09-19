<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{ total: number; offset: number; pageSize: number; loading?: boolean }>()
const emit = defineEmits<{ change: [offset: number] }>()
const page = computed(() => Math.floor(props.offset / props.pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const first = computed(() => props.total ? props.offset + 1 : 0)
const last = computed(() => Math.min(props.total, props.offset + props.pageSize))
</script>

<template>
  <footer class="pagination">
    <span>第 {{ page }} / {{ pageCount }} 页 · {{ first }}–{{ last }} / 共 {{ total }} 条</span>
    <div>
      <button class="ghost-button compact" :disabled="offset === 0 || loading" @click="emit('change', Math.max(0, offset - pageSize))"><ChevronLeft :size="15" />上一页</button>
      <button class="ghost-button compact" :disabled="offset + pageSize >= total || loading" @click="emit('change', offset + pageSize)">下一页<ChevronRight :size="15" /></button>
    </div>
  </footer>
</template>
