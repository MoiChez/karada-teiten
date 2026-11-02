import { describe, expect, it } from 'vitest'
import { gaugeCell, gaugeLevel, gaugeRows } from '../src/domain/gauge'
import { fracToCm, primaryValue } from '../src/domain/format'
import { computePlaneMetrics, planeInputFrom } from '../src/domain/metrics'
import { H_TO_STATURE } from '../src/domain/constants'
import type { ComputedMetric, MetricKey } from '../src/domain/types'
import { frontPose, record, sidePose } from './helpers'

const front = (opts = {}) => computePlaneMetrics(planeInputFrom(record('front', frontPose(opts)), true))
const side = (opts = {}) => computePlaneMetrics(planeInputFrom(record('side', sidePose(opts)), true))
const find = (list: ComputedMetric[], key: MetricKey) => list.find((m) => m.key === key)!

describe('ゲージの段階', () => {
  it('ばらつきの 2 倍以内は中央、そこから 2σ ごとに 1 マス、最大 3', () => {
    expect(gaugeLevel(1.9, 1)).toBe(0)
    expect(gaugeLevel(2, 1)).toBe(0)
    expect(gaugeLevel(2.1, 1)).toBe(1)
    expect(gaugeLevel(4, 1)).toBe(1)
    expect(gaugeLevel(4.1, 1)).toBe(2)
    expect(gaugeLevel(-6.5, 1)).toBe(3)
    expect(gaugeLevel(100, 1)).toBe(3)
    expect(gaugeLevel(5, null)).toBe(0)
  })

  it('中央のマスかどうかは、指標の判定（差が見られる / ばらつきの範囲内）と一致する', () => {
    for (const drop of [0, 5, 10, 20, 40]) {
      const m = find(front({ leftShoulderDrop: drop }), 'front_shoulder_tilt')
      expect(gaugeCell(m) !== 0).toBe(m.status === 'noticeable')
    }
  })

  it('肩の高さは上がっている側にマスを置く（左肩が低い = 右が上 = 左側のマス）', () => {
    const rows = gaugeRows(front({ leftShoulderDrop: 40 }), 'front')
    const r = rows.find((x) => x.key === 'front_shoulder_tilt')!
    expect(r.cell!).toBeLessThan(0)
    expect(r.axis.left).toBe('右')
    expect(r.tag).toBe('右が上')
  })

  it('横向き: 頭が前に出ると「前」側（左のマス）、膝の伸びすぎは「後ろ」側', () => {
    const rows = gaugeRows(side({ earForward: 60, kneeBack: 40 }), 'side')
    expect(rows.find((x) => x.key === 'side_head_forward')!.cell!).toBeLessThan(0)
    const knee = rows.find((x) => x.key === 'side_knee_extension')!
    expect(knee.cell!).toBeGreaterThan(0)
    expect(knee.tag).toBe('伸びすぎの方向')
  })

  it('判定する指標を先に、位置の記録（判定なし）を後に並べ、推定できない指標は出さない', () => {
    const rows = gaugeRows(side(), 'side')
    const firstRecord = rows.findIndex((r) => !r.judged)
    expect(firstRecord).toBeGreaterThan(0)
    expect(rows.slice(firstRecord).every((r) => !r.judged)).toBe(true)
    expect(rows.some((r) => r.key === 'side_pelvis_tilt')).toBe(false)
  })

  it('前回の指標を渡すと、前回のマスも返す', () => {
    const past = front({ leftShoulderDrop: 40 })
    const rows = gaugeRows(front(), 'front', past)
    const r = rows.find((x) => x.key === 'front_shoulder_tilt')!
    expect(r.cell).toBe(0)
    expect(r.pastCell!).toBeLessThan(0)
  })
})

describe('cm の目安', () => {
  it('体の高さ比 × 身長 × 換算比', () => {
    expect(fracToCm(0.02, 170)).toBeCloseTo(0.02 * 170 * H_TO_STATURE, 6)
    expect(fracToCm(0.02, undefined)).toBeNull()
    expect(fracToCm(0.02, 0)).toBeNull()
  })

  it('肩の高さの差は身長があれば cm、なければ角度で示す', () => {
    const m = find(front({ leftShoulderDrop: 30 }), 'front_shoulder_tilt')
    expect(primaryValue(m, 170)).toMatch(/cm$/)
    expect(primaryValue(m, undefined)).toMatch(/°$/)
    // 30px / H 1540px × 170cm × 0.91 ≈ 3.0cm
    expect(primaryValue(m, 170)).toBe(`${((30 / 1540) * 170 * H_TO_STATURE).toFixed(1)}cm`)
  })

  it('角度の指標（全身の左右傾き）は身長があっても角度のまま', () => {
    const m = find(front({ shoulderShiftX: 20 }), 'front_body_lean')
    expect(primaryValue(m, 170)).toMatch(/°$/)
  })
})
