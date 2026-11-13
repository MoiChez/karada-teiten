import { describe, expect, it } from 'vitest'
import { BODY_PRIOR, SEGMENT_MASS, bodyCom, resolveBody, squatLoad } from '../src/domain/motionLoad'
import type { PreparedFrame } from '../src/domain/motionCore'
import { sidePoints } from '../src/domain/landmarks'
import type { Point } from '../src/domain/types'

const s = sidePoints('left')
const elbow = s.wrist - 2

type Pose = Record<'ear' | 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle' | 'heel' | 'foot', Point>

// 右を向いた横向きの体（x が前、y が下向きのピクセル）。足は動かない
const foot = { ankle: { x: 530, y: 900 }, heel: { x: 490, y: 905 }, foot: { x: 570, y: 905 } }
const STAND: Pose = {
  ...foot,
  knee: { x: 530, y: 700 },
  hip: { x: 530, y: 500 },
  shoulder: { x: 530, y: 250 },
  ear: { x: 540, y: 200 },
  elbow: { x: 650, y: 250 },
  wrist: { x: 770, y: 250 },
}
const rad = (d: number) => (d * Math.PI) / 180
/** すねの前傾 shin°、太ももの傾き（股関節が膝より下で +）thigh°、上体の前傾 trunk° のしゃがんだ姿勢 */
function deep(shin: number, thigh: number, trunk: number): Pose {
  const knee = { x: 530 + 200 * Math.sin(rad(shin)), y: 900 - 200 * Math.cos(rad(shin)) }
  const hip = { x: knee.x - 200 * Math.cos(rad(thigh)), y: knee.y + 200 * Math.sin(rad(thigh)) }
  const shoulder = { x: hip.x + 250 * Math.sin(rad(trunk)), y: hip.y - 250 * Math.cos(rad(trunk)) }
  return { ...foot, knee, hip, shoulder, ear: { x: shoulder.x + 10, y: shoulder.y - 50 }, elbow: { x: shoulder.x + 120, y: shoulder.y }, wrist: { x: shoulder.x + 240, y: shoulder.y } }
}

function frameOf(t: number, pose: Pose): PreparedFrame {
  const px: Point[] = Array.from({ length: 33 }, () => ({ x: 530, y: 600 }))
  px[s.ear] = pose.ear
  px[s.shoulder] = pose.shoulder
  px[elbow] = pose.elbow
  px[s.wrist] = pose.wrist
  px[s.hip] = pose.hip
  px[s.knee] = pose.knee
  px[s.ankle] = pose.ankle
  px[s.heel] = pose.heel
  px[s.foot] = pose.foot
  return { t, px, lm: px.map((p) => ({ x: p.x / 1000, y: p.y / 1000, z: 0 })), edited: [], constrained: [] }
}

const mix = (a: Pose, b: Pose, k: number): Pose =>
  Object.fromEntries(Object.keys(a).map((name) => [name, { x: a[name as keyof Pose].x + (b[name as keyof Pose].x - a[name as keyof Pose].x) * k, y: a[name as keyof Pose].y + (b[name as keyof Pose].y - a[name as keyof Pose].y) * k }])) as Pose

const still = (pose: Pose, n = 7) => Array.from({ length: n }, (_, k) => frameOf(k * 33, pose))

describe('体の値', () => {
  it('入力がなければ仮定の値を使い、そのことを残す', () => {
    const b = resolveBody(undefined)
    expect(b).toMatchObject({ ...BODY_PRIOR, assumed: { height: true, weight: true, load: true } })
    const c = resolveBody({ heightCm: 180, weightKg: 5000 })
    expect(c.heightCm).toBe(180)
    expect(c.assumed.height).toBe(false)
    expect(c.weightKg).toBe(BODY_PRIOR.weightKg)
    expect(c.assumed.weight).toBe(true)
  })
})

describe('重心（Winter 2009）', () => {
  it('体節の質量比は、両側を足すと 1 になる', () => {
    const m = SEGMENT_MASS
    expect(m.head + m.trunk + 2 * (m.upperArm + m.forearm + m.thigh + m.shank + m.foot)).toBeCloseTo(1, 9)
  })

  it('持つ重さを手首に足すと、重心がその向きへ動く', () => {
    const p = frameOf(0, STAND).px
    const a = bodyCom(p, s, 70, 0)
    const b = bodyCom(p, s, 70, 40)
    expect(b.x).toBeGreaterThan(a.x + 30)
    expect(b.y).toBeLessThan(a.y)
  })
})

describe('股関節と膝の負担の比', () => {
  const body = resolveBody(undefined)

  it('ほぼ立っているときは出さず、しゃがむと、仮定を動かした幅の中に基準の値が入る', () => {
    const stand = squatLoad(still(STAND), s, 1, body, new Set())!
    expect(stand.ratio.every((v) => Number.isNaN(v))).toBe(true)
    const low = squatLoad(still(deep(30, 10, 40)), s, 1, body, new Set())!
    const k = 3
    expect(Number.isFinite(low.ratio[k])).toBe(true)
    expect(low.ratioLo[k]).toBeLessThanOrEqual(low.ratio[k])
    expect(low.ratioHi[k]).toBeGreaterThanOrEqual(low.ratio[k])
    expect(low.ratioHi[k] - low.ratioLo[k]).toBeGreaterThan(0.05)
  })

  it('腰を後ろに引いて上体を倒すほど股関節の側に、膝を前に出すほど膝の側に寄る', () => {
    const hipBack = squatLoad(still(deep(25, 10, 45)), s, 1, body, new Set())!
    const kneeFwd = squatLoad(still(deep(40, 10, 20)), s, 1, body, new Set())!
    expect(hipBack.ratio[3]).toBeGreaterThan(kneeFwd.ratio[3] + 0.2)
  })

  it('顔の向きが逆でも同じ値になる', () => {
    const flip = (p: Pose): Pose => Object.fromEntries(Object.entries(p).map(([k, q]) => [k, { x: 1000 - q.x, y: q.y }])) as Pose
    const a = squatLoad(still(deep(30, 10, 40)), s, 1, body, new Set())!
    const b = squatLoad(still(flip(deep(30, 10, 40))), s, -1, body, new Set())!
    expect(b.ratio[3]).toBeCloseTo(a.ratio[3], 9)
  })

  it('要求度は 0.05〜1 に入り、しゃがんでいくときは「伸びながら」、立ち上がるときは「縮みながら」', () => {
    const frames = Array.from({ length: 61 }, (_, k) => frameOf(k * 33, mix(STAND, deep(30, 10, 40), 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / 60))))
    const load = squatLoad(frames, s, 1, body, new Set())!
    for (const v of Object.values(load.demand).flat()) {
      expect(v).toBeGreaterThanOrEqual(0.05)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(load.demand.knee[30]).toBeGreaterThan(load.demand.knee[0])
    expect(load.phase.knee[15]).toBe('eccentric')
    expect(load.phase.knee[45]).toBe('concentric')
    expect(load.phase.knee[30]).toBe('isometric')
  })
})
