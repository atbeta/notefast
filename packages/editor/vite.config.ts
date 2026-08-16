import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
  },
  // NoteFastEditor 用壳层内嵌相对路径加载打包产物，base 保持相对
  base: './',
  build: {
    outDir: 'dist',
  },
})
