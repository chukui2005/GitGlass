// 共用初始化：只有声明了 `// @vitest-environment jsdom` 的测试会走到这里。
//
// `tests/ui/` 里还留着真正的 Electron 启动探针（`electron-launch`、`ledger-rows`、
// `resizable-workspace-panels` 等），它们跑在 vitest 默认的 node 环境里，靠真实
// `electron.exe` 提供 DOM。所以这里不能用“无条件 import React Testing Library”：
// 一旦 jsdom 不在，RTL 的 `cleanup` 就没意义，还会把假 DOM 的依赖拖进探针进程。
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

if (typeof document !== 'undefined') {
  // jsdom 有 <dialog> 元素，但还没实现 showModal() / close()（调用即 TypeError），
  // 而「软件更新」面板依赖 showModal() 才能打开。这里只补最小实现：切 open 属性。
  // 顶层图层、焦点陷阱与 Esc 行为由 tests/ui/update-ui.test.cjs 的真实探针覆盖。
  const dialogPrototype = window.HTMLDialogElement?.prototype
  if (dialogPrototype && typeof dialogPrototype.showModal !== 'function') {
    const setOpen = (dialog, value) => {
      if (value) dialog.setAttribute('open', '')
      else dialog.removeAttribute('open')
    }
    dialogPrototype.showModal = function showModal() {
      setOpen(this, true)
    }
    dialogPrototype.show = function show() {
      setOpen(this, true)
    }
    dialogPrototype.close = function close() {
      setOpen(this, false)
    }
  }

  const { cleanup } = await import('@testing-library/react')

  // 每个用例之间卸载：残留的组件树会继续跑 effect（例如首屏的 getState 轮询），
  // 让下一个用例读到上一个用例的状态。
  afterEach(() => {
    cleanup()
  })
}
