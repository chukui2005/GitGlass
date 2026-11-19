import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  test: {
    globals: true,
    fileParallelism: false,
    // jsdom / jest-dom matchers for the files that opt in with
    // `// @vitest-environment jsdom`. The Electron probe tests keep the default
    // node environment, so the setup skips the React bits when there is no DOM.
    setupFiles: ['tests/support/jsdom-setup.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{js,jsx}', 'electron/**/*.cjs'],
      // Entry points that only ever run inside a spawned Electron process are
      // invisible to in-process v8 coverage (the UI probes launch the real app
      // instead). src/main.jsx is the 2.7k-line UI entry that 0.6.5 splits into
      // hooks; its coverage arrives together with that split.
      // See docs/improvement-plan.md and docs/conventions.md.
      exclude: ['src/main.jsx', 'electron/main.cjs', 'electron/preload.cjs'],
      thresholds: { statements: 50, branches: 50, functions: 50, lines: 50 },
    },
  },
})
