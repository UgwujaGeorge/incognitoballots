import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  define: {
    // process.env is handled by polyfills.js (public/polyfills.js loaded synchronously before modules)
    // Do not override process.env here — it breaks crypto-browserify initialization
  },
  resolve: {
    alias: {
      stream: 'stream-browserify',
    },
  },
  server: {
    port: 3000,
    host: true,
  },
})
