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
      // Control plane (/api/ensure-fresh, /api/geo, /api/health). In dev these
      // proxy to the prod Worker run locally via `wrangler dev --remote`
      // (npm run dev → port 8787), which writes the volatile tiers to the REAL
      // R2 bucket — the SAME worker/src/* code and same bucket prod uses. In
      // prod the frontend hits the deployed Worker directly via VITE_API_BASE.
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // NOTE: no /data proxy. The tiered cell files (archive/recent/forecast
      // *.csv.gz) are read DIRECTLY from R2 in both dev and prod via
      // VITE_DATA_BASE (see frontend/.env). Local dev is fully data-remote:
      // reads from R2's public URL, writes through the Worker to the same R2.
    },
  },
})
