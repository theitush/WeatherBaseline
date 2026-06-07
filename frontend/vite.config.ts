import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Tiered cell files (archive/recent/forecast *.csv.gz). In dev the Node
      // backend serves these from data/era5-land/; in prod VITE_DATA_BASE
      // points the frontend straight at R2/CDN instead.
      '/data': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
