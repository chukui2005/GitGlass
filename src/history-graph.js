// Pure swimlane layout for the bounded history graph.
//
// The input is exactly what `git log` / `git show -s` returned: commits in Git's
// display order with the full parent list (`%P`). No ancestry is invented. A
// parent that is absent from the current read window is kept as a *boundary*
// edge instead of being silently dropped, which is what makes a paginated,
// truncated or filtered view honest.
//
// Lanes are stable columns. Empty lanes are reused rather than compacted, so an
// edge that leaves a row always lands on the same x coordinate in the next row.
// The lane count is capped; `overflow` reports when a history is wider than the
// first version of the view can draw faithfully.

export const GRAPH_MAX_LANES = 7

function freeLane(lanes, start, maxLanes) {
  for (let index = Math.max(0, start); index < lanes.length; index += 1) {
    if (!lanes[index]) return index
  }
  for (let index = 0; index < Math.min(start, lanes.length); index += 1) {
    if (!lanes[index]) return index
  }
  if (lanes.length < maxLanes) {
    lanes.push(null)
    return lanes.length - 1
  }
  return -1
}

function rowSegments(before, lane) {
  const segments = []
  for (let index = 0; index < before.length; index += 1) {
    if (!before[index]) continue
    segments.push({ lane: index, from: 0, to: index === lane ? 0.5 : 1 })
  }
  return segments
}

function normalizeParents(commit) {
  return Array.isArray(commit?.parents) ? commit.parents.filter((parent) => typeof parent === 'string' && parent) : []
}

/**
 * @typedef {object} GraphEdge
 * @property {string} parent full parent commit id
 * @property {number} fromLane
 * @property {number} toLane
 * @property {boolean} first true for Git's first parent
 * @property {boolean} boundary parent is outside the current read window
 */

/**
 * @param {Array<Record<string, unknown>>} commits
 * @param {{ maxLanes?: number, limit?: number, truncated?: boolean }} [options]
 */
export function layoutHistoryGraph(commits, options = {}) {
  const list = Array.isArray(commits) ? commits.filter((commit) => typeof commit?.hash === 'string' && commit.hash) : []
  const maxLanes = Number.isSafeInteger(options.maxLanes) && options.maxLanes > 0 ? options.maxLanes : GRAPH_MAX_LANES
  const known = new Set(list.map((commit) => commit.hash))
  const lanes = []
  let overflow = false
  let boundaryCount = 0

  const rows = list.map((commit) => {
    const parents = normalizeParents(commit)
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = lanes.findIndex((value) => !value)
      if (lane === -1 && lanes.length < maxLanes) {
        lane = lanes.length
        lanes.push(null)
      }
      if (lane === -1) {
        lane = maxLanes - 1
        overflow = true
      }
    }
    // Put the commit in its lane first so the row knows it has an incoming
    // segment even when this commit is the first row of the window.
    lanes[lane] = commit.hash
    const before = lanes.slice()
    lanes[lane] = null
    /** @type {GraphEdge[]} */
    const parentEdges = []

    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index]
      const first = index === 0
      const boundary = !known.has(parent)
      let target = lanes.indexOf(parent)
      if (boundary) {
        // A boundary lane is drawn but not retained: no later row will consume
        // it, and retaining it would create a phantom branch all the way down.
        if (first) target = lane
        else {
          target = Math.min(lane + index, maxLanes - 1)
          if (lane + index >= maxLanes) overflow = true
        }
      } else if (target === -1) {
        target = first ? lane : freeLane(lanes, lane + 1, maxLanes)
        if (target === -1) {
          target = Math.max(0, lane - 1)
          overflow = true
        }
        if (!lanes[target]) lanes[target] = parent
      }
      parentEdges.push({ parent, fromLane: lane, toLane: target, first, boundary })
      if (boundary) boundaryCount += 1
    }

    const after = lanes.slice()
    const laneCount = Math.max(before.length, after.length, lane + 1, ...parentEdges.map((edge) => edge.toLane + 1))
    return {
      hash: commit.hash,
      lane,
      laneCount,
      parents,
      segments: rowSegments(before, lane),
      parentEdges,
      boundaryParents: parentEdges.filter((edge) => edge.boundary).map((edge) => edge.parent),
    }
  })

  const width = rows.reduce((maximum, row) => Math.max(maximum, row.laneCount), 1)
  return {
    rows,
    laneCount: Math.min(width, maxLanes),
    boundaryCount,
    atLimit: Number.isSafeInteger(options.limit) && options.limit > 0 && list.length >= options.limit,
    truncated: options.truncated === true,
    overflow,
  }
}

export function summarizeHistoryGraph(graph) {
  const rows = Array.isArray(graph?.rows) ? graph.rows : []
  return {
    commits: rows.length,
    parentEdges: rows.reduce((total, row) => total + row.parentEdges.length, 0),
    boundaryEdges: rows.reduce((total, row) => total + row.boundaryParents.length, 0),
    mergeCommits: rows.filter((row) => row.parents.length > 1).length,
    atLimit: graph?.atLimit === true,
    truncated: graph?.truncated === true,
    overflow: graph?.overflow === true,
  }
}
