import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Load the monorepo-root .env (shared with the backend) instead of frontend/.env
  envDir: path.resolve(__dirname, '..'),
  // Vite's dep pre-bundler mangles maplibre-gl's web worker (served with an
  // empty MIME type, browser refuses to run it) - exclude it so the browser
  // loads it directly from node_modules instead.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
