import { describe, expect, it } from 'vitest'
import { LM, sidePoints } from '../src/domain/landmarks'
import { ERG_PEAK_AT, bikeDemand, bikePedalForce, ergDemand, ergHandleForce, ergPhases, jointDemand, windowWeight } from '../src/domain/motionDemand'
import type { PreparedFrame } from '../src/domain/motionCore'
import type { MotionCycle } from '../src/domain/motionSports'
import type { Point } from '../src/domain/types'

const S = sidePoints('left')
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

function frame(t: number, pts: Partial<Record<number, Point>>): PreparedFrame {
  const px: Point[] = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN }))
  for (const [i, p] of Object.entries(pts)) px[Number(i)] = p as Point
  return { t, lm: [], px, edited: [], constrained: [] }
}

describe('力の型', () => {
  it('エルゴのハンドルの力は、キャッチとフィニッシュで 0、ドライブの 31% で最大、リカバリーは 0', () => {
    expect(ergHandleForce(0)).toBeCloseTo(0, 6)
    expect(ergHandleForce(1)).toBeCloseTo(0, 6)
    expect(ergHandleForce(ERG_PEAK_AT)).toBeCloseTo(1, 6)
    expect(ERG_PEAK_AT).toBeCloseTo(0.314, 2)
    expect(ergHandleForce(1.5)).toBe(0)
    expect(ergHandleForce(NaN)).toBe(0)
    expect(ergHandleForce(0.1)).toBeLessThan(ergHandleForce(0.25))
    expect(ergHandleForce(0.9)).toBeLessThan(ergHandleForce(0.5))
  })
  it('自転車のペダルの力は、踏み下ろし（0〜180°）だけ正', () => {
    expect(bikePedalForce(90)).toBeCloseTo(1, 6)
    expect(bikePedalForce(0)).toBeCloseTo(0, 6)
    expect(bikePedalForce(200)).toBe(0)
    expect(bikePedalForce(450)).toBeCloseTo(1, 6)
  })
})

describe('範囲の重み', () => {
  it('範囲の中は 1、外は 0、端はなめらか。一周をまたぐ範囲も扱う', () => {
    expect(windowWeight(0.5, 0, 1, 2, 0.06)).toBe(1)
    expect(windowWeight(1.5, 0, 1, 2, 0.06)).toBe(0)
    const edge = windowWeight(0.03, 0, 1, 2, 0.06)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(1)
    // キャッチの直前（1.92）から次の 0.92 まで
    expect(windowWeight(1.97, 1.92, 0.92, 2, 0.02)).toBe(1)
    expect(windowWeight(0.4, 1.92, 0.92, 2, 0.02)).toBe(1)
    expect(windowWeight(1.5, 1.92, 0.92, 2, 0.02)).toBe(0)
    expect(windowWeight(350, 320, 105, 360, 15)).toBe(1)
    expect(windowWeight(200, 320, 105, 360, 15)).toBe(0)
  })
})

describe('関節の負担の向き', () => {
  // 右を向いて座り、足は右。画像は下が +
  const hip = { x: 0, y: 0 }
  const knee = { x: 30, y: -25 }
  const ankle = { x: 55, y: 5 }
  const foot = { x: 65, y: -5 }
  const push = { x: -1, y: 0 }
  it('膝を曲げた姿勢で足を後ろへ押されると、膝を伸ばす筋肉が支える', () => {
    expect(jointDemand(knee, hip, ankle, foot, push)).toBeGreaterThan(0)
  })
  it('脚が力の線の上に伸びると、膝の負担はほぼ 0', () => {
    const flatKnee = { x: 32, y: -5 }
    const flatAnkle = { x: 60, y: -5 }
    expect(Math.abs(jointDemand(flatKnee, { x: 0, y: -5 }, flatAnkle, foot, push))).toBeLessThan(1e-6)
  })
  it('ひじを曲げてハンドルに前へ引かれると、ひじを曲げる筋肉が支える（負）', () => {
    const shoulder = { x: 0, y: -50 }
    const elbow = { x: 5, y: -25 }
    const wrist = { x: 25, y: -35 }
    expect(jointDemand(elbow, shoulder, wrist, wrist, { x: 1, y: 0 })).toBeLessThan(0)
  })
})

/** キャッチ（体を畳む）からフィニッシュ（脚を伸ばし、上体を後ろへ、ひじを引く）へ動くエルゴの 1 本 */
function ergStroke() {
  const N = 40 // ドライブ 0..15、リカバリー 16..39
  const fin = 15
  const pose = (u: number) => {
    // u: 0 = キャッチ、1 = フィニッシュ。脚 → 上体 → 腕の順に動く
    const leg = Math.min(1, u / 0.6)
    const body = Math.min(1, Math.max(0, (u - 0.3) / 0.5))
    const arm = Math.min(1, Math.max(0, (u - 0.6) / 0.4))
    const ankle = { x: 100, y: 0 }
    const foot = { x: 110, y: -12 }
    const hip = lerp({ x: 55, y: -5 }, { x: 10, y: -5 }, leg)
    const knee = lerp({ x: 85, y: -38 }, { x: 55, y: -8 }, leg)
    const shoulder = lerp({ x: hip.x + 25, y: -50 }, { x: hip.x - 15, y: -52 }, body)
    const wrist = lerp({ x: shoulder.x + 55, y: -30 }, { x: shoulder.x + 12, y: -28 }, arm)
    const elbow = lerp({ x: shoulder.x + 28, y: -39 }, { x: shoulder.x - 8, y: -22 }, arm)
    return { [S.hip]: hip, [S.knee]: knee, [S.ankle]: ankle, [S.foot]: foot, [S.shoulder]: shoulder, [S.wrist]: wrist, [LM.leftElbow]: elbow }
  }
  const frames: PreparedFrame[] = []
  for (let k = 0; k < N; k++) {
    const u = k <= fin ? k / fin : 1 - (k - fin) / (N - fin)
    frames.push(frame(k * 33, pose(u)))
  }
  const cycles: MotionCycle[] = [
    {
      startIndex: 0,
      endIndex: N,
      start: 0,
      end: N * 33,
      events: [
        { key: 'catch', label: '', index: 0, t: 0 },
        { key: 'finish', label: '', index: fin, t: fin * 33 },
      ],
    },
  ]
  return { frames, cycles, fin, N }
}

const argmax = (v: number[]) => v.indexOf(Math.max(...v))

describe('エルゴの要求度', () => {
  const { frames, cycles, fin, N } = ergStroke()
  it('局面は、ドライブが 0〜1、リカバリーが 1〜2', () => {
    const ph = ergPhases(N, cycles)
    expect(ph[0]).toBe(0)
    expect(ph[fin]).toBe(1)
    expect(ph[fin + 1]).toBeGreaterThan(1)
    expect(ph[N - 1]).toBeLessThan(2)
  })
  it('値は 0〜1 に収まり、太ももの前はドライブの前半、腕の前は後半でいちばん濃い', () => {
    const d = ergDemand(frames, 'left', 1, cycles)!
    expect(d).not.toBeNull()
    for (const v of Object.values(d.values)) for (const x of v!) expect(x >= 0 && x <= 1).toBe(true)
    expect(argmax(d.values.quads!)).toBeLessThan(fin / 2)
    expect(argmax(d.values.biceps!)).toBeGreaterThan(fin / 2)
    expect(argmax(d.values.quads!)).toBeLessThan(argmax(d.values.biceps!))
    expect(Math.max(...d.values.quads!)).toBeGreaterThan(0.5)
    expect(Math.max(...d.values.erectors!)).toBeGreaterThan(0.5)
  })
  it('リカバリーの中ほどは色が付かず、キャッチの直前は、筋電図の範囲の筋肉に薄く付く', () => {
    const d = ergDemand(frames, 'left', 1, cycles)!
    const mid = fin + Math.floor((N - fin) / 2)
    for (const m of ['quads', 'biceps', 'lats', 'erectors', 'glutes'] as const) expect(d.values[m]![mid]).toBe(0)
    expect(d.values.quads![N - 1]).toBeGreaterThan(0)
    expect(d.values.quads![N - 1]).toBeLessThanOrEqual(0.2 + 1e-9)
    expect(d.values.biceps![N - 1]).toBe(0)
  })
  it('1 本の区切りがなければ出さない', () => {
    expect(ergDemand(frames, 'left', 1, [])).toBeNull()
  })
  it('左を向いていても同じ結果になる', () => {
    const mirrored = frames.map((fr) => ({ ...fr, px: fr.px.map((p) => ({ x: -p.x, y: p.y })) }))
    const a = ergDemand(frames, 'left', 1, cycles)!
    const b = ergDemand(mirrored, 'left', -1, cycles)!
    a.values.quads!.forEach((v, k) => expect(b.values.quads![k]).toBeCloseTo(v, 6))
    a.values.biceps!.forEach((v, k) => expect(b.values.biceps![k]).toBeCloseTo(v, 6))
  })
})

describe('自転車の要求度', () => {
  // 右を向いてこぐ。脚の長さ 80 に対して、クランクの軸は股関節の前 18・下 62、半径 15（実際の自転車に近い割合）。足先は上死点から前へ回る
  const N = 72
  const angle = Array.from({ length: N }, (_, k) => (k * 10) % 360)
  const frames = angle.map((deg, k) => {
    const a = (deg * Math.PI) / 180
    const foot = { x: 18 + 15 * Math.sin(a), y: 62 - 15 * Math.cos(a) }
    const ankle = { x: foot.x - 10, y: foot.y - 6 }
    const hip = { x: 0, y: 0 }
    // 膝は、股関節と足首から同じ長さ（40）の点のうち、前・上の側
    const dx = ankle.x - hip.x
    const dy = ankle.y - hip.y
    const dist = Math.hypot(dx, dy)
    const h = Math.sqrt(Math.max(0, 40 * 40 - (dist / 2) ** 2))
    const knee = { x: hip.x + dx / 2 + (h * dy) / dist, y: hip.y + dy / 2 - (h * dx) / dist }
    return frame(k * 33, { [S.hip]: hip, [S.knee]: knee, [S.ankle]: ankle, [S.foot]: foot, [S.shoulder]: { x: 25, y: -45 } })
  })
  const crank = { angle, roundness: 0, aspect: 1, reversed: false }
  it('クランクの角度がなければ出さない', () => {
    expect(bikeDemand(frames, 'left', undefined)).toBeNull()
  })
  it('太ももの前は踏み下ろしでいちばん濃く、引き上げでは 0', () => {
    const d = bikeDemand(frames, 'left', crank)!
    const q = d.values.quads!
    for (const x of q) expect(x >= 0 && x <= 1).toBe(true)
    const top = angle[argmax(q)]
    expect(top).toBeGreaterThan(0)
    expect(top).toBeLessThan(180)
    expect(q[angle.indexOf(250)]).toBe(0)
    expect(Math.max(...d.values.glutes!)).toBeGreaterThan(0.5)
  })
  it('反対側の脚は、半回転ずれた濃さになる', () => {
    const d = bikeDemand(frames, 'left', crank)!
    const near = d.values.quads!
    const far = d.far!.quads!
    for (const deg of [30, 60, 90, 120]) {
      expect(far[angle.indexOf(deg + 180)]).toBeCloseTo(near[angle.indexOf(deg)], 6)
      expect(far[angle.indexOf(deg)]).toBeCloseTo(near[angle.indexOf(deg + 180)], 6)
    }
  })
})
