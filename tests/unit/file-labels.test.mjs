import { describe, expect, it } from 'vitest'
import {
  basename,
  breadcrumbSegments,
  dirSegments,
  fileLabel,
  labelFiles,
  pathSegments,
  stageSelectionKey,
} from '../../src/file-labels.js'

describe('file labels', () => {
  it('splits both Windows and POSIX separators', () => {
    expect(pathSegments('src\\settings/configuration.ts')).toEqual(['src', 'settings', 'configuration.ts'])
    expect(pathSegments('')).toEqual([])
    expect(basename('src\\settings/configuration.ts')).toBe('configuration.ts')
    expect(dirSegments('src\\settings/configuration.ts')).toEqual(['src', 'settings'])
    expect(breadcrumbSegments('src/settings/configuration.ts')).toEqual(['src', 'settings', 'configuration.ts'])
  })

  it('keeps the full relative path as the hover title', () => {
    expect(fileLabel('src/settings/configuration.ts')).toEqual({
      name: 'configuration.ts',
      dir: 'src/settings',
      title: 'src/settings/configuration.ts',
    })
  })

  it('shows only the basename when there is no name collision', () => {
    const labels = labelFiles([
      { path: 'src/main.jsx' },
      { path: 'docs/quickstart.md' },
    ])
    expect(labels.map((label) => label.name)).toEqual(['main.jsx', 'quickstart.md'])
    expect(labels.map((label) => label.dir)).toEqual(['', ''])
    expect(labels.map((label) => label.title)).toEqual(['src/main.jsx', 'docs/quickstart.md'])
  })

  it('adds the shortest distinguishing parent suffix for duplicate basenames', () => {
    const labels = labelFiles([
      { path: 'src/settings/configuration.ts' },
      { path: 'test/settings/configuration.ts' },
      { path: 'src/main.jsx' },
    ])
    expect(labels[0]).toMatchObject({ name: 'configuration.ts', dir: 'src/settings/' })
    expect(labels[1]).toMatchObject({ name: 'configuration.ts', dir: 'test/settings/' })
    // 唯一的名字不受影响。
    expect(labels[2]).toMatchObject({ name: 'main.jsx', dir: '' })
  })

  it('grows the suffix only until the label is unique', () => {
    const labels = labelFiles([
      { path: 'a/deep/config.json' },
      { path: 'b/other/config.json' },
      { path: 'c/other/config.json' },
    ])
    // 最短尾段 `deep/`、`other/` 已经能区分前两个；后两个在 `other/` 上冲突，各自加长。
    expect(labels[0].dir).toBe('deep/')
    expect(labels[1].dir).toBe('b/other/')
    expect(labels[2].dir).toBe('c/other/')
  })

  it('treats Windows-style case differences as the same basename', () => {
    const labels = labelFiles([
      { path: 'src/README.md' },
      { path: 'docs/readme.md' },
    ])
    expect(labels[0].dir).toBe('src/')
    expect(labels[1].dir).toBe('docs/')
  })

  it('falls back to the full path for a duplicate that lives in the repository root', () => {
    const labels = labelFiles([
      { path: 'README.md' },
      { path: 'docs/README.md' },
    ])
    // 根目录那一份没有可用的父目录尾段，只能用完整路径区分。
    expect(labels.map((label) => label.dir)).toEqual(['README.md/', 'docs/'])
    expect(labels.map((label) => label.name)).toEqual(['README.md', 'README.md'])
  })

  it('addresses staging by area plus path, so one file can live in both areas', () => {
    expect(stageSelectionKey('unstaged', 'src/main.jsx')).toBe('unstaged:src/main.jsx')
    expect(stageSelectionKey('staged', 'src/main.jsx')).toBe('staged:src/main.jsx')
    expect(stageSelectionKey('staged', 'src/main.jsx')).not.toBe(stageSelectionKey('unstaged', 'src/main.jsx'))
  })
})
