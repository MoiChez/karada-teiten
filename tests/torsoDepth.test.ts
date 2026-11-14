import { describe, expect, it } from 'vitest'
import type { Landmark } from '../src/domain/types'
import type { MaskData } from '../src/domain/backContour'
import { TORSO_FRAMES, TORSO_ROWS, evenPicks, torsoDepthRows, torsoProfileOf } from '../src/domain/torsoDepth'

const W = 400
const H = 600

/** 横から見た、まっすぐ座った体（顔は画像の右）。胴は幅 depth の長方形、太ももは前へ水平 */
function seated(depth: number, opts: { armAtChest?: boolean; thighUp?: boolean } = {}) {
  const hip = { x: 200, y: 400 }
  const sh = { x: 200, y: 220 }
  const pts: Record<number, { x: number; y: number }> = {
    0: { x: 240, y: 160 },
    7: { x: 205, y: 165 },
    11: sh,
    23: hip,
    // 太ももは前へ。thighUp なら膝が胸の前まで上がる（キャッチ）
    25: opts.thighUp ? { x: 245, y: 260 } : { x: 330, y: 400 },
    27: opts.thighUp ? { x: 250, y: 420 } : { x: 330, y: 540 },
    // 腕は前へ。armAtChest なら胸の前の面に沿って下りる
    13: opts.armAtChest ? { x: 200 + depth / 2 + 4, y: 300 } : { x: 300, y: 230 },
    15: opts.armAtChest ? { x: 200 + depth / 2 + 4, y: 360 } : { x: 380, y: 240 },
    19: opts.armAtChest ? { x: 200 + depth / 2 + 4, y: 380 } : { x: 395, y: 242 },
  }
  const lm: Landmark[] = []
  for (let i = 0; i < 33; i++) {
    const base = i === 0 ? 0 : i % 2 === 1 ? i : i - 1
    const p = pts[base] ?? pts[0]
    lm.push({ x: p.x / W, y: p.y / H, z: 0, visibility: 0.9 })
  }
  const data = new Float32Array(W * H)
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) data[y * W + x] = 1
  }
  // 胴（股関節〜肩）と頭
  fill(200 - depth / 2, 200, 200 + depth / 2, 420)
  fill(185, 130, 245, 200)
  // 太もも（前へ）と、上がった太もも・膝
  if (opts.thighUp) {
    // 股関節 (200, 400) → 膝 (245, 260) の線のまわり（太さ 50）
    for (let y = 250; y < 410; y++) {
      const x = 200 + (45 * (400 - y)) / 140
      fill(x - 25, y, x + 25, y + 1)
    }
  } else fill(200, 385, 340, 415)
  // 胸の前に沿う腕
  if (opts.armAtChest) fill(200 + depth / 2 - 4, 230, 200 + depth / 2 + 14, 380)
  const mask: MaskData = { data, width: W, height: H }
  return { lm, mask }
}

describe('胴の前と後ろの輪郭（人の領域から）', () => {
  it('胴の線に垂直に、線から前と後ろの端までの距離を、脚の長さに対する比で測る', () => {
    const { lm, mask } = seated(100)
    const rows = torsoDepthRows(lm, mask, W, H)!
    // 脚の長さ: 股関節→膝 130、膝→足首 140。胴の線は胴の真ん中（前後に 50 ずつ）
    const leg = 270
    const back = rows.back.filter((v): v is number => v !== null)
    const front = rows.front.filter((v): v is number => v !== null)
    expect(back.length).toBe(TORSO_ROWS.length)
    // いちばん上の高さの前は、前へ出した腕の付け根に近いので測らない
    expect(front.length).toBeGreaterThanOrEqual(TORSO_ROWS.length - 2)
    for (const v of [...back, ...front]) {
      expect(v * leg).toBeGreaterThan(48)
      expect(v * leg).toBeLessThan(52)
    }
  })

  it('腕や太ももが胴の前に重なる高さは前を測らず、背中だけ測る', () => {
    const arm = seated(100, { armAtChest: true })
    const a = torsoDepthRows(arm.lm, arm.mask, W, H)!
    expect(a.front.filter((v) => v !== null).length).toBeLessThan(3)
    expect(a.back.filter((v) => v !== null).length).toBe(TORSO_ROWS.length)
    const knee = seated(100, { thighUp: true })
    const k = torsoDepthRows(knee.lm, knee.mask, W, H)!
    expect(k.front.filter((v) => v !== null).length).toBeLessThan(TORSO_ROWS.length)
    expect(k.back.filter((v) => v !== null).length).toBe(TORSO_ROWS.length)
  })

  it('記録の値は、高さごとの中央値（3 枚未満の高さは null）', () => {
    const row = (b0: number | null, b1: number | null) => ({ front: TORSO_ROWS.map(() => null), back: [b0, b1, ...TORSO_ROWS.slice(2).map(() => null)] })
    const p = torsoProfileOf([row(0.3, 0.3), row(0.4, 0.32), row(0.2, null)])!
    expect(p.back[0]).toBeCloseTo(0.3, 9)
    expect(p.back[1]).toBeNull()
    expect(p.front.every((v) => v === null)).toBe(true)
    expect(torsoProfileOf([row(0.3, 0.3), row(0.4, 0.3)])).toBeNull()
  })

  it('カメラ側を渡すと、その側の股関節と肩の点で引いた線から測る（奥の肩の点がずれても変わらない）', () => {
    const { lm, mask } = seated(100)
    const base = torsoDepthRows(lm, mask, W, H, undefined, 'left')!
    // 奥（右）の肩の点が 30 ピクセル前へずれる（フィニッシュで起こる）
    const moved = lm.map((l, i) => (i === 12 ? { ...l, x: l.x + 30 / W } : l))
    const side = torsoDepthRows(moved, mask, W, H, undefined, 'left')!
    expect(side.back).toEqual(base.back)
    // 渡さないと、左右の真ん中の線になり、背中までの距離が変わる
    const midLine = torsoDepthRows(moved, mask, W, H)!
    expect(midLine.back[9]! - base.back[9]!).toBeGreaterThan(0.02)
  })

  it('測るコマは、全体から等間隔に選ぶ（人の輪郭と 3D で同じコマ）', () => {
    const picks = evenPicks(600)
    expect(picks.length).toBe(TORSO_FRAMES)
    expect(picks[0]).toBe(19)
    expect(picks[15]).toBe(581)
    expect(evenPicks(5)).toEqual([0, 1, 2, 3, 4])
    expect(evenPicks(0)).toEqual([])
  })
})
