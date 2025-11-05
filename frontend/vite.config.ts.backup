import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 開発環境でのみ使用されるプロキシ設定
      '/score.ScoreService': {
        target: 'http://localhost:8085',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
