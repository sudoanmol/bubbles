import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 3100, strictPort: true },
  plugins: [cloudflare(), tailwindcss(), tanstackRouter({ target: 'react', autoCodeSplitting: true }), viteReact()],
})
