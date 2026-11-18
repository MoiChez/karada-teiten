import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { squat3dSeries } from '../src/domain/motion3d'
import { metricDoc, PROFILES } from '../src/domain/motionSports'
import { VIEW3D_POINTS, parseView3DModel, type View3DModelFile } from '../src/domain/view3d'
import { analyzeMotion, motionMetric, packLandmarks, packWorld, prepareMotion, type MotionInput, type MotionRecord } from '../src/domain/motion'
import { motionPoses } from '../src/domain/motionPose'
import { needsView3d, withView3d } from '../src/data/upgrade3d'
import type { Landmark } from '../src/domain/types'

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
    // 腕はバーを担ぐ形（胴に対して決まった位置。胴の上の向き u・前の向き w）
    const u: V = [0, Math.cos(lean * RAD), Math.sin(lean * RAD)]
    const w: V = [0, -Math.sin(lean * RAD), Math.cos(lean * RAD)]
    const along = (o: V, dx: number, du: number, dw: number): V => [o[0] + dx, o[1] + du * u[1] + dw * w[1], o[2] + du * u[2] + dw * w[2]]
    p[L ? 13 : 14] = along(sh, x * 1.1, -0.05, -0.08)
    p[L ? 15 : 16] = along(sh, x * 2.2, 0.02, -0.05)
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

  it('立っている間に推定の脚の長さが揺れても、深さは上がらない（膝が曲がっていなければ、しゃがんだと数えない）', () => {
    // 股関節から上を、コマごとに脚の長さの ±12% だけ上下させる（膝はまっすぐのまま）
    const frames = Array.from({ length: 40 }, (_, i) => {
      const p = body(5, 5)
      const dy = (i % 3 === 0 ? -0.12 : i % 3 === 1 ? 0.06 : 0) * 0.5
      for (const m of Object.keys(p).map(Number)) if (![27, 28, 29, 30, 31, 32, 25, 26].includes(m)) p[m] = [p[m][0], p[m][1] + dy, p[m][2]]
      return toCamera(p, 135, -15)
    })
    const r = squat3dSeries(frames)
    expect(Math.max(...r.depth.map(Math.abs))).toBeLessThan(5)
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

// ---------- 斜め後ろの下から撮ったスクワットを、分析の入口から通す ----------

const W = 1000
const H = 1600

/** 体の座標 → カメラの座標（toCamera と同じ向き。原点は体のまわりを回すときの中心、カメラは奥へ D 離れる） */
function camPoint(q: V, yawDeg: number, pitchDeg: number, D = 3): V {
  const cy = Math.cos(yawDeg * RAD)
  const sy = Math.sin(yawDeg * RAD)
  const cp = Math.cos(pitchDeg * RAD)
  const sp = Math.sin(pitchDeg * RAD)
  const x = q[0] * cy + q[2] * sy
  const z = -q[0] * sy + q[2] * cy
  const Y = -(q[1] - 0.55)
  const Z = -z
  return [x, Y * cp - Z * sp, Y * sp + Z * cp + D]
}

/** 3 回しゃがむ動き（1 回 3 秒、30 コマ/秒）を、斜め後ろ（yaw 135°）の下（pitch −15°）から撮った入力。v は withV のときだけ */
function obliqueInput(maxKnee: number, withV: boolean): MotionInput {
  const frames: MotionInput['frames'] = []
  const yaw = 135
  const pitch = -15
  for (let t = 0; t <= 600 + 3 * 3600; t += 1000 / 30) {
    const local = t - 600
    const k = Math.floor(local / 3600)
    const u = local - k * 3600
    const phase = local >= 0 && k < 3 && u <= 3000 ? u / 3000 : 0
    const knee = maxKnee * (1 - Math.cos(2 * Math.PI * phase)) * 0.5
    const p = body(knee, knee * 0.35)
    const c: Record<number, V> = {}
    for (const m of Object.keys(p).map(Number)) c[m] = camPoint(p[m], yaw, pitch)
    const base = (i: number) => (i <= 10 && ![7, 8].includes(i) ? 0 : i >= 17 && i <= 22 ? (i % 2 ? 15 : 16) : i)
    const lm: Landmark[] = []
    const world: Landmark[] = []
    const hip = c[23].map((v, j) => (v + c[24][j]) / 2)
    for (let i = 0; i < 33; i++) {
      const q = c[base(i)]
      lm.push({ x: (W / 2 + (1000 * q[0]) / q[2]) / W, y: (H / 2 + (1000 * q[1]) / q[2]) / H, z: 0, visibility: 0.9 })
      world.push({ x: q[0] - hip[0], y: q[1] - hip[1], z: q[2] - hip[2], visibility: 0.9 })
    }
    frames.push({ t: Math.round(t), lm, world, v: withV ? toCamera(p, yaw, pitch) : undefined })
  }
  return { frames, width: W, height: H }
}

describe('斜め後ろの下から撮ったスクワット', () => {
  it('3D があれば、角度と深さを 3D から求め、回を区切り、重心は出さない', () => {
    const a = analyzeMotion(obliqueInput(110, true), 'squat')
    expect(a.angles3d).toBe(true)
    expect(a.cycles).toHaveLength(3)
    expect(a.warnings.some((w) => w.includes('向きによらない 3D'))).toBe(true)
    expect(a.warnings.some((w) => w.includes('参考になりません'))).toBe(false)
    // なめらか化で山が少し削れる分を許す
    expect(motionMetric(a, 'knee')!.value!).toBeGreaterThan(105)
    expect(motionMetric(a, 'knee')!.value!).toBeLessThan(111)
    expect(motionMetric(a, 'trunk')!.value!).toBeGreaterThan(35)
    expect(motionMetric(a, 'trunk')!.value!).toBeLessThan(39)
    expect(motionMetric(a, 'com_bottom')?.status ?? 'unavailable').not.toBe('ok')
  })

  it('3D の体: 手首の推定が外れたコマがあっても、腕は暴れない', () => {
    const input = obliqueInput(110, true)
    const kw = [15, 16].map((m) => VIEW3D_POINTS.indexOf(m))
    // 4 コマに 1 コマ、両手首を頭の方（カメラの座標で右上）へ大きく外す
    const noisy: MotionInput = {
      ...input,
      frames: input.frames.map((f, i) => {
        if (i % 4 !== 1 || !f.v) return f
        const v = [...f.v]
        for (const k of kw) {
          v[3 * k] += 0.15
          v[3 * k + 1] -= 0.2
        }
        return { ...f, v }
      }),
    }
    const clean = motionPoses(prepareMotion(input, 'squat')!)
    const got = motionPoses(prepareMotion(noisy, 'squat')!)
    expect(got).toHaveLength(clean.length)
    const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    let worst = 0
    let worstJump = 0
    for (let i = 0; i < got.length; i++) {
      for (const m of [15, 16]) {
        worst = Math.max(worst, dist(got[i].pose.points[m]!, clean[i].pose.points[m]!))
        if (i) worstJump = Math.max(worstJump, dist(got[i].pose.points[m]!, got[i - 1].pose.points[m]!))
      }
    }
    // 外したずれ（体の高さの 2 割ほど）に比べて十分に小さい
    expect(worst).toBeLessThan(0.03)
    expect(worstJump).toBeLessThan(0.02)
  })

  it('3D がない前の記録は「真横でない」になり、3D を足すと計算し直せる', () => {
    const input = obliqueInput(110, false)
    const before = analyzeMotion(input, 'squat')
    expect(before.angles3d).toBeFalsy()
    const rec: MotionRecord = {
      id: 'm_test',
      createdAt: '2026-11-18T00:00:00.000Z',
      appVersion: '0.25.0',
      kind: before.kind,
      source: 'upload',
      modelVersion: 'test',
      video: { width: W, height: H, durationMs: 11400, frameCount: input.frames.length, fps: 30, quarterTurns: 0 },
      videoSaved: false,
      frames: input.frames.map((f) => ({ t: f.t, p: packLandmarks(f.lm), w: packWorld(f.world!) })),
      analysis: before,
    }
    expect(needsView3d(rec)).toBe(true)
    // 真横の記録・3D を足した記録は対象にしない
    expect(needsView3d({ ...rec, analysis: { ...before, view: before.view && { ...before.view, view: 'side' } } })).toBe(false)
    const model = parseView3DModel(JSON.parse(readFileSync('public/models/view3d-v2.json', 'utf8')) as View3DModelFile)
    const next = withView3d(rec, model)!
    expect(next.frames.every((f) => f.v?.length === 60)).toBe(true)
    expect(needsView3d(next)).toBe(false)
    expect(next.analysis.angles3d).toBe(true)
  })
})
