import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

// Vitest runs with `test.globals: true` (see vite.config.mjs), so `describe` /
// `it` / `expect` are ambient in every test file. The `globals` package has no
// vitest preset; listing them here keeps `no-undef` switched on for tests
// instead of turning it off wholesale.
const vitestGlobals = {
  suite: 'readonly',
  test: 'readonly',
  describe: 'readonly',
  it: 'readonly',
  expect: 'readonly',
  assert: 'readonly',
  vitest: 'readonly',
  vi: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  onTestFinished: 'readonly',
  onTestFailed: 'readonly',
}

// Rules shared by every environment. Deliberately small: only rules that catch
// real bugs today, so the gate can be kept at 0 errors instead of being
// disabled piecemeal.
const sharedRules = {
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'none',
      ignoreRestSiblings: true,
    },
  ],
  // 'smart' still flags `==`/`!=` between real values but allows the
  // intentional `value == null` null-or-undefined checks.
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  // `catch {}` is used deliberately in teardown paths (close a window, remove a
  // temp dir) where the cleanup failure must not mask the original error.
  'no-empty': ['error', { allowEmptyCatch: true }],
}

export default [
  {
    ignores: ['dist/**', 'release/**', 'coverage/**', 'node_modules/**', '.tmp-*/**', '.tmp-*'],
  },

  // Node, CommonJS: the main process and the .cjs tests.
  {
    files: ['electron/**/*.cjs', 'tests/**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...vitestGlobals },
    },
    rules: { ...js.configs.recommended.rules, ...sharedRules },
  },

  // Node, ESM: build/release scripts, the .mjs tests and the root tool configs.
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...vitestGlobals },
    },
    rules: { ...js.configs.recommended.rules, ...sharedRules },
  },

  // Renderer: browser ESM (React 19 + JSX).
  {
    files: ['src/**/*.js', 'src/**/*.jsx'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...sharedRules,
      'react-hooks/rules-of-hooks': 'error',
      // main.jsx is a single 2.7k-line component where several effects
      // intentionally depend on a wider slice of state than the linter can
      // prove; keep it visible as a warning until 0.6.5 splits the hooks.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
