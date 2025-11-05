export default {
  esbuild: {
    jsx: 'automatic',
  },
  server: {
    port: 5173,
    proxy: {
      '/score.ScoreService': {
        target: 'http://localhost:8085',
        changeOrigin: true,
        secure: false,
      },
    },
  },
}