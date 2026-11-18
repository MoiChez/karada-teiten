import { describe, expect, it } from 'vitest'
import { squat3dSeries } from '../src/domain/motion3d'
import { metricDoc, PROFILES } from '../src/domain/motionSports'
import { VIEW3D_POINTS } from '../src/domain/view3d'

type V = [number, number, number]
const RAD = Math.PI / 180

/** 体の座標（X: 体の左、Y: 上、Z: 前）のしゃがんだ姿勢。膝の曲がり knee°、上体の前傾 lean° */
function body(knee: number, lean: number): Record<number, V> {
  const shin = knee * 0.4
  const thigh = knee - shin // 太ももの前への傾き（鉛直から）
  const p: Record<number, V> = {}
  for (const [side, x] of [
    [0, 0.09],
    [1, -0.09],
  ] as const) {
    const ankle: V = [x, 0.05, 0]
    const kneeP: V = [x, ankle[1] + 0.25 * Math.cos(shin * RAD), ankle[2] + 0.25 * Math.sin(shin * RAD)]
    const hip: V = [x, kneeP[1] + 0.25 * Math.cos(thigh * RAD), kneeP[2] - 0.25 * Math.sin(thigh * RAD)]
    const sh: V = [x * 1.6, hip[1] + 0.3 * Math.cos(lean * RAD), hip[2] + 0.3 * Math.sin(lean * RAD)]
    const L = side === 0
    p[L ? 27 : 28] = ankle
    p[L ? 25 : 26] = kneeP
    p[L ? 23 : 24] = hip
    p[L ? 11 : 12] = sh
    p[L ? 13 : 14] = [sh[0], sh[1] - 0.15, sh[2] + 0.1]
    p[L ? 15 : 16] = [sh[0], sh[1] - 0.1, sh[2] + 0.25]
    p[L ? 29 : 30] = [x, 0.0, -0.05]
    p[L ? 31 : 32] = [x, 0.0, 0.15]
  }
  p[7] = [0.06, p[11][1] + 0.12, p[11][2]]
  p[8] = [-0.06, p[12][1] + 0.12, p[12][2]]
  p[0] = [0, p[11][1] + 0.12, p[11][2] + 0.08]
  return p
}

/** 体の座標 → カメラの座標（右 +x・下 +y・奥 +z）。yaw = 0 は体の正面から（体の左が画面の右） */
function toCamera(p: Record<number, V>, yawDeg: number, pitchDeg: number): number[] {
  const cy = Math.cos(yawDeg * RAD)
  const sy = Math.sin(yawDeg * RAD)
  const cp = Math.cos(pitchDeg * RAD)
  const sp = Math.sin(pitchDeg * RAD)
  const cam = (q: V): V => {
    // 体のまわりに yaw だけ回り込んだカメラ: 体の座標を上の軸のまわりに回す
    const x = q[0] * cy + q[2] * sy
    const z = -q[0] * sy + q[2] * cy
    // 正面から: 左 → +x、上 → -y、前 → -z。さらに見上げ / 見下ろし（pitch）で傾ける
    const X = x
    const Y = -q[1]
    const Z = -z
    return [X, Y * cp - Z * sp, Y * sp + Z * cp]
  }
  const hip = cam([(p[23][0] + p[24][0]) / 2, (p[23][1] + p[24][1]) / 2, (p[23][2] + p[24][2]) / 2])
  const out: number[] = []
  for (const m of VIEW3D_POINTS) {
    const c = cam(p[m])
    out.push(c[0] - hip[0], c[1] - hip[1], c[2] - hip[2])
  }
  const up = cam([0, 1, 0])
  out.push(...up)
  return out
}

describe('向きによらない 3D からスクワットの角度を求める', () => {
  it('同じ姿勢なら、正面・斜め後ろ・下からのどれで撮っても同じ角度になる', () => {
    const p = body(100, 35)
    const views = [
      [0, 0],
      [135, -15],
      [250, 20],
    ]
    const results = views.map(([y, pi]) => squat3dSeries([toCamera(p, y, pi)]))
    for (const r of results) {
      expect(r.knee[0]).toBeCloseTo(results[0].knee[0], 4)
      expect(r.hip[0]).toBeCloseTo(results[0].hip[0], 4)
      expect(r.trunk[0]).toBeCloseTo(results[0].trunk[0], 4)
    }
    // 膝の曲がりは作った値、上体は前へ傾くと +
    expect(results[0].knee[0]).toBeCloseTo(100, 4)
    expect(results[0].trunk[0]).toBeCloseTo(35, 4)
    expect(results[1].shin[0]).toBeCloseTo(40, 4)
  })

  it('3D から求めた記録では、値の説明を 3D の求め方にする（横ずれなど別の値はそのまま）', () => {
    const knee = PROFILES.squat.metrics.find((m) => m.key === 'knee')!
    const shift = PROFILES.squat_front.metrics.find((m) => m.key.startsWith('hip_shift'))!
    expect(metricDoc(knee, false)).toBe(knee.doc)
    expect(metricDoc(knee, true)).toContain('向きによらない 3D')
    expect(metricDoc(knee, true)).not.toContain('横から見た見かけ')
    expect(metricDoc(shift, true)).toBe(shift.doc)
  })

  it('深さは、立った姿勢（高い方から 1 割）からの股関節の下がり', () => {
    const frames = [0, 0, 0, 0, 0, 0, 0, 0, 0, 120].map((k) => toCamera(body(k, 10), 30, 0))
    const r = squat3dSeries(frames)
    // なめらかにする前の値と比べるため、いちばん深いコマのまわりではなく、端のコマ（立った姿勢）で 0 に近い
    expect(Math.abs(r.depth[0])).toBeLessThan(1)
    expect(r.depth[9]).toBeGreaterThan(5)
  })
})
