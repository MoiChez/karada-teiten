import { describe, expect, it } from 'vitest'
import { angleFromVerticalDeg, interiorAngleDeg, perpendicular, tiltDeg } from '../src/domain/geometry'
import { computePlaneMetrics, planeInputFrom } from '../src/domain/metrics'
import type { ComputedMetric, MetricKey } from '../src/domain/types'
import { deg, frontPose, record, sidePose } from './helpers'

const metric = (list: ComputedMetric[], key: MetricKey) => {
  const m = list.find((x) => x.key === key)
  if (!m) throw new Error(`missing ${key}`)
  return m
}

const front = (opts = {}) => computePlaneMetrics(planeInputFrom(record('front', frontPose(opts)), true))
const side = (opts = {}, meta = {}) => computePlaneMetrics(planeInputFrom(record('side', sidePose(opts), meta), true))

describe('geometry', () => {
  it('tiltDeg: 左の点が下なら +', () => {
    expect(tiltDeg({ x: 100, y: 10 }, { x: 0, y: 0 })).toBeCloseTo(deg(Math.atan(0.1)), 6)
    expect(tiltDeg({ x: 0, y: 0 }, { x: 100, y: 10 })).toBeCloseTo(-deg(Math.atan(0.1)), 6)
  })
  it('angleFromVerticalDeg: 前方へ倒れると +', () => {
    expect(angleFromVerticalDeg({ x: 0, y: 100 }, { x: 0, y: 0 }, 1)).toBeCloseTo(0, 6)
    expect(angleFromVerticalDeg({ x: 0, y: 100 }, { x: 100, y: 0 }, 1)).toBeCloseTo(45, 6)
    expect(angleFromVerticalDeg({ x: 0, y: 100 }, { x: 100, y: 0 }, -1)).toBeCloseTo(-45, 6)
  })
  it('interiorAngleDeg と perpendicular', () => {
    expect(interiorAngleDeg({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 })).toBeCloseTo(180, 6)
    expect(interiorAngleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 6)
    const e = perpendicular({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 0, y: 10 })
    expect(e.x).toBeCloseTo(5)
    expect(e.y).toBeCloseTo(0)
  })
})

describe('正面の指標', () => {
  it('左右対称な姿勢では値が 0 付近で「ばらつきの範囲内」', () => {
    const ms = front()
    for (const key of ['front_shoulder_tilt', 'front_pelvis_tilt', 'front_head_tilt', 'front_body_lean', 'front_trunk_shift', 'front_load_shift'] as MetricKey[]) {
      const m = metric(ms, key)
      expect(m.rawValue).not.toBeNull()
      expect(Math.abs(m.rawValue!)).toBeLessThan(1e-6)
      expect(m.status).toBe('within_noise')
      expect(m.uncertainty).toBeGreaterThan(0)
    }
  })

  it('肩の高さの左右差: 左肩を 30px 下げると約 4.76°、左肩が低い', () => {
    const m = metric(front({ leftShoulderDrop: 30 }), 'front_shoulder_tilt')
    expect(m.rawValue).toBeCloseTo(deg(Math.atan(30 / 360)), 1)
    expect(m.direction).toBe('左肩が低い')
    // 胴の長さ（肩の中点 y=515 〜 股関節の中点 y=1000 = 485px）に対する割合
    expect(m.normalizedValue).toBeCloseTo((30 / 485) * 100, 1)
    expect(m.status).toBe('noticeable')
  })

  it('鏡像の写真でも被写体の左右で符号が決まる', () => {
    const a = metric(front({ leftShoulderDrop: 30 }), 'front_shoulder_tilt')
    const b = metric(front({ leftShoulderDrop: 30, mirror: true }), 'front_shoulder_tilt')
    expect(b.rawValue).toBeCloseTo(a.rawValue!, 6)
    const ka = metric(front({ leftKneeOut: 40 }), 'front_knee_left')
    const kb = metric(front({ leftKneeOut: 40, mirror: true }), 'front_knee_left')
    expect(kb.rawValue).toBeCloseTo(ka.rawValue!, 6)
  })

  it('脚のアライメント: 膝が外へ出ると +（O 脚に関連）、内へ入ると −', () => {
    const out = metric(front({ leftKneeOut: 40 }), 'front_knee_left')
    expect(out.rawValue!).toBeGreaterThan(0)
    expect(out.direction).toContain('外側')
    const inn = metric(front({ rightKneeOut: -40 }), 'front_knee_right')
    expect(inn.rawValue!).toBeLessThan(0)
    // 角度の値: 股(600,1000) 膝(640,1400) 足首(600,1800) → 180 − 内角
    const expected = 2 * deg(Math.atan(40 / 400))
    expect(out.rawValue!).toBeCloseTo(expected, 1)
  })

  it('上半身の左右傾き: 肩を被写体の左へ 20px ずらすと +、胸のあたりの位置ずれも出す', () => {
    const m = metric(front({ shoulderShiftX: 20 }), 'front_trunk_shift')
    expect(m.rawValue!).toBeCloseTo(deg(Math.atan(20 / 500)), 1)
    expect(m.normalizedValue!).toBeCloseTo((20 / Math.hypot(20, 500)) * 100, 0)
    // 体の高さ H = 耳 300 〜 かかと 1840 = 1540px
    expect(m.offset!.frac).toBeCloseTo(20 / 1540, 4)
    expect(m.offset!.label).toContain('胸')
  })

  it('下半身の左右傾き: 股関節を被写体の左へずらすと +、腰の位置ずれも出す', () => {
    const lms = frontPose()
    const shifted = lms.map((l, i) => (i === 23 || i === 24 ? { ...l, x: l.x + 40 / 1000 } : l))
    const ms = computePlaneMetrics(planeInputFrom(record('front', shifted), true))
    const m = metric(ms, 'front_lower_lean')
    expect(m.rawValue!).toBeCloseTo(deg(Math.atan(40 / 800)), 1)
    expect(m.direction).toContain('左')
    expect(m.offset!.frac).toBeCloseTo(40 / 1540, 4)
    expect(m.status).toBe('noticeable')
  })

  it('首の左右位置ずれ: 耳の中点が肩の中点より右なら −', () => {
    const lms = frontPose()
    const shifted = lms.map((l, i) => (i === 7 || i === 8 ? { ...l, x: l.x - 30 / 1000 } : l))
    const m = metric(computePlaneMetrics(planeInputFrom(record('front', shifted), true)), 'front_neck_shift')
    expect(m.rawValue!).toBeCloseTo((-30 / 1540) * 100, 2)
    expect(m.direction).toContain('右')
    expect(m.offset!.frac).toBeCloseTo(-30 / 1540, 4)
  })

  it('肩の高さの差は長さ（体の高さ比）でも返す', () => {
    const m = metric(front({ leftShoulderDrop: 30 }), 'front_shoulder_tilt')
    expect(m.offset!.frac).toBeCloseTo(30 / 1540, 3)
    expect(m.offset!.sigma).toBeGreaterThan(0)
  })

  it('信頼度が低い点を使う指標は「評価不可」になり、理由が付く', () => {
    const ms = front({ vis: { 11: 0.2 } })
    const m = metric(ms, 'front_shoulder_tilt')
    expect(m.status).toBe('unassessable')
    expect(m.rawValue).toBeNull()
    expect(m.qualityNote).toContain('左肩')
  })

  it('耳が見えないときは目尻で頭部の傾きを代用し、注記を付ける', () => {
    const m = metric(front({ vis: { 7: 0.1, 8: 0.1 } }), 'front_head_tilt')
    expect(m.rawValue).not.toBeNull()
    expect(m.qualityNote).toContain('目尻')
    expect(m.usedLandmarks).toEqual([3, 6])
  })

  it('不確かさは決定的（同じ入力で同じ値）', () => {
    const a = metric(front({ leftShoulderDrop: 12 }), 'front_shoulder_tilt')
    const b = metric(front({ leftShoulderDrop: 12 }), 'front_shoulder_tilt')
    expect(a.uncertainty).toBe(b.uncertainty)
  })

  it('信頼度の上限: 荷重の傾向は 0.6 を超えない', () => {
    expect(metric(front(), 'front_load_shift').confidence).toBeLessThanOrEqual(0.6)
  })
})

describe('側面の指標', () => {
  it('頭部前方位: 耳が肩より 50px 前 → 約 14°、耳が肩より前', () => {
    const m = metric(side({ earForward: 50 }), 'side_head_forward')
    expect(m.rawValue).toBeCloseTo(deg(Math.atan(50 / 200)), 1)
    expect(m.direction).toBe('耳が肩より前にある')
    expect(m.normalizedValue).toBeCloseTo(10, 1) // 50 / 胴の長さ 500
  })

  it('向きが逆（左向き）でも同じ値になる', () => {
    const a = metric(side({ earForward: 50 }), 'side_head_forward')
    const b = metric(side({ earForward: 50, facing: 'left' }, { facing: 'left' }), 'side_head_forward')
    expect(b.rawValue).toBeCloseTo(a.rawValue!, 6)
  })

  it('体幹の前後傾: 肩が股関節より 40px 前 → +', () => {
    const m = metric(side({ shoulderForward: 40, earForward: 40 }), 'side_trunk_lean')
    expect(m.rawValue).toBeCloseTo(deg(Math.atan(40 / 500)), 1)
  })

  it('膝過伸展: 膝が線より後ろなら +', () => {
    const m = metric(side({ kneeBack: 30 }), 'side_knee_extension')
    expect(m.rawValue!).toBeGreaterThan(0)
    const bent = metric(side({ kneeBack: -30 }), 'side_knee_extension')
    expect(bent.rawValue!).toBeLessThan(0)
  })

  it('骨盤帯の前後位置: 股関節が前に出ると +', () => {
    const m = metric(side({ hipForward: 40 }), 'side_hip_forward')
    expect(m.rawValue!).toBeGreaterThan(0)
  })

  it('全身・下半身の前後傾きは角度で、良し悪しは判定しない（記述のみ）', () => {
    const ms = side({ hipForward: 40, shoulderForward: 40, earForward: 40 })
    const hip = metric(ms, 'side_plumb_hip')
    expect(hip.status).toBe('descriptive')
    expect(hip.rawValue!).toBeCloseTo(deg(Math.atan(40 / 800)), 1)
    expect(hip.offset!.frac).toBeCloseTo(40 / 1540, 4)
    const body = metric(ms, 'side_plumb_shoulder')
    expect(body.rawValue!).toBeCloseTo(deg(Math.atan(40 / 1300)), 1)
  })

  it('頭の前後傾き: 目尻が耳より下なら +（顔が下を向く方向）、記述のみ', () => {
    const down = metric(side({ eyeDrop: 20 }), 'side_head_pitch')
    expect(down.rawValue!).toBeCloseTo(deg(Math.atan(20 / 80)), 1)
    expect(down.status).toBe('descriptive')
    const up = metric(side({ eyeDrop: -20, facing: 'left' }, { facing: 'left' }), 'side_head_pitch')
    expect(up.rawValue!).toBeCloseTo(-deg(Math.atan(20 / 80)), 1)
  })

  it('下げ振り線からの位置は「記述のみ」', () => {
    const m = metric(side({ earForward: 50 }), 'side_plumb_ear')
    expect(m.status).toBe('descriptive')
    expect(m.rawValue).toBeCloseTo((50 / 1540) * 100, 1)
  })

  it('骨盤の前後傾は推定できない（unsupported）と明示する', () => {
    const m = metric(side(), 'side_pelvis_tilt')
    expect(m.status).toBe('unsupported')
    expect(m.rawValue).toBeNull()
    expect(m.qualityNote).toBeTruthy()
  })

  it('猫背傾向スコアは成分の平均（表示用スケールで割る）', () => {
    const ms = side({ earForward: 50, shoulderForward: 0, wristForward: 40 })
    const k = metric(ms, 'composite_kyphosis')
    const head = metric(ms, 'side_head_forward').rawValue!
    const trunk = metric(ms, 'side_trunk_lean').rawValue!
    const arm = metric(ms, 'side_arm_forward').rawValue!
    expect(k.rawValue).toBeCloseTo((head / 10 + trunk / 5 + arm / 20) / 3, 2)
    expect(k.components?.length).toBe(3)
  })

  it('任意成分（腕）が評価不可でも、必須成分だけで猫背傾向スコアを出す', () => {
    const k = metric(side({ earForward: 50, vis: { 16: 0.1 } }), 'composite_kyphosis')
    expect(k.rawValue).not.toBeNull()
    expect(k.components?.length).toBe(2)
  })
})
