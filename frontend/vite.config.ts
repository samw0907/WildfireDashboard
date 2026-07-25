import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Load the monorepo-root .env (shared with the backend) instead of frontend/.env
  envDir: path.resolve(__dirname, '..'),
})
