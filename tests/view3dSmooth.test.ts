import { describe, expect, it } from 'vitest'
import { smoothSeries, stabilizeArms, type FramePoints } from '../src/domain/view3dSmooth'
import type { Vec3 } from '../src/domain/fusion3d'

const ts = Array.from({ length: 120 }, (_, i) => i * 33.3)

/** 乱数（決まった種） */
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('3D の体を時間でなめらかにする', () => {
  it('一定の値は変えず、コマごとの揺れは小さくする', () => {
    expect(smoothSeries(ts.map(() => 3), ts, 80).every((v) => Math.abs(v - 3) < 1e-9)).toBe(true)
    const r = rng(1)
    const noisy = ts.map(() => r() - 0.5)
    const s = smoothSeries(noisy, ts, 80)
    const jump = (v: number[]) => v.slice(1).reduce((a, x, i) => a + Math.abs(x - v[i]), 0) / (v.length - 1)
    expect(jump(s)).toBeLessThan(jump(noisy) * 0.3)
  })
})

describe('腕を胴に対して落ち着かせる', () => {
  // 胴が前へ傾いていく（スクワット）。手首とひじは胴に対して決まった位置（バーを担ぐ）。4 コマに 1 コマ、手首が頭の横へ外れる
  function frames(outliers: boolean): FramePoints[] {
    const r = rng(7)
    return ts.map((t, i) => {
      const lean = (Math.sin(t / 600) * 0.5 + 0.5) * 0.6 // 0〜0.6 rad
      const up: Vec3 = { x: 0, y: Math.cos(lean), z: Math.sin(lean) }
      const fwd: Vec3 = { x: 0, y: -Math.sin(lean), z: Math.cos(lean) }
      const at = (o: Vec3, lx: number, ly: number, lz: number): Vec3 => ({ x: o.x + lx, y: o.y + ly * up.y + lz * fwd.y, z: o.z + ly * up.z + lz * fwd.z })
      const hip: Vec3 = { x: 0, y: 0.5, z: 0 }
      const sh = at(hip, 0, 0.3, 0)
      const f: FramePoints = new Map()
      f.set(23, { x: 0.09, y: 0.5, z: 0 })
      f.set(24, { x: -0.09, y: 0.5, z: 0 })
      f.set(11, at(sh, 0.1, 0, 0))
      f.set(12, at(sh, -0.1, 0, 0))
      f.set(13, at(sh, 0.2, -0.05, -0.08))
      f.set(14, at(sh, -0.2, -0.05, -0.08))
      const bad = outliers && i % 4 === 1
      f.set(15, bad ? at(sh, 0.05 + r() * 0.05, 0.15, 0) : at(sh, 0.3, 0.02, -0.05))
      f.set(16, bad ? at(sh, -0.05, 0.15, 0) : at(sh, -0.3, 0.02, -0.05))
      return f
    })
  }

  it('外れたコマがあっても、手首は胴に対する本来の位置に戻る（胴が傾いても胴についていく）', () => {
    const clean = frames(false)
    const fixed = stabilizeArms(frames(true), ts, 1000)
    for (let i = 0; i < ts.length; i++) {
      for (const m of [13, 14, 15, 16]) {
        const a = fixed[i].get(m)!
        const b = clean[i].get(m)!
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.01)
      }
    }
  })

  it('肩・股関節など腕でない点は変えない', () => {
    const src = frames(true)
    const fixed = stabilizeArms(src, ts, 1000)
    for (let i = 0; i < ts.length; i += 7) for (const m of [11, 12, 23, 24]) expect(fixed[i].get(m)).toEqual(src[i].get(m))
  })
})
