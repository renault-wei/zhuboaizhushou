import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 管理后台 Vite 配置：开发环境把 /api 前缀请求代理到本地 Fastify 后端
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
