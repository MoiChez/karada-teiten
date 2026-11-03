import { describe, expect, it } from 'vitest'
import type { Landmark } from '../src/domain/types'
import { mergeBurst } from '../src/domain/burst'
import { burstSigmaFraction, computePlaneMetrics, planeInputFrom } from '../src/domain/metrics'
import { applyCorrection } from '../src/domain/session'
import { LANDMARK_SIGMA_FRACTION } from '../src/domain/constants'
import { H, W, deg, frontPose, record } from './helpers'

/** 位置と大きさを変える（立ち位置・距離の違い）。noise は点ごとの決まったずれ（px） */
function transform(lms: Landmark[], o: { dx?: number; dy?: number; scale?: number; noise?: number; seed?: number } = {}): Landmark[] {
  const s = o.scale ?? 1
  const cx = W / 2
  const cy = H / 2
  return lms.map((l, i) => {
    const n = o.noise ? o.noise * Math.sin((i + 1) * 12.9898 + (o.seed ?? 0) * 78.233) : 0
    const m = o.noise ? o.noise * Math.cos((i + 1) * 4.1414 + (o.seed ?? 0) * 3.7) : 0
    return { ...l, x: (cx + (l.x * W - cx) * s + (o.dx ?? 0) + n) / W, y: (cy + (l.y * H - cy) * s + (o.dy ?? 0) + m) / H }
  })
}

const frame = (landmarks: Landmark[]) => ({ landmarks, width: W, height: H })
const metric = (rec: ReturnType<typeof record>, key: string, useCorrected = true) =>
  computePlaneMetrics(planeInputFrom(rec, useCorrected)).find((m) => m.key === key)!

function burstRecord(frames: Landmark[][]) {
  const m = mergeBurst('front', frames.map(frame))!
  const rec = record('front', m.landmarks)
  return { ...rec, burst: { frames: m.frames, repIndex: m.usedIndices.indexOf(m.repIndex), attempted: frames.length, spreadFrac: m.spreadFrac } }
}

describe('複数枚撮りの平均', () => {
  it('立ち位置と距離だけが違う 3 枚は、ぶれ 0 で元の形に戻る', () => {
    const base = frontPose({ leftShoulderDrop: 20 })
    const m = mergeBurst('front', [frame(base), frame(transform(base, { dx: 40, dy: -15, scale: 1.04 })), frame(transform(base, { dx: -25, dy: 10, scale: 0.97 }))])!
    expect(m.usedIndices).toEqual([0, 1, 2])
    expect(m.spreadFrac).not.toBeNull()
    expect(m.spreadFrac!).toBeLessThan(1e-4)
    // 平均した点で求めた肩の傾きは、元の写真と同じ
    const rec = record('front', m.landmarks)
    expect(metric(rec, 'front_shoulder_tilt').rawValue).toBeCloseTo(deg(Math.atan(20 / 360)), 1)
  })

  it('点のぶれは、各写真の点のずれの大きさを体の高さ比で表す', () => {
    const base = frontPose()
    const frames = [0, 1, 2].map((k) => transform(base, { noise: 6, seed: k + 1, dx: k * 10 }))
    const m = mergeBurst('front', frames.map(frame))!
    // 1 点あたり x・y それぞれ振幅 6px の決まったずれ → 標準偏差はおよそ 4px 前後、体の高さ 1540px の 0.1〜0.5%
    expect(m.spreadFrac!).toBeGreaterThan(0.0008)
    expect(m.spreadFrac!).toBeLessThan(0.005)
  })

  it('代表の写真は、平均の形に最も近い 1 枚', () => {
    const base = frontPose()
    const m = mergeBurst('front', [frame(transform(base, { noise: 25, seed: 9 })), frame(transform(base, { noise: 2, seed: 2 })), frame(transform(base, { noise: 2, seed: 3, dx: 30 }))])!
    expect(m.repIndex).not.toBe(0)
  })

  it('骨格を検出できた写真が 2 枚未満なら null', () => {
    const base = frontPose()
    expect(mergeBurst('front', [frame(base), frame([]), frame([])])).toBeNull()
    // 足首が見えていない写真は使わない
    const hidden = frontPose({ vis: { 27: 0.1, 28: 0.1 } })
    const m = mergeBurst('front', [frame(base), frame(hidden), frame(transform(base, { dx: 5 }))])!
    expect(m.usedIndices).toEqual([0, 2])
  })
})

describe('複数枚撮りの判定', () => {
  it('ぶれが想定より小さいときは、想定値を √枚数 で割ったばらつきを使う', () => {
    const base = frontPose({ leftShoulderDrop: 20 })
    const single = record('front', base)
    const rec = burstRecord([base, transform(base, { dx: 20 }), transform(base, { dx: -20, scale: 1.02 })])
    expect(burstSigmaFraction(rec.burst)).toBeCloseTo(LANDMARK_SIGMA_FRACTION / Math.sqrt(3), 6)
    const u1 = metric(single, 'front_shoulder_tilt').uncertainty!
    const u3 = metric(rec, 'front_shoulder_tilt').uncertainty!
    expect(u3 / u1).toBeCloseTo(1 / Math.sqrt(3), 1)
  })

  it('ぶれが想定より大きいときは、実測のぶれを使う', () => {
    const rec = { ...record('front', frontPose()), burst: { frames: [frontPose(), frontPose()], repIndex: 0, attempted: 2, spreadFrac: 0.02 } }
    expect(burstSigmaFraction(rec.burst)).toBeCloseTo(0.02 / Math.sqrt(2), 6)
    const single = record('front', frontPose())
    expect(metric(rec, 'front_shoulder_tilt').uncertainty!).toBeGreaterThan(metric(single, 'front_shoulder_tilt').uncertainty! * 2)
  })

  it('1 枚ごとの値を残し、平均の値はその平均に近い', () => {
    const frames = [18, 20, 22].map((d) => frontPose({ leftShoulderDrop: d }))
    const rec = burstRecord(frames)
    const m = metric(rec, 'front_shoulder_tilt')
    expect(m.burstValues).toHaveLength(3)
    const expected = [18, 20, 22].map((d) => deg(Math.atan(d / 360)))
    m.burstValues!.forEach((v, i) => expect(v!).toBeCloseTo(expected[i], 1))
    expect(m.rawValue!).toBeCloseTo(deg(Math.atan(20 / 360)), 1)
  })

  it('平均した点を補正すると、1 枚ごとの値も同じだけ動く', () => {
    const frames = [18, 20, 22].map((d) => frontPose({ leftShoulderDrop: d }))
    const rec = burstRecord(frames)
    const before = metric(rec, 'front_shoulder_tilt').burstValues!
    const ls = rec.landmarksCorrected[11]
    const moved = applyCorrection(rec, 11, { x: ls.x, y: ls.y + 30 / H }, undefined, false)
    const after = metric(moved, 'front_shoulder_tilt').burstValues!
    after.forEach((v, i) => expect(v! - before[i]!).toBeGreaterThan(3))
    // 補正前の値の計算では、1 枚ごとの値は元のまま
    expect(metric(moved, 'front_shoulder_tilt', false).burstValues).toEqual(before)
  })
})
