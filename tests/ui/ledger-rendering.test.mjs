// @vitest-environment jsdom
//
// 命令账本的渲染策略（与账本数据本身无关）：
// 1) 详情（命令结果 / 诊断信息 / 技术详情）只在展开时挂进 DOM，收起时不占节点；
// 2) 与账本无关的 App 重渲染不会重渲染整列记录——React.memo + 记录对象身份复用。
//
// 这两条都是「几百条记录」级别的成本问题，用真渲染 + 读取计数来守，不靠计时。
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import { fileFixture, ledgerRecordFixture, repositoryState } from '../support/gitglass-fixtures.mjs'

// 账本上限是 300 条记录；jsdom 渲染 300 条要十几秒，这里用更小的样本守同一条不变量，
// 300 条的真实窗口数字由 .screenshots 里的 Electron 探针测量。
const JSDOM_SAMPLE_SIZE = 120

function workspaceStub(overrides = {}) {
  return {
    getState: async () => repositoryState({ files: [fileFixture({ path: 'src/main.jsx' })] }),
    getLedger: async () => [],
    getBranches: async () => ({ branches: [{ name: 'main', current: true }] }),
    getCommits: async () => ({ commits: [] }),
    getRemoteOverview: async () => ({ ok: true, remotes: [], remote: null, upstream: null, ahead: 0, behind: 0 }),
    getDiff: async () => ({ ok: true, stdout: '+hello\n' }),
    getRecentRepositories: async () => [],
    ...overrides,
  }
}

function ledgerRecords(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) =>
    ledgerRecordFixture({
      id: `record-${index}`,
      intent: 'Read working tree status',
      displayCommand: `git status --porcelain=v1 -z -- src/modules/module-${index}.jsx`,
      ...overrides,
    }),
  )
}

async function openLedger(user, container) {
  await user.click(screen.getByRole('button', { name: '命令账本' }))
  return waitFor(() => {
    const list = container.querySelector('.ledger-list')
    expect(list).toBeInTheDocument()
    return list
  })
}

describe('命令账本的渲染策略', () => {
  it('keeps the details out of the DOM until a record is expanded', async () => {
    const user = userEvent.setup()
    // 系统读取默认收起；先切到「系统读取」筛选才能看到它们。
    const records = ledgerRecords(5, { source: 'background' })
    const { container } = renderApp(workspaceStub({ getLedger: async () => records }))
    await waitFor(() => {
      expect(container.querySelector('.top-actions')).toBeInTheDocument()
    })

    await openLedger(user, container)
    await user.click(screen.getByRole('button', { name: /系统读取/ }))
    // 系统读取按刷新轮次折叠成一组：收起时组内记录根本不渲染。
    const group = await waitFor(() => {
      const found = container.querySelector('.ledger-refresh-group')
      expect(found).toBeInTheDocument()
      return found
    })
    expect(group.querySelectorAll('.ledger-entry')).toHaveLength(0)

    await user.click(group.querySelector('.ledger-refresh-summary'))
    const list = await waitFor(() => {
      const found = container.querySelector('.ledger-list')
      expect(found.querySelectorAll('.ledger-entry')).toHaveLength(5)
      return found
    })

    // 收起态：详情、命令结果、技术详情一个都不在 DOM 里。
    expect(list.querySelectorAll('.ledger-details')).toHaveLength(0)
    expect(list.querySelector('.output pre')).toBeNull()
    expect(list.querySelector('details.tech-details')).toBeNull()

    // 展开一条：只有这一条挂上详情。
    const summary = list.querySelector('.ledger-summary')
    await user.click(summary)
    await waitFor(() => {
      expect(list.querySelectorAll('.ledger-details')).toHaveLength(1)
    })
    expect(list.querySelector('.ledger-details .output pre')).toBeInTheDocument()
    expect(list.querySelector('.ledger-details details.tech-details')).toBeInTheDocument()

    // 再收起：详情从 DOM 里撤掉，不是用 CSS 藏起来。
    await user.click(summary)
    await waitFor(() => {
      expect(list.querySelectorAll('.ledger-details')).toHaveLength(0)
    })
  })

  it('does not re-render the whole ledger when unrelated App state changes', async () => {
    const user = userEvent.setup()
    // 每次渲染读记录字段都会计数：没命中 memo 时，每条记录一次重渲染要读几十次字段。
    // 这个用例在优化前读到 3600 次（120 条 × 30 次），优化后是 0。
    const counter = { reads: 0 }
    const records = ledgerRecords(JSDOM_SAMPLE_SIZE).map(
      (record) =>
        new Proxy(record, {
          get(target, key) {
            counter.reads += 1
            return target[key]
          },
        }),
    )

    const { container } = renderApp(workspaceStub({ getLedger: async () => records }))
    await waitFor(() => {
      expect(container.querySelector('.top-actions')).toBeInTheDocument()
    })
    await openLedger(user, container)
    await waitFor(() => {
      expect(container.querySelectorAll('.ledger-entry')).toHaveLength(JSDOM_SAMPLE_SIZE)
    })

    // 与账本无关的状态变化：打开命令面板会让 App 重渲染一次。
    counter.reads = 0
    await user.click(screen.getByRole('button', { name: '命令面板' }))
    await waitFor(() => {
      expect(container.querySelector('.palette-backdrop')).toBeInTheDocument()
    })

    // 记录一条都没有重新读字段（未 memo 时这里是 1000+ 次）。
    expect(counter.reads).toBeLessThan(50)
  }, 30_000)
})
