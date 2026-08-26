import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In Docker the backend is reached via the compose service name; locally it
// defaults to localhost. Set BACKEND_URL / BACKEND_WS_URL to override.
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000'
const BACKEND_WS = process.env.BACKEND_WS_URL || 'ws://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/webhooks': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND_WS, ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':   ['react', 'react-dom', 'react-router-dom'],
          'vendor-query':   ['@tanstack/react-query'],
          'vendor-charts':  ['recharts'],
          'vendor-leaflet': ['leaflet', 'react-leaflet'],
          'vendor-ui':      ['zustand'],
        },
      },
    },
  },
})
