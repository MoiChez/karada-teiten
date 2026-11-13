import { describe, expect, it } from 'vitest'
import { crankAngles, crankProfile, fitCircle } from '../src/domain/motionCrank'
import { drivePeaks, strokeProfile } from '../src/domain/motionSequence'
import { barSeries } from '../src/domain/motionBar'
import { sidePoints } from '../src/domain/landmarks'
import type { MotionCycle, PreparedMotion } from '../src/domain/motion'
import type { Point } from '../src/domain/types'

const s = sidePoints('left')

function prepOf(n: number, place: (k: number, px: Point[]) => void, extra: Partial<PreparedMotion> = {}): PreparedMotion {
  const frames = Array.from({ length: n }, (_, k) => {
    const px: Point[] = Array.from({ length: 33 }, () => ({ x: 500, y: 500 }))
    place(k, px)
    return { t: k * 33, px, lm: px.map((p) => ({ x: p.x / 1000, y: p.y / 1000, z: 0 })), edited: [], constrained: [] }
  })
  return { frames, f: 1, nearSide: 'left', leg: 300, breaks: new Set(), constraints: [], kind: 'bike', standLeg: 300, series: {}, ...extra } as unknown as PreparedMotion
}

describe('クランクの角度', () => {
  it('円の上の点から、中心と半径が戻る', () => {
    const ps = Array.from({ length: 40 }, (_, k) => ({ x: 300 + 80 * Math.cos(k / 6), y: 200 + 80 * Math.sin(k / 6) }))
    const c = fitCircle(ps)!
    expect(c.cx).toBeCloseTo(300, 6)
    expect(c.cy).toBeCloseTo(200, 6)
    expect(c.r).toBeCloseTo(80, 6)
    expect(c.rms).toBeLessThan(1e-6)
  })

  // 右を向いて前にこぐ: 上 → 前（画面の右）→ 下 → 後ろ
  const turning = (dir: 1 | -1) =>
    prepOf(90, (k, px) => {
      const a = (dir * 2 * Math.PI * k) / 30
      px[s.ankle] = { x: 500 + 60 * Math.sin(a), y: 600 - 60 * Math.cos(a) }
    })

  it('上死点が 0°、前が 90° で、こぐ向きに増える', () => {
    const c = crankAngles(turning(1))!
    expect(c.reversed).toBe(false)
    expect(Math.min(c.angle[0], 360 - c.angle[0])).toBeCloseTo(0, 6)
    expect(c.angle[7]).toBeCloseTo(84, 0)
    expect(c.angle[15]).toBeCloseTo(180, 6)
  })

  it('後ろ向きに回っていても、回る向きに角度を数える', () => {
    const c = crankAngles(turning(-1))!
    expect(c.reversed).toBe(true)
    expect(c.angle[15]).toBeCloseTo(180, 6)
    expect(c.angle[3] - c.angle[2]).toBeGreaterThan(0)
  })

  it('角度ごとの平均で、角度に沿った値が戻り、揺れは小さい', () => {
    const prep = turning(1)
    const crank = crankAngles(prep)!
    prep.series.knee = crank.angle.map((a) => 70 + 40 * Math.cos((a * Math.PI) / 180))
    const cycles: MotionCycle[] = [{ startIndex: 0, endIndex: 89, start: 0, end: 89 * 33, events: [] }]
    const p = crankProfile(prep, crank, cycles, 'knee', 36)
    expect(p.mean[1]).toBeGreaterThan(105)
    expect(p.mean[18]).toBeLessThan(35)
    expect(Math.max(...p.sd.filter(Number.isFinite))).toBeLessThan(4)
  })

  it('足首の動きが円でなければ出さない', () => {
    const prep = prepOf(60, (k, px) => {
      px[s.ankle] = { x: 400 + 4 * k, y: 600 }
    })
    expect(crankAngles(prep)).toBeNull()
  })
})

describe('エルゴの動く順番', () => {
  // ドライブ 0〜100 コマ（フィニッシュ 100）、リカバリー 100〜150。脚・上体・腕の速さの山を 25%・50%・75% に置く
  const sig = (p: number, c: number) => 1 / (1 + Math.exp(-(p - c) / 0.05))
  const prep = prepOf(151, () => {}, {
    kind: 'erg',
    series: {
      seat: Array.from({ length: 151 }, (_, k) => (k <= 100 ? 60 * sig(k / 100, 0.25) : 60 - (k - 100))),
      trunk: Array.from({ length: 151 }, (_, k) => (k <= 100 ? 25 - 40 * sig(k / 100, 0.5) : -15 + (k - 100) * 0.8)),
      elbow: Array.from({ length: 151 }, (_, k) => (k <= 100 ? 110 * sig(k / 100, 0.75) : 110 - (k - 100) * 2)),
    },
  })
  const cycle: MotionCycle = { startIndex: 0, endIndex: 150, start: 0, end: 150 * 33, events: [{ key: 'finish', label: 'フィニッシュ', index: 100, t: 3300 }] }

  it('速さがいちばん大きい時刻を、ドライブの % で返す', () => {
    const p = drivePeaks(prep, cycle)
    expect(p.leg).toBeCloseTo(25, -0.5)
    expect(p.trunk).toBeCloseTo(50, -0.5)
    expect(p.arm).toBeCloseTo(75, -0.5)
  })

  it('1 本をそろえた平均の曲線は、それぞれの最大が 1 で、フィニッシュの位置も返す', () => {
    const prof = strokeProfile(prep, [cycle])!
    expect(Math.max(...prof.curves.leg)).toBeCloseTo(1, 1)
    expect(prof.finish).toBeCloseTo((100 / 150) * 100, 3)
  })
})

describe('バーの軌道', () => {
  const base = (loadKg: number) =>
    prepOf(
      31,
      (k, px) => {
        px[s.heel] = { x: 480, y: 900 }
        px[s.foot] = { x: 560, y: 900 }
        px[s.wrist] = { x: 530 + k, y: 400 + 10 * k }
      },
      { kind: 'squat', body: { heightCm: 170, weightKg: 70, loadKg, assumed: { height: false, weight: false, load: false } }, load: { mPerPx: 0.01 } as PreparedMotion['load'] },
    )

  it('持つ重さがなければ出さない', () => {
    expect(barSeries(base(0))).toBeNull()
  })

  it('足の真ん中からの前後、床からの高さ、上下の速さを求める', () => {
    const b = barSeries(base(40))!
    expect(b.x[0]).toBeCloseTo(0.1, 9)
    expect(b.y[0]).toBeCloseTo(5, 9)
    // 1 コマ（33 ミリ秒）で 0.1 m 下がる
    expect(b.v[15]).toBeCloseTo(-0.1 / 0.033, 3)
  })
})
