const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { GitCommandService } = require('../../electron/git-command-service.cjs')
const { RepositoryService } = require('../../electron/repository-service.cjs')

let cwd
afterEach(() => {
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true })
  cwd = null
})

function write(name, content) {
  fs.writeFileSync(path.join(cwd, name), content)
}

async function commit(run, name, content, message, date) {
  write(name, content)
  expect((await run(['add', '--', name])).ok).toBe(true)
  const result = await run(['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  })
  expect(result.ok).toBe(true)
  return result.stdout
}

describe('real Git history graph ordering', () => {
  it('reads child-before-parent order even when a parent commit date is newer', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglass-graph-order-'))
    const commands = new GitCommandService()
    const run = (argv, env = null) => commands.run({ argv, intent: 'Fixture', source: 'background', cwd, env })
    const repository = new RepositoryService(commands, () => cwd)

    expect((await run(['init', '-b', 'main'])).ok).toBe(true)
    expect((await run(['config', 'user.name', 'Graph Order Test'])).ok).toBe(true)
    expect((await run(['config', 'user.email', 'graph-order@test.local'])).ok).toBe(true)
    await commit(run, 'root.txt', 'root\n', 'root', '2020-01-01T00:00:00+00:00')

    expect((await run(['switch', '-c', 'feature'])).ok).toBe(true)
    await commit(run, 'feature.txt', 'feature\n', 'feature dated in the future', '2030-01-01T00:00:00+00:00')

    expect((await run(['switch', 'main'])).ok).toBe(true)
    await commit(run, 'main.txt', 'main\n', 'main after root', '2021-01-01T00:00:00+00:00')

    const merge = await run(['merge', '--no-ff', 'feature', '-m', 'merge with a future-dated parent'], {
      GIT_AUTHOR_DATE: '2022-01-01T00:00:00+00:00',
      GIT_COMMITTER_DATE: '2022-01-01T00:00:00+00:00',
    })
    expect(merge.ok).toBe(true)

    const history = await repository.commits()
    expect(history.record.argv).toContain('--topo-order')
    const order = new Map(history.commits.map((entry, index) => [entry.hash, index]))
    const mergeCommit = history.commits.find((entry) => entry.subject === 'merge with a future-dated parent')
    const featureCommit = history.commits.find((entry) => entry.subject === 'feature dated in the future')
    const mainCommit = history.commits.find((entry) => entry.subject === 'main after root')
    expect(mergeCommit).toBeTruthy()
    expect(mergeCommit.parents).toHaveLength(2)
    expect(order.get(mergeCommit.hash)).toBeLessThan(order.get(featureCommit.hash))
    expect(order.get(mergeCommit.hash)).toBeLessThan(order.get(mainCommit.hash))

    // Every parent that is present in the page must appear after its child.
    for (const entry of history.commits) {
      for (const parent of entry.parents) {
        if (order.has(parent)) expect(order.get(parent)).toBeGreaterThan(order.get(entry.hash))
      }
    }

    const { layoutHistoryGraph } = await import('../../src/history-graph.js')
    const graph = layoutHistoryGraph(history.commits, { limit: 80 })
    const rows = new Map(graph.rows.map((row) => [row.hash, row]))
    for (const row of graph.rows) {
      for (const edge of row.parentEdges) {
        if (edge.omitted) continue
        if (!rows.has(edge.parent)) continue
        // A solid edge is only truthful when its lane is the lane the parent
        // actually occupies in the later row.
        expect(rows.get(edge.parent).lane).toBe(edge.toLane)
      }
    }
    expect(rows.get(mergeCommit.hash).parentEdges).toHaveLength(2)
  }, 30_000)
})
