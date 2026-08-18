import { describe, test, expect } from 'bun:test'
import {
  screenToWorld,
  clampWorldToScreen,
  edgeScreenWidth,
  nodeDrawRadius,
  docDrawWidth,
  nodeRadius,
  docWidth,
  MIN_NODE_SCREEN_PX,
  MAX_NODE_SCREEN_PX,
  MIN_DOC_SCREEN_W,
  MAX_DOC_SCREEN_W,
  MIN_EDGE_SCREEN_PX,
} from '../graphZoom'

describe('graphZoom', () => {
  test('screenToWorld：scale 组内把屏幕像素换成世界单位', () => {
    expect(screenToWorld(10, 2)).toBe(5)
    expect(screenToWorld(10, 0.5)).toBe(20)
    expect(screenToWorld(10, 1)).toBe(10)
  })

  test('clampWorldToScreen：k=1 时等于原始世界尺寸', () => {
    expect(clampWorldToScreen(10, 1, 4, 22)).toBe(10)
  })

  test('clampWorldToScreen：放大时屏幕半径封顶', () => {
    // 世界 18、k=3 → 屏幕 54，封顶 22 → 世界 22/3
    expect(clampWorldToScreen(18, 3, 4, 22)).toBeCloseTo(22 / 3)
  })

  test('clampWorldToScreen：缩小时屏幕半径保底', () => {
    // 世界 5、k=0.25 → 屏幕 1.25，保底 4 → 世界 16
    expect(clampWorldToScreen(5, 0.25, 4, 22)).toBe(4 / 0.25)
  })

  test('edgeScreenWidth 钉在屏幕像素，且不低于最小线宽', () => {
    expect(edgeScreenWidth(0, false)).toBe(MIN_EDGE_SCREEN_PX)
    expect(edgeScreenWidth(1, false)).toBeGreaterThanOrEqual(MIN_EDGE_SCREEN_PX)
    expect(edgeScreenWidth(1, true)).toBeGreaterThan(edgeScreenWidth(1, false))
  })

  test('nodeDrawRadius：k=1 等于数据半径；放大后屏幕尺寸不超过封顶', () => {
    const data = nodeRadius(100, 100)
    expect(nodeDrawRadius(100, 100, 1)).toBeCloseTo(data)
    expect(nodeDrawRadius(100, 100, 3) * 3).toBeLessThanOrEqual(MAX_NODE_SCREEN_PX + 1e-6)
    expect(nodeDrawRadius(1, 100, 0.25) * 0.25).toBeGreaterThanOrEqual(MIN_NODE_SCREEN_PX - 1e-6)
  })

  test('docDrawWidth：k=1 等于数据宽度；放大后屏幕宽度封顶、缩小时保底', () => {
    expect(docDrawWidth(1, 1, 1)).toBeCloseTo(docWidth(1, 1))
    expect(docDrawWidth(100, 100, 3) * 3).toBeLessThanOrEqual(MAX_DOC_SCREEN_W + 1e-6)
    expect(docDrawWidth(1, 100, 0.25) * 0.25).toBeGreaterThanOrEqual(MIN_DOC_SCREEN_W - 1e-6)
  })

  test('放大后小节点屏幕半径仍超过标签阈值（会出更多字）', () => {
    const screenAt3 = nodeDrawRadius(1, 100, 3) * 3
    expect(screenAt3).toBeGreaterThanOrEqual(8)
    const screenAt1 = nodeDrawRadius(1, 100, 1)
    expect(screenAt1).toBeLessThan(8)
  })
})
