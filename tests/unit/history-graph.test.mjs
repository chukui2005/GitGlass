import { layoutHistoryGraph, summarizeHistoryGraph } from '../../src/history-graph.js'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccccccccccccccccccccccccccc'
const M = 'dddddddddddddddddddddddddddddddddddddddd'
const OLD = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

function commit(hash, parents, subject = hash.slice(0, 7)) {
  return { hash, parents, subject, shortHash: hash.slice(0, 7) }
}

describe('bounded history graph layout', () => {
  it('draws a fork and every parent edge of a multi-parent merge', () => {
    // M is a merge of B (first parent) and C; B and C both lead to A.
    const graph = layoutHistoryGraph([
      commit(M, [B, C], 'merge feature'),
      commit(B, [A], 'main work'),
      commit(C, [A], 'feature work'),
      commit(A, [], 'root'),
    ])

    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(graph.rows[0].parentEdges).toEqual([
      { parent: B, fromLane: 0, toLane: 0, first: true, boundary: false },
      { parent: C, fromLane: 0, toLane: 1, first: false, boundary: false },
    ])
    // C's only parent A is already on B's lane: the graph curves back instead
    // of pretending C is a separate root.
    expect(graph.rows[2].parentEdges).toEqual([
      { parent: A, fromLane: 1, toLane: 0, first: true, boundary: false },
    ])
    expect(graph.boundaryCount).toBe(0)
    expect(summarizeHistoryGraph(graph)).toMatchObject({ commits: 4, parentEdges: 4, mergeCommits: 1, boundaryEdges: 0 })
  })

  it('marks a parent outside the read window as a boundary instead of dropping it', () => {
    const graph = layoutHistoryGraph([
      commit(C, [B]),
      commit(B, [OLD]),
    ], { limit: 2 })

    expect(graph.rows[1].boundaryParents).toEqual([OLD])
    expect(graph.rows[1].parentEdges[0]).toMatchObject({ parent: OLD, boundary: true })
    expect(graph.boundaryCount).toBe(1)
    expect(graph.atLimit).toBe(true)
    expect(graph.truncated).toBe(false)
    expect(summarizeHistoryGraph(graph)).toMatchObject({ boundaryEdges: 1, atLimit: true, truncated: false })
  })

  it('carries a truncated read into the graph summary even before the page limit', () => {
    const graph = layoutHistoryGraph([commit(C, [B]), commit(B, [A])], { limit: 200, truncated: true })
    expect(graph.atLimit).toBe(false)
    expect(graph.truncated).toBe(true)
    expect(summarizeHistoryGraph(graph)).toMatchObject({ atLimit: false, truncated: true })
  })

  it('keeps both missing parents of a filtered merge visible as boundary edges', () => {
    // A keyword query can return a merge while hiding both parents.
    const graph = layoutHistoryGraph([
      commit(M, [B, C]),
      commit(A, []),
    ], { limit: 200 })

    expect(graph.rows[0].parentEdges.map((edge) => edge.boundary)).toEqual([true, true])
    expect(graph.rows[0].boundaryParents).toEqual([B, C])
    expect(graph.boundaryCount).toBe(2)
    // Boundary lanes are visual only; they must not become phantom active lanes.
    expect(graph.rows[1].lane).toBe(0)
  })

  it('caps lanes and reports overflow instead of drawing an unbounded canvas', () => {
    const parents = Array.from({ length: 10 }, (_, index) => `f${String(index).padStart(39, '0')}`)
    const graph = layoutHistoryGraph([commit(M, parents)], { maxLanes: 2, limit: 10 })
    expect(graph.laneCount).toBeLessThanOrEqual(2)
    expect(graph.overflow).toBe(true)
    expect(graph.rows[0].lane).toBeLessThan(2)
  })

  it('handles an empty or malformed list without fabricating rows', () => {
    expect(layoutHistoryGraph([])).toMatchObject({ rows: [], boundaryCount: 0, overflow: false })
    expect(layoutHistoryGraph(null).rows).toEqual([])
    expect(layoutHistoryGraph([{ hash: '', parents: [A] }]).rows).toEqual([])
  })
})
