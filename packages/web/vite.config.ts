import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // 允许 host.docker.internal / 任何局域网 host，方便容器浏览器从 host 访问
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3140',
        changeOrigin: true,
      },
      // MCP 端点同源代理：设置页展示的 MCP URL 用 location.origin + /mcp，
      // dev 下页面在 :5173，需把 /mcp 转发到后端
      '/mcp': {
        target: 'http://localhost:3140',
        changeOrigin: true,
      },
    },
  },
})
