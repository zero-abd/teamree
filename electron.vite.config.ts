import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// app.getVersion() reports Electron's own version when the app runs unpackaged,
// so the real one is baked in at build time instead.
const appVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version as string

// The CLI is a plain Node bundle, not an Electron target, so it is built by its
// own esbuild pass in scripts/build-cli.mjs rather than by electron-vite.
export default defineConfig({
  main: {
    // Bundled rather than shipped: the package leaves @xterm out of node_modules, and main reads agent screens with it.
    plugins: [externalizeDepsPlugin({ exclude: ['@xterm/xterm'] })],
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
