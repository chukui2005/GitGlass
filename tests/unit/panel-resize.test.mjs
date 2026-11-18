import { describe, expect, it } from 'vitest'
import {
  PANEL_BOUNDS,
  PANEL_KEYBOARD_STEP,
  PANEL_WIDTH_STORAGE_KEY,
  clampPanelWidth,
  constrainPanelWidths,
  defaultPanelWidths,
  keyboardPanelWidth,
  panelLimits,
  parsePanelWidths,
  serializePanelWidths,
} from '../../src/panel-resize.js'

describe('panel width model', () => {
  it('exposes the documented storage key and defaults', () => {
    expect(PANEL_WIDTH_STORAGE_KEY).toBe('gitglass.panel-widths')
    expect(defaultPanelWidths()).toEqual({ left: 224, right: 296 })
    expect(PANEL_BOUNDS.left.min).toBe(190)
    expect(PANEL_BOUNDS.right.min).toBe(240)
    expect(PANEL_KEYBOARD_STEP).toBe(8)
  })

  it('clamps widths to the side bounds and falls back on non-numeric input', () => {
    expect(clampPanelWidth('left', 300, { min: 190, max: 420 })).toBe(300)
    expect(clampPanelWidth('left', 100, { min: 190, max: 420 })).toBe(190)
    expect(clampPanelWidth('left', 999, { min: 190, max: 420 })).toBe(420)
    expect(clampPanelWidth('right', 240.6, { min: 240, max: 420 })).toBe(241)
    expect(clampPanelWidth('right', Number.NaN, { min: 240, max: 420 })).toBe(296)
  })

  it('keeps the 440px main column and both 1px splitters inside the workspace', () => {
    // 1024 - 296 (other panel) - 440 (main) - 2 (splitters)
    expect(panelLimits('left', { left: 224, right: 296 }, 1024)).toEqual({ min: 190, max: 286 })
    expect(panelLimits('right', { left: 224, right: 296 }, 1024)).toEqual({ min: 240, max: 358 })
    // Wide windows stop at the per-side maximum.
    expect(panelLimits('left', { left: 224, right: 296 }, 1440)).toEqual({ min: 190, max: 420 })
    // Very narrow windows never go below the minimum.
    expect(panelLimits('left', { left: 224, right: 296 }, 800)).toEqual({ min: 190, max: 190 })
  })

  it('re-clamps both sides when the window narrows', () => {
    expect(constrainPanelWidths({ left: 300, right: 260 }, 1024)).toEqual({ left: 300, right: 260 })
    // The left side is clamped first, then the right side uses the clamped left width.
    expect(constrainPanelWidths({ left: 400, right: 400 }, 1024)).toEqual({ left: 190, right: 392 })
    expect(constrainPanelWidths({ left: 300, right: 300 }, 800)).toEqual({ left: 190, right: 240 })
    expect(constrainPanelWidths(null, 1024)).toEqual({ left: 224, right: 296 })
  })

  it('moves the splitter with arrow keys and jumps to the bounds with Home/End', () => {
    const limits = { min: 190, max: 420 }
    expect(keyboardPanelWidth('left', 224, 'ArrowRight', limits)).toBe(232)
    expect(keyboardPanelWidth('left', 224, 'ArrowLeft', limits)).toBe(216)
    // The right panel shrinks when the splitter moves right.
    expect(keyboardPanelWidth('right', 296, 'ArrowRight', { min: 240, max: 420 })).toBe(288)
    expect(keyboardPanelWidth('right', 296, 'ArrowLeft', { min: 240, max: 420 })).toBe(304)
    expect(keyboardPanelWidth('left', 224, 'Home', limits)).toBe(190)
    expect(keyboardPanelWidth('left', 224, 'End', limits)).toBe(420)
    expect(keyboardPanelWidth('left', 224, 'Enter', limits)).toBe(224)
    expect(keyboardPanelWidth('right', 260, 'Enter', { min: 240, max: 420 })).toBe(296)
    // Enter cannot push the panel past the current layout maximum.
    expect(keyboardPanelWidth('left', 224, 'Enter', { min: 190, max: 200 })).toBe(200)
    expect(keyboardPanelWidth('left', 224, 'Tab', limits)).toBeNull()
  })

  it('parses persisted widths and falls back to defaults for damaged data', () => {
    expect(parsePanelWidths('{"left":300,"right":260}')).toEqual({ left: 300, right: 260 })
    expect(parsePanelWidths('{"left":900,"right":10}')).toEqual({ left: 420, right: 240 })
    expect(parsePanelWidths('{"left":"300"}')).toEqual({ left: 224, right: 296 })
    expect(parsePanelWidths('{"left":250}')).toEqual({ left: 250, right: 296 })
    expect(parsePanelWidths('not json')).toEqual({ left: 224, right: 296 })
    expect(parsePanelWidths('[1,2]')).toEqual({ left: 224, right: 296 })
    expect(parsePanelWidths(null)).toEqual({ left: 224, right: 296 })
    expect(parsePanelWidths({ left: 250 })).toEqual({ left: 250, right: 296 })
  })

  it('serializes only finite, rounded, in-range widths', () => {
    expect(serializePanelWidths({ left: 300.4, right: 259.6 })).toBe('{"left":300,"right":260}')
    expect(serializePanelWidths({ left: 900, right: 10 })).toBe('{"left":420,"right":240}')
    expect(serializePanelWidths(null)).toBe('{"left":224,"right":296}')
    expect(parsePanelWidths(serializePanelWidths({ left: 250, right: 300 }))).toEqual({ left: 250, right: 300 })
  })
})
