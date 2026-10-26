import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    // Diagram renderers are loaded only by Markdown-bearing routes. Keep warnings
    // focused on unexpected growth in the eagerly loaded application entry.
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
})
