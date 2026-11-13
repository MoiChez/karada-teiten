import { describe, expect, it } from 'vitest'
import type { Landmark } from '../src/domain/types'
import {
  analyzeMotion,
  compareMotion,
  findCycles,
  motionInputOf,
  motionMetric,
  packLandmarks,
  packWorld,
  prepareMotion,
  turnsFromBody,
  voteTurns,
  type MotionInput,
} from '../src/domain/motion'
import { motionPoses, poseAtTime } from '../src/domain/motionPose'

const W = 1000
const H = 2000
const SHIN = 420
const THIGH = 440
const TRUNK = 520
const RAD = Math.PI / 180

interface Angles {
  /** 膝の曲がり・すねの前傾・上体の前傾（度） */
  knee: number
  shin: number
  trunk: number
}

/** 横から見た体（f = +1 なら顔が画像の右）。足首を固定し、すね → 太もも → 上体の順に組み立てる */
function sidePose(a: Angles, f: 1 | -1 = 1): Landmark[] {
  const dir = (deg: number, len: number) => ({ x: f * Math.sin(deg * RAD) * len, y: -Math.cos(deg * RAD) * len })
  const add = (p: { x: number; y: number }, d: { x: number; y: number }) => ({ x: p.x + d.x, y: p.y + d.y })
  const ankle = { x: 500, y: 1800 }
  const knee = add(ankle, dir(a.shin, SHIN))
  const hip = add(knee, dir(a.shin - a.knee, THIGH))
  const shoulder = add(hip, dir(a.trunk, TRUNK))
  const ear = add(shoulder, dir(a.trunk, 200))
  const nose = add(ear, { x: f * 30, y: 10 })
  const elbow = add(shoulder, { x: f * 150, y: 0 })
  const wrist = add(elbow, { x: f * 150, y: 0 })
  const heel = add(ankle, { x: -f * 30, y: 40 })
  const toe = add(ankle, { x: f * 120, y: 50 })
  const pts: Record<number, { x: number; y: number }> = {
    0: nose,
    7: ear,
    11: shoulder,
    13: elbow,
    15: wrist,
    23: hip,
    25: knee,
    27: ankle,
    29: heel,
    31: toe,
  }
  const out: Landmark[] = []
  for (let i = 0; i < 33; i++) {
    const base = i === 0 ? 0 : i % 2 === 1 ? i : i - 1
    const p = pts[base] ?? nose
    const near = i === 0 || i % 2 === 1
    // 奥側の点は少し後ろにずれて、見えにくい
    out.push({ x: (p.x + (near ? 0 : -f * 8)) / W, y: p.y / H, z: 0, visibility: near ? 0.95 : 0.3 })
  }
  return out
}

/** 3 回しゃがむ動き（1 回 3 秒、間に 0.6 秒立つ）。knee の最大を maxKnee にする */
function squatInput(maxKnee = 100, opts: { f?: 1 | -1; from?: number; to?: number; reps?: number } = {}): MotionInput {
  const reps = opts.reps ?? 3
  const T = 3000
  const rest = 600
  const total = rest + reps * (T + rest)
  const frames: MotionInput['frames'] = []
  for (let t = opts.from ?? 0; t <= (opts.to ?? total); t += 1000 / 30) {
    const local = t - rest
    const k = Math.floor(local / (T + rest))
    const u = local - k * (T + rest)
    const phase = local >= 0 && k < reps && u <= T ? u / T : 0
    const knee = maxKnee * (1 - Math.cos(2 * Math.PI * phase)) * 0.5
    frames.push({ t: Math.round(t), lm: sidePose({ knee, shin: knee * 0.4, trunk: knee * 0.5 }, opts.f ?? 1) })
  }
  return { frames, width: W, height: H }
}

/** 足首を固定した体の、股関節の高さから求めた深さ（%） */
function expectedDepth(knee: number) {
  const shin = knee * 0.4
  const hipY = SHIN * Math.cos(shin * RAD) + THIGH * Math.cos((shin - knee) * RAD)
  return ((SHIN + THIGH - hipY) / (SHIN + THIGH)) * 100
}

describe('スクワットの角度と区切り', () => {
  it('膝・股関節・上体・すねの角度と深さを、1 回ごとの最大として出す', () => {
    const a = analyzeMotion(squatInput(100))
    expect(a.cycles).toHaveLength(3)
    expect(a.warnings).toEqual([])
    const v = (k: Parameters<typeof motionMetric>[1]) => motionMetric(a, k)!.value!
    // なめらか化で山が少し削れる分を許す
    expect(v('knee')).toBeGreaterThan(98)
    expect(v('knee')).toBeLessThanOrEqual(100.5)
    expect(v('shin')).toBeCloseTo(40, 0)
    expect(v('trunk')).toBeCloseTo(50, 0)
    // 股関節の曲がり = 上体の前傾 + 膝 − すね
    expect(v('hip')).toBeCloseTo(110, 0)
    expect(v('depth')).toBeCloseTo(expectedDepth(100), 0)
  })

  it('しゃがむ時間と立ち上がる時間を出す（ゆっくり動き始める分、動き始めの目安より前は数えない）', () => {
    const a = analyzeMotion(squatInput(100))
    const d = motionMetric(a, 'descent')!.value!
    const u = motionMetric(a, 'ascent')!.value!
    // 下りと上りは対称な動き。半周期 1.5 秒のうち、深さ 3% に届くまでの動き始めを除く
    expect(d).toBeGreaterThan(0.8)
    expect(d).toBeLessThan(1.5)
    expect(u).toBeCloseTo(d, 1)
    expect(a.cycles[0].events[0].t - 600).toBeCloseTo(1500, -2)
  })

  it('顔が左向きでも同じ値になる', () => {
    const r = analyzeMotion(squatInput(90))
    const l = analyzeMotion(squatInput(90, { f: -1 }))
    expect(l.facing).toBe('left')
    for (const k of ['knee', 'hip', 'trunk', 'shin', 'depth'] as const) {
      expect(motionMetric(l, k)!.value!).toBeCloseTo(motionMetric(r, k)!.value!, 3)
    }
  })

  it('撮り始めや撮り終わりで途中までしか写っていない回は数えず、そのことを知らせる', () => {
    // 1 回目の途中から始まり、3 回目の途中で終わる
    const a = analyzeMotion(squatInput(100, { from: 1500, to: 600 + 2 * 3600 + 1500 }))
    expect(a.cycles).toHaveLength(1)
    expect(a.warnings.some((w) => w.includes('撮り始め'))).toBe(true)
    expect(a.warnings.some((w) => w.includes('撮り終わり'))).toBe(true)
  })

  it('浅い動き（深さ 15% 未満）は 1 回と数えず、そのことを知らせる', () => {
    const a = analyzeMotion(squatInput(30))
    expect(a.cycles).toHaveLength(0)
    expect(motionMetric(a, 'knee')!.status).toBe('unavailable')
    expect(a.warnings.some((w) => w.includes('見つけられませんでした'))).toBe(true)
  })

  it('検出できたコマが少なければ測れない', () => {
    const a = analyzeMotion({ frames: [], width: W, height: H })
    expect(a.metrics.every((m) => m.status === 'unavailable')).toBe(true)
    expect(a.warnings[0]).toContain('測れませんでした')
  })

  it('1 コマだけ推定が乱れても、なめらか化で回の数と角度は変わらない', () => {
    const input = squatInput(100)
    const k = 40
    input.frames[k] = { ...input.frames[k], lm: input.frames[k].lm.map((l) => ({ ...l, x: l.x + 0.02 })) }
    const a = analyzeMotion(input)
    expect(a.cycles).toHaveLength(3)
    expect(motionMetric(a, 'knee')!.value!).toBeGreaterThan(97)
  })

  it('保存した形（詰めた点）から計算し直しても同じ値になる', () => {
    const input = squatInput(100)
    const rec = {
      frames: input.frames.map((f) => ({ t: f.t, p: packLandmarks(f.lm) })),
      video: { width: W, height: H, durationMs: 11000, frameCount: input.frames.length, fps: 30, quarterTurns: 0 },
    }
    const a = analyzeMotion(motionInputOf(rec))
    expect(motionMetric(a, 'knee')!.value!).toBeCloseTo(motionMetric(analyzeMotion(input), 'knee')!.value!, 1)
  })

  it('前の記録との差を、回ごとの揺れから見て「差が見られる」かどうかで返す', () => {
    const a = analyzeMotion(squatInput(80))
    const b = analyzeMotion(squatInput(110))
    const same = compareMotion(a, analyzeMotion(squatInput(81)))
    const ch = compareMotion(a, b)
    expect(ch.find((c) => c.key === 'knee')!.noticeable).toBe(true)
    expect(ch.find((c) => c.key === 'knee')!.diff).toBeGreaterThan(25)
    expect(same.find((c) => c.key === 'knee')!.noticeable).toBe(false)
  })
})

describe('動きの 3D', () => {
  it('かかとが床、立っているときの足首が前後の 0 になり、しゃがむと腰が下がる', () => {
    const prep = prepareMotion(squatInput(100))!
    const poses = motionPoses(prep)
    expect(poses).toHaveLength(prep.frames.length)
    const { cycles } = findCycles(prep)
    const stand = poses[0].pose
    const bottom = poses[cycles[0].events[0].index].pose
    expect(Math.min(stand.points[29]!.y, stand.points[31]!.y)).toBeCloseTo(0, 2)
    expect(stand.points[27]!.z).toBeCloseTo(0, 2)
    expect(bottom.points[23]!.y).toBeLessThan(stand.points[23]!.y - 0.1)
    // 膝は前へ、股関節は後ろへ
    expect(bottom.points[25]!.z).toBeGreaterThan(0.05)
    expect(bottom.points[23]!.z).toBeLessThan(0)
    // 左右は標準の体の幅（3D の推定がないとき）
    expect(stand.points[23]!.x).toBeGreaterThan(0)
    expect(stand.points[24]!.x).toBeLessThan(0)
  })

  it('推定モデルの 3D があれば、左右の位置はそこから取る（体の左が +）', () => {
    const input = squatInput(60)
    for (const f of input.frames) {
      // 体の左がカメラ側（z が小さい）。左右の幅 0.3 m、腰の中心が原点、y は下向き
      f.world = f.lm.map((l, i) => {
        const side = i === 0 ? 0 : i % 2 === 1 ? 1 : -1
        return { x: (l.x - 0.5) * 1.7, y: (l.y - 0.45) * 1.7, z: -side * 0.15 }
      })
    }
    const prep = prepareMotion(input)!
    const p = motionPoses(prep)[0].pose
    expect(p.points[23]!.x).toBeGreaterThan(0.05)
    expect(p.points[24]!.x).toBeLessThan(-0.05)
  })

  it('コマの間の時刻は、前後のコマから直線で補う', () => {
    const poses = motionPoses(prepareMotion(squatInput(100))!)
    const a = poses[30]
    const b = poses[31]
    const p = poseAtTime(poses, (a.t + b.t) / 2)!
    expect(p.points[23]!.y).toBeCloseTo((a.pose.points[23]!.y + b.pose.points[23]!.y) / 2, 6)
  })

  it('3D の点を詰めて保存しても形が保たれる', () => {
    const w = packWorld([{ x: 0.12345, y: -0.5, z: 0.0004 }])
    expect(w).toEqual([0.123, -0.5, 0])
  })
})

describe('映像の向き', () => {
  it('人が横倒しに写っていれば、回す回数を返す。多数決で決める', () => {
    const lm = sidePose({ knee: 0, shin: 0, trunk: 0 })
    // 時計回りに 90° 回った映像（上が右）
    const rotated = lm.map((l) => ({ ...l, x: 1 - l.y, y: l.x }))
    expect(turnsFromBody(rotated, H, W)).not.toBeNull()
    expect(voteTurns([1, 1, 1, null, 0])).toBe(1)
    expect(voteTurns([1, 1, null, null, 0])).toBe(0)
  })
})

describe('撮り方の注意', () => {
  const edit = (fn: (lm: Landmark[]) => void) => {
    const input = squatInput(100)
    for (const f of input.frames) fn(f.lm)
    return analyzeMotion(input)
  }

  it('真横から撮れていれば、バーベルを担いで肩の点が広がっても注意しない', () => {
    // 奥側の肩が 250 ピクセル離れて見える（腕を上げてバーを担ぐ）
    const a = edit((lm) => (lm[12] = { ...lm[12], x: lm[12].x + 0.25 }))
    expect(a.warnings).toEqual([])
    expect(a.cycles).toHaveLength(3)
  })

  it('左右の股関節が離れて見える（斜めから撮った）ときは、真横でないことを知らせる', () => {
    const a = edit((lm) => (lm[24] = { ...lm[24], x: lm[24].x + 0.15, visibility: 0.9 }))
    expect(a.warnings.some((w) => w.includes('真横を向いていない'))).toBe(true)
  })

  it('カメラ側の膝が隠れたコマが多ければ、推測していることを知らせ、値は出す', () => {
    const a = edit((lm) => (lm[25] = { ...lm[25], visibility: 0.1 }))
    const w = a.warnings.find((x) => x.includes('はっきり写っていない'))
    expect(w).toContain('膝')
    expect(w).not.toContain('足首')
    expect(a.cycles).toHaveLength(3)
  })
})
