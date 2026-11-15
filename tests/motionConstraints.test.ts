import { describe, expect, it } from 'vitest'
import { constrainErg, kneeFromAngle, kneeFromBones, kneeSide, legBones, placeKnee, pxToNorm } from '../src/domain/motionConstraints'
import { interiorAngleDeg } from '../src/domain/geometry'
import { uprightPx, type PreparedFrame } from '../src/domain/motionCore'
import { sidePoints } from '../src/domain/landmarks'
import type { Point } from '../src/domain/types'

const s = sidePoints('left')
const W = 1000
const H = 600

function frameOf(t: number, pts: Partial<Record<number, Point>>): PreparedFrame {
  const px: Point[] = Array.from({ length: 33 }, () => ({ x: 500, y: 300 }))
  for (const [i, p] of Object.entries(pts)) px[Number(i)] = p!
  return { t, px, lm: px.map((p) => ({ x: p.x / W, y: p.y / H, z: 0, visibility: 1 })), edited: [], constrained: [] }
}

describe('膝を骨の長さから置く', () => {
  it('2 つの円の交点のうち、もとの膝と同じ側を選ぶ', () => {
    const up = kneeFromBones({ x: 0, y: 0 }, { x: 100, y: 0 }, 60, 60, { x: 50, y: -10 })
    expect(up.x).toBeCloseTo(50, 6)
    expect(up.y).toBeCloseTo(-Math.sqrt(60 * 60 - 50 * 50), 6)
    const down = kneeFromBones({ x: 0, y: 0 }, { x: 100, y: 0 }, 60, 60, { x: 50, y: 10 })
    expect(down.y).toBeCloseTo(Math.sqrt(60 * 60 - 50 * 50), 6)
  })

  it('届かないときは、脚をまっすぐ伸ばした位置にする', () => {
    const k = kneeFromBones({ x: 0, y: 0 }, { x: 130, y: 0 }, 60, 70, { x: 70, y: 5 })
    expect(k.x).toBeCloseTo(60, 6)
    expect(k.y).toBeCloseTo(0, 6)
  })

  it('画像に対する比へ戻すと、傾きを戻す前の位置になる', () => {
    const lm = [{ x: 0.3, y: 0.7, z: 0 }]
    const px = uprightPx(lm, W, H, 7)[0]
    const back = pxToNorm(px, { width: W, height: H, rollDeg: 7 })
    expect(back.x).toBeCloseTo(0.3, 9)
    expect(back.y).toBeCloseTo(0.7, 9)
  })
})

describe('エルゴの前提', () => {
  // 腰はレール（高さ 300）を前後に動き、足首は (700, 300) に留まる。太もも 160・すね 170
  const thigh = 160
  const shank = 170
  const ankle = { x: 700, y: 300 }
  const frames = Array.from({ length: 60 }, (_, k) => {
    const hipX = 400 + 180 * (0.5 + 0.5 * Math.cos((2 * Math.PI * k) / 30))
    const hip = { x: hipX, y: 300 + (k % 2 ? 1 : -1) }
    const knee = kneeFromBones(hip, ankle, thigh, shank, { x: 600, y: 0 })
    // 体が縮んだコマ（腰が足首に近い）ほど、推定の膝が股関節の方へずれる
    const reach = ankle.x - hipX
    const err = reach < 200 ? (200 - reach) * 0.6 : 0
    return frameOf(k * 33, {
      [s.hip]: hip,
      [s.knee]: { x: knee.x - err, y: knee.y + err * 0.5 },
      [s.ankle]: { x: ankle.x + (k % 3) - 1, y: ankle.y + (k % 2) },
      [s.shoulder]: { x: hipX - 20, y: 100 },
    })
  })

  it('足首を留め、腰をレールに乗せ、ずれた膝を骨の長さから置き直す', () => {
    const work = frames.map((f) => ({ ...f, px: [...f.px], lm: [...f.lm], constrained: [] as number[] }))
    const notes = constrainErg(work, s, { width: W, height: H }, thigh + shank)
    expect(notes.find((n) => n.key === 'footplate')?.applied).toBe(true)
    expect(notes.find((n) => n.key === 'rail')?.applied).toBe(true)
    const bones = legBones(frames, s)!
    expect(bones.thigh).toBeCloseTo(thigh, 0)
    for (const [k, fr] of work.entries()) {
      const truth = kneeFromBones({ x: frames[k].px[s.hip].x, y: 300 }, ankle, thigh, shank, { x: 600, y: 0 })
      expect(Math.hypot(fr.px[s.knee].x - truth.x, fr.px[s.knee].y - truth.y)).toBeLessThan(3)
      expect(fr.constrained).toContain(s.knee)
      // 画像に重ねる点も同じ位置に動く
      expect(fr.lm[s.knee].x * W).toBeCloseTo(fr.px[s.knee].x, 6)
    }
  })

  it('手で直した点は書き換えない', () => {
    const work = frames.map((f) => ({ ...f, px: [...f.px], lm: [...f.lm], constrained: [] as number[] }))
    work[5].edited = [s.knee]
    const before = { ...work[5].px[s.knee] }
    constrainErg(work, s, { width: W, height: H }, thigh + shank)
    expect(work[5].px[s.knee]).toEqual(before)
    expect(work[5].constrained).not.toContain(s.knee)
  })

  it('足首が大きく動く映像（手持ちなど）では、足首を留めない', () => {
    const work = frames.map((f, k) => {
      const px = [...f.px]
      px[s.ankle] = { x: 700 + 60 * Math.sin(k), y: 300 + 40 * Math.cos(k) }
      return { ...f, px, lm: [...f.lm], constrained: [] as number[] }
    })
    const notes = constrainErg(work, s, { width: W, height: H }, thigh + shank)
    expect(notes.find((n) => n.key === 'footplate')?.applied).toBe(false)
    expect(work[3].constrained).not.toContain(s.ankle)
  })
})

describe('伸びかけの脚（カクンと伸びないこと）', () => {
  const hip = { x: 0, y: 0 }
  const bones = { thigh: 60, shank: 60 }
  const flexAt = (k: { x: number; y: number }, ankle: { x: number; y: number }) => 180 - interiorAngleDeg(hip, k, ankle)

  it('角度で置いた膝は、指定の曲がりで、股関節と足首はそのまま', () => {
    const ankle = { x: 110, y: 0 }
    for (const f of [0, 10, 40, 90]) {
      const k = kneeFromAngle(hip, ankle, 60, 50, f, -1)
      expect(flexAt(k, ankle)).toBeCloseTo(f, 5)
      // 太もも : すね = 60 : 50
      expect(Math.hypot(k.x, k.y) / Math.hypot(k.x - ankle.x, k.y - ankle.y)).toBeCloseTo(60 / 50, 5)
      if (f > 0) expect(k.y).toBeLessThan(0)
    }
  })

  it('縮んだ脚は骨の長さで、伸びかけは推定の膝の曲がりで置く', () => {
    // 縮んだ脚（距離は長さの合計の 60%）: 推定の膝がずれていても、骨の長さどおり
    const near = { x: 72, y: 0 }
    const kb = placeKnee(hip, near, { x: 20, y: -10 }, bones, -1)
    expect(Math.hypot(kb.x, kb.y)).toBeCloseTo(60, 5)
    // 伸びかけ（99%）: 骨の長さなら 16° ほど曲がるが、推定の膝がほぼまっすぐ（約 5°）なら、それに沿う
    const far = { x: 118.8, y: 0 }
    const raw = { x: 59.4, y: -2.6 }
    const k = placeKnee(hip, far, raw, bones, -1)
    expect(flexAt(k, far)).toBeCloseTo(flexAt(raw, far), 5)
    expect(flexAt(kneeFromBones(hip, far, 60, 60, raw), far)).toBeGreaterThan(14)
  })

  it('腰が遠ざかっていくとき、膝の曲がりは 1 コマで大きく跳ばない（伸び切る瞬間も）', () => {
    // 実際の脚: 骨は 1 割長く写るコマもある（画面の上の長さの揺れ）。推定の膝は実際の曲がりの位置にある
    let prev = NaN
    for (let i = 0; i <= 40; i++) {
      const d = 100 + i * 0.6 // 長さの合計 120 の 83%〜103%
      const ankle = { x: d, y: 0 }
      const truthFlex = Math.max(0, 40 - i * 1.1)
      const raw = kneeFromAngle(hip, ankle, 60, 60, truthFlex, -1)
      const f = flexAt(placeKnee(hip, ankle, raw, bones, -1), ankle)
      if (Number.isFinite(prev)) expect(Math.abs(f - prev)).toBeLessThan(4)
      prev = f
    }
  })

  it('推定の膝が線の反対へ揺れても、反対へは折れない', () => {
    const far = { x: 119, y: 0 }
    const k = placeKnee(hip, far, { x: 59, y: 4 }, bones, -1)
    expect(k.y).toBeLessThanOrEqual(1e-9)
    expect(flexAt(k, far)).toBeLessThan(3)
  })

  it('膝が曲がる側は、記録の多い側に決まる', () => {
    const ankle = { x: 700, y: 300 }
    const frames = Array.from({ length: 60 }, (_, k) => {
      const hipX = 370 + 200 * (0.5 + 0.5 * Math.cos((2 * Math.PI * k) / 30))
      const hipP = { x: hipX, y: 300 }
      const knee = kneeFromBones(hipP, ankle, 160, 170, { x: 600, y: 0 })
      const wobble = ankle.x - hipX > 320 ? 6 : 0
      return frameOf(k * 33, { [s.hip]: hipP, [s.knee]: wobble ? { x: knee.x, y: 300 + wobble } : knee, [s.ankle]: ankle })
    })
    // 曲がったコマの膝は線の上（y が小さい）。股関節→足首は +x なので、外積は負
    expect(kneeSide(frames, s, 330)).toBe(-1)
  })
})
