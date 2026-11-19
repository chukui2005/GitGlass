// @vitest-environment jsdom
//
// 更新流程的真渲染断言（#10 要覆盖的四条主流程之一）。真实的 Electron 桥与安装器
// 启动仍由 tests/ui/update-ui.test.cjs 的探针负责；这里验证的是对话框在各阶段
// 显示什么、按钮什么时候可用、点下去调用了哪个 IPC。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../support/render-app.mjs'
import { commitFixture, repositoryState } from '../support/gitglass-fixtures.mjs'

function updateState(overrides = {}) {
  return {
    supported: true,
    currentVersion: '0.6.4-beta.2',
    channel: 'beta',
    automatic: true,
    phase: 'idle',
    latestVersion: null,
    error: '',
    notes: '',
    ...overrides,
  }
}

async function renderUpdates(overrides = {}) {
  const view = renderApp({
    getState: async () => repositoryState({ files: [] }),
    getCommits: async () => ({ commits: [commitFixture()] }),
    getUpdateState: async () => updateState(),
    ...overrides,
  })
  const user = userEvent.setup()
  // 等首屏 effect 落地（更新状态与仓库状态都是异步读回来的）。
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '检查更新' })).toBeInTheDocument()
  })
  return { ...view, user, stub: view.gitglass }
}

describe('update dialog (rendered)', () => {
  it('describes the current version, channel and idle status', async () => {
    const { user, stub } = await renderUpdates()

    await user.click(screen.getByRole('button', { name: '检查更新' }))
    const dialog = await screen.findByRole('dialog')

    expect(dialog).toHaveTextContent('软件更新')
    expect(within(dialog).getByText('当前版本 0.6.4-beta.2')).toBeInTheDocument()
    expect(within(dialog).getByText('Beta 通道')).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('检查是否有新版本。')
    // 自动检查是偏好项，默认勾选。
    expect(within(dialog).getByRole('checkbox', { name: /自动检查并在后台下载更新/ })).toBeChecked()
    // 没检查过就没有“下载更新”按钮。
    expect(within(dialog).queryByRole('button', { name: '下载更新' })).toBeNull()
    expect(stub.checkForUpdates).not.toHaveBeenCalled()
  })

  it('offers the download action once a new version is found', async () => {
    // 真实主进程是通过 onUpdateState 推送进度的；假桥照同样方式回推一次。
    let pushUpdate = () => {}
    const { user, stub } = await renderUpdates({
      getUpdateState: async () => updateState({ phase: 'available', latestVersion: '0.6.5-beta.1' }),
      onUpdateState: (listener) => {
        pushUpdate = listener
        return () => {
          pushUpdate = () => {}
        }
      },
      downloadUpdate: vi.fn(async () => {
        const next = updateState({ phase: 'downloading', latestVersion: '0.6.5-beta.1', progress: 12 })
        pushUpdate(next)
        return next
      }),
    })

    await user.click(screen.getByRole('button', { name: '检查更新' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('新版本 0.6.5-beta.1')).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('发现新版本，可以开始下载。')

    await user.click(within(dialog).getByRole('button', { name: '下载更新' }))
    await waitFor(() => {
      expect(stub.downloadUpdate).toHaveBeenCalledTimes(1)
    })
    // 下载中：进度条可见，动作按钮在忙时禁用。
    const progress = await within(dialog).findByRole('progressbar', { name: '更新下载进度' })
    expect(progress).toHaveValue(12)
    expect(within(dialog).getByRole('status')).toHaveTextContent('正在下载更新，关闭此面板后仍会继续。')
    expect(within(dialog).getByRole('button', { name: '检查更新' })).toBeDisabled()
  })

  it('turns the top bar trigger into an update prompt when the download is ready', async () => {
    const { user, stub } = await renderUpdates({
      getUpdateState: async () =>
        updateState({ phase: 'ready', latestVersion: '0.6.5-beta.1', notes: '<b>修复</b> 真渲染测试' }),
    })

    // 顶栏从纯图标变成「更新」主按钮，可访问名称同步改掉。
    const trigger = await screen.findByRole('button', { name: '更新已就绪' })
    expect(trigger).toHaveTextContent('更新')

    await user.click(trigger)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('status')).toHaveTextContent('更新已下载并校验，准备好后即可重启更新。')
    // 更新说明支持 HTML：渲染成纯文本，不把标签当文本显示。
    const notes = within(dialog).getByText('更新说明').closest('details')
    expect(notes.querySelector('pre')).toHaveTextContent('修复 真渲染测试')
    expect(notes.querySelector('pre').textContent).not.toContain('<b>')

    await user.click(within(dialog).getByRole('button', { name: '重启并更新' }))
    await waitFor(() => {
      expect(stub.installUpdate).toHaveBeenCalledTimes(1)
    })
    // 安装时会带上当前草稿与历史模式，重启后能恢复现场。
    expect(stub.installUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ commitMessage: '', historyMode: false }),
    )
  })
})
