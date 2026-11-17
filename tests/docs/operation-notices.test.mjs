import { describe, expect, it } from 'vitest'
import { operationFinishedNotice, operationInProgressNotice } from '../../src/user-notices.js'

describe('in-progress operation copy', () => {
  it('names the operation and tells the user how to finish it outside the app', () => {
    expect(operationInProgressNotice('merge')).toEqual({
      type: 'error',
      text: '仓库正在进行合并操作。请在终端完成或中止（git merge --abort）后再继续。',
    })
    expect(operationInProgressNotice('rebase').text).toContain('变基')
    expect(operationInProgressNotice('rebase').text).toContain('git rebase --abort')
    expect(operationInProgressNotice('cherry-pick').text).toContain('遴选提交')
    expect(operationInProgressNotice('revert').text).toContain('回滚提交')
  })

  it('has no notice when the repository is normal', () => {
    expect(operationInProgressNotice(null)).toBeNull()
    expect(operationInProgressNotice(undefined)).toBeNull()
  })

  it('confirms when the repository is back to normal', () => {
    expect(operationFinishedNotice()).toEqual({ type: 'success', text: '仓库已回到正常状态。' })
  })
})
