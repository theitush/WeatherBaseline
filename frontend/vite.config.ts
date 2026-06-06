import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Copy Cloudflare Pages Functions into the build output. `outDir` is wiped on
// every build (emptyOutDir), and Pages expects functions/ to sit inside the
// deployed directory (dist/), so we emit them here after the bundle is written.
// Source of truth stays in frontend/functions/. See functions/_middleware.js.
function copyPagesFunctions() {
  return {
    name: 'copy-pages-functions',
    closeBundle() {
      const src = resolve(__dirname, 'functions')
      if (existsSync(src)) {
        cpSync(src, resolve(__dirname, '../dist/functions'), { recursive: true })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), copyPagesFunctions()],
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
