import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // Pre-bundle zustand with React up front; late discovery reloads the page mid-render.
    optimizeDeps: { include: ['react', 'react-dom/client', 'zustand'] },
    plugins: [react(), tailwindcss()]
  }
})
