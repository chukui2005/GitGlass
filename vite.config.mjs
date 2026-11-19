import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  test: {
    globals: true,
    fileParallelism: false,
    // Integration tests shell out to real Git and the UI probes spawn Electron;
    // under `--coverage` every module they load is instrumented, so the 5 s
    // default is too tight on a cold CI runner. A timed-out test also skips its
    // own cleanup, which on Windows leaves a watched directory it cannot delete.
    // Individual tests keep their own shorter budgets where that helps.
    testTimeout: 20_000,
    // jsdom / jest-dom matchers for the files that opt in with
    // `// @vitest-environment jsdom`. The Electron probe tests keep the default
    // node environment, so the setup skips the React bits when there is no DOM.
    setupFiles: ['tests/support/jsdom-setup.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{js,jsx}', 'electron/**/*.cjs'],
      // Only the two Electron entry points stay excluded: they run in a spawned
      // process, so in-process v8 coverage cannot see them (the UI probes launch
      // the real app instead). The renderer entry (src/main.jsx) used to be
      // excluded too; 0.6.5 split it into hooks + workbench-ui.jsx, and the
      // rendered tests now cover it, so it is measured like everything else.
      // See docs/improvement-plan.md and docs/conventions.md.
      exclude: ['electron/main.cjs', 'electron/preload.cjs'],
      thresholds: { statements: 50, branches: 50, functions: 50, lines: 50 },
    },
  },
})
