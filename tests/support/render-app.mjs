import { createElement } from 'react'
import { render } from '@testing-library/react'
import { App } from '../../src/main.jsx'
import { createGitglassStub } from './gitglass-stub.mjs'

/**
 * 用假 IPC 桥渲染真实的工作台。
 *
 * 假桥必须在挂载前装好：`<App />` 的首屏 effect 会立刻读更新状态、仓库状态、
 * 分支、提交、远程概览与命令账本，晚一步就会读到 undefined 并在控制台抛错。
 *
 * @param {Record<string, unknown>} [overrides] 传给 `createGitglassStub` 的覆盖项。
 * @returns {ReturnType<typeof render> & { gitglass: Record<string, import('vitest').Mock> }}
 */
export function renderApp(overrides = {}) {
  const gitglass = createGitglassStub(overrides)
  window.gitglass = gitglass
  const view = render(createElement(App))
  return { ...view, gitglass }
}
