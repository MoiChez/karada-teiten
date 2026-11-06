import { describe, expect, it } from 'vitest'
import type { Landmark } from '../src/domain/types'
import { analyzeGait, compareGait, gaitMetric, packLandmarks, unpackLandmarks, type GaitFrame } from '../src/domain/gait'
import { fixSwaps, gaitClips } from '../src/domain/gaitPose'
import { quarterTurnsOf, screenRollDeg, tiltFromOrientation } from '../src/domain/tilt'
import { gaussian, rng } from '../src/domain/geometry'

const W = 1280
const H = 720
const LEG = 250
const FLOOR = 650

interface Walker {
  cadence: number
  /** 歩幅（脚の長さ比） */
  step: number
  leanDeg: number
  headDeg: number
  armCenterDeg: number
  armRangeDeg: number
  /** 左右の歩幅の違い（0.25 なら、片方の歩が 1.25 倍、もう片方が 0.75 倍） */
  asym?: number
}

const BASE: Walker = { cadence: 110, step: 0.75, leanDeg: 6, headDeg: 15, armCenterDeg: 0, armRangeDeg: 40 }

const rad = (d: number) => (d * Math.PI) / 180

/**
 * 横から見た、まっすぐな脚で歩く人の体の点（ピクセル）。
 * 足首の前後の開きは step × 脚の長さ × |cos φ| で、1 歩ごとに山になる
 */
function walkerPoints(w: Walker, t: number, dir: 1 | -1, x0: number) {
  const v = w.step * LEG * (w.cadence / 60)
  const phi = Math.PI * (w.cadence / 60) * t
  const hipX = x0 + dir * v * t
  const c = Math.cos(phi)
  const dx = ((w.step * LEG) / 2) * c * (1 + (w.asym ?? 0) * Math.sign(c))
  const hipY = FLOOR - Math.sqrt(LEG ** 2 - dx ** 2)
  const p: { x: number; y: number }[] = Array.from({ length: 33 }, () => ({ x: hipX, y: hipY }))
  const set = (i: number, x: number, y: number) => (p[i] = { x, y })
  const ankleA = { x: hipX + dir * dx, y: FLOOR }
  const ankleB = { x: hipX - dir * dx, y: FLOOR }
  set(23, hipX - 2, hipY)
  set(24, hipX + 2, hipY)
  for (const [ank, knee, ankle, heel, toe] of [
    [ankleA, 25, 27, 29, 31],
    [ankleB, 26, 28, 30, 32],
  ] as const) {
    set(knee, (hipX + ank.x) / 2 + dir * 0.03 * LEG, (hipY + ank.y) / 2)
    set(ankle, ank.x, ank.y)
    set(heel, ank.x - dir * 0.05 * LEG, ank.y + 0.03 * LEG)
    set(toe, ank.x + dir * 0.12 * LEG, ank.y + 0.04 * LEG)
  }
  const T = 0.6 * LEG
  const S = { x: hipX + dir * T * Math.sin(rad(w.leanDeg)), y: hipY - T * Math.cos(rad(w.leanDeg)) }
  set(11, S.x - 2, S.y)
  set(12, S.x + 2, S.y)
  const N = 0.25 * LEG
  const E = { x: S.x + dir * N * Math.sin(rad(w.headDeg)), y: S.y - N * Math.cos(rad(w.headDeg)) }
  set(7, E.x - 1, E.y)
  set(8, E.x + 1, E.y)
  set(0, E.x + dir * 0.08 * LEG, E.y + 0.02 * LEG)
  const A = 0.75 * LEG
  for (const [sgn, elbow, wrist] of [
    [1, 13, 15],
    [-1, 14, 16],
  ] as const) {
    const a = rad(w.armCenterDeg + sgn * (w.armRangeDeg / 2) * Math.cos(phi))
    set(elbow, S.x + (dir * A * Math.sin(a)) / 2, S.y + (A * Math.cos(a)) / 2)
    set(wrist, S.x + dir * A * Math.sin(a), S.y + A * Math.cos(a))
  }
  return p
}

/** カメラが右側を下に rollDeg 傾いていると、映像の中身は反時計回りに傾いて写る */
function rollImage(p: { x: number; y: number }, rollDeg: number) {
  const r = rad(rollDeg)
  const dx = p.x - W / 2
  const dy = p.y - H / 2
  return { x: W / 2 + dx * Math.cos(r) + dy * Math.sin(r), y: H / 2 - dx * Math.sin(r) + dy * Math.cos(r) }
}

function simulate(opts: { walker?: Walker; dirs?: (1 | -1)[]; rollDeg?: number; noise?: number; fps?: number; seed?: number } = {}) {
  const w = opts.walker ?? BASE
  const fps = opts.fps ?? 30
  const rand = rng(opts.seed ?? 7)
  const frames: GaitFrame[] = []
  let tBase = 0
  for (const dir of opts.dirs ?? [1, -1]) {
    const v = w.step * LEG * (w.cadence / 60)
    const x0 = dir === 1 ? -150 : W + 150
    const dur = (W + 300) / v
    for (let k = 0; k * (1000 / fps) <= dur * 1000; k++) {
      const t = k / fps
      const pts = walkerPoints(w, t, dir, x0).map((p) => rollImage(p, opts.rollDeg ?? 0))
      const lm: Landmark[] = pts.map((p) => ({
        x: (p.x + gaussian(rand) * (opts.noise ?? 1)) / W,
        y: (p.y + gaussian(rand) * (opts.noise ?? 1)) / H,
        z: 0,
        visibility: 0.95,
      }))
      // 人を検出できたコマだけ（画面の外に出ている間も、体の一部が写っていれば検出される）
      if (lm.some((l) => l.x > 0 && l.x < 1)) frames.push({ t: tBase + t * 1000, lm })
    }
    tBase += dur * 1000 + 1000
  }
  return frames
}

const value = (a: ReturnType<typeof analyzeGait>, key: Parameters<typeof gaitMetric>[1]) => gaitMetric(a, key)!

describe('歩き方の計算', () => {
  it('往復の動画から、テンポ・歩幅・上体・頭・腕の振りを求める', () => {
    const a = analyzeGait({ frames: simulate(), width: W, height: H })
    expect(a.passes.filter((p) => !p.excluded)).toHaveLength(2)
    expect(a.passes.map((p) => p.dir)).toEqual([1, -1])
    expect(a.warnings).toEqual([])
    expect(Math.abs(value(a, 'cadence').value! - 110)).toBeLessThan(2)
    expect(Math.abs(value(a, 'step_length').value! - 75)).toBeLessThan(2.5)
    expect(Math.abs(value(a, 'trunk_lean').value! - 6)).toBeLessThan(0.6)
    expect(Math.abs(value(a, 'head_forward').value! - 15)).toBeLessThan(0.8)
    expect(Math.abs(value(a, 'arm_swing').value! - 40)).toBeLessThan(3)
    for (const m of a.metrics) {
      expect(m.status).toBe('ok')
      expect(m.steps).toBeGreaterThanOrEqual(6)
      expect(m.uncertainty).toBeGreaterThan(0)
    }
  })

  it('端末の傾きが分かれば戻す', () => {
    const a = analyzeGait({ frames: simulate({ rollDeg: 4, dirs: [1] }), width: W, height: H, rollDeg: 4 })
    expect(Math.abs(value(a, 'trunk_lean').value! - 6)).toBeLessThan(0.6)
    expect(value(a, 'trunk_lean').note).toContain('片道')
  })

  it('傾きが分からなくても、往復すれば平均で打ち消す（行きと帰りの差は注記する）', () => {
    const a = analyzeGait({ frames: simulate({ rollDeg: 4 }), width: W, height: H })
    expect(Math.abs(value(a, 'trunk_lean').value! - 6)).toBeLessThan(0.8)
    expect(value(a, 'trunk_lean').note).toContain('行きと帰りで')
    // 片道で傾きを戻さないと、傾きがそのまま入る
    const one = analyzeGait({ frames: simulate({ rollDeg: 4, dirs: [1] }), width: W, height: H })
    expect(Math.abs(value(one, 'trunk_lean').value! - 6)).toBeGreaterThan(3)
    expect(value(one, 'trunk_lean').note).toContain('カメラの傾きがそのまま')
  })

  it('テンポと歩幅の違いを見分ける', () => {
    const slow = analyzeGait({ frames: simulate({ walker: { ...BASE, cadence: 90, step: 0.6 } }), width: W, height: H })
    expect(Math.abs(value(slow, 'cadence').value! - 90)).toBeLessThan(2)
    expect(Math.abs(value(slow, 'step_length').value! - 60)).toBeLessThan(2.5)
    const fast = analyzeGait({ frames: simulate({ walker: { ...BASE, cadence: 130, step: 0.85 } }), width: W, height: H })
    expect(Math.abs(value(fast, 'cadence').value! - 130)).toBeLessThan(3)
    const changes = compareGait(slow, fast)
    expect(changes.find((c) => c.key === 'cadence')?.noticeable).toBe(true)
    expect(changes.find((c) => c.key === 'trunk_lean')?.noticeable).toBe(false)
  })

  it('全身が写っていない・横切っていないときは測定不可にする', () => {
    const none = analyzeGait({ frames: [], width: W, height: H })
    expect(none.metrics.every((m) => m.status === 'unavailable')).toBe(true)
    expect(none.warnings[0]).toContain('全身')
    // 立ったまま（歩いていない）
    const standing: GaitFrame[] = Array.from({ length: 60 }, (_, k) => ({
      t: (k * 1000) / 30,
      lm: walkerPoints({ ...BASE, cadence: 0.001 }, k / 30, 1, 640).map((p) => ({ x: p.x / W, y: p.y / H, z: 0, visibility: 0.95 })),
    }))
    const s = analyzeGait({ frames: standing, width: W, height: H })
    expect(s.metrics.every((m) => m.status === 'unavailable')).toBe(true)
  })

  it('左右で歩幅が違っても、小さい方の歩を見落とさない', () => {
    const a = analyzeGait({ frames: simulate({ walker: { ...BASE, asym: 0.25 } }), width: W, height: H })
    expect(Math.abs(value(a, 'cadence').value! - 110)).toBeLessThan(2)
    expect(value(a, 'cadence').uncertainty).toBeLessThan(1.5)
    expect(value(a, 'step_length').steps).toBeGreaterThanOrEqual(10)
  })

  it('推定が一瞬乱れたコマがあっても、通過を区切らない', () => {
    const frames = simulate()
    const t0 = frames[0].t + 1800
    // 3 コマだけ脚の点が見えなくなる
    const broken = frames.map((f) =>
      f.t > t0 && f.t < t0 + 120 ? { ...f, lm: f.lm.map((l, i) => (i >= 25 ? { ...l, visibility: 0.05 } : l)) } : f,
    )
    const a = analyzeGait({ frames: broken, width: W, height: H })
    expect(a.passes.filter((p) => !p.excluded)).toHaveLength(2)
    expect(Math.abs(value(a, 'cadence').value! - 110)).toBeLessThan(2)
  })

  it('骨格が逆さになった 1 コマや、体の陰の手首のずれに引きずられない', () => {
    const frames = simulate().map((f, k) => {
      // 25 コマごとに 1 コマ、骨格が上下逆さになる
      if (k % 25 === 12) return { ...f, lm: f.lm.map((l) => ({ ...l, y: 1 - l.y })) }
      // 奥の手首（16）は見えておらず、推定がでたらめ
      return { ...f, lm: f.lm.map((l, i) => (i === 16 ? { ...l, x: l.x + (k % 3) * 0.05, visibility: 0.1 } : l)) }
    })
    const a = analyzeGait({ frames, width: W, height: H })
    expect(Math.abs(value(a, 'trunk_lean').value! - 6)).toBeLessThan(0.6)
    expect(Math.abs(value(a, 'arm_swing').value! - 40)).toBeLessThan(3)
    expect(Math.abs(value(a, 'cadence').value! - 110)).toBeLessThan(2)
  })

  it('コマが少ないときは注意を出す', () => {
    const a = analyzeGait({ frames: simulate({ fps: 12 }), width: W, height: H })
    expect(a.warnings.some((w) => w.includes('12 コマ'))).toBe(true)
  })

  it('保存用に詰めた点を戻せる', () => {
    const lm: Landmark[] = [{ x: 0.123456, y: 0.98765, z: 0.3, visibility: 0.876 }]
    const back = unpackLandmarks(packLandmarks(lm))
    expect(back[0].x).toBeCloseTo(0.1235, 4)
    expect(back[0].y).toBeCloseTo(0.9877, 4)
    expect(back[0].visibility).toBeCloseTo(0.88, 2)
  })
})

describe('3D 再生用の関節の位置', () => {
  it('左右の脚を取り違えたコマを、つながりで直す', () => {
    const a = walkerPoints(BASE, 0.1, 1, 300)
    const b = walkerPoints(BASE, 0.133, 1, 300)
    const swapped = [...b]
    for (const [i, j] of [
      [25, 26],
      [27, 28],
      [29, 30],
      [31, 32],
    ]) {
      ;[swapped[i], swapped[j]] = [swapped[j], swapped[i]]
    }
    const fixed = fixSwaps([a, swapped])
    expect(fixed[1][27]).toEqual(b[27])
    expect(fixed[1][28]).toEqual(b[28])
  })

  it('通過ごとに、その場で歩く関節の位置を作る（進む向きが +Z）', () => {
    const clips = gaitClips({ frames: simulate(), width: W, height: H })
    expect(clips).toHaveLength(2)
    for (const c of clips) {
      expect(c.speed).toBeGreaterThan(0)
      const mid = c.frames[Math.floor(c.frames.length / 2)].pose.points
      // 肩は股関節より上、前傾 6° なので少し前
      expect(mid[11]!.y).toBeGreaterThan(mid[23]!.y)
      expect(mid[11]!.z).toBeGreaterThan(mid[23]!.z)
      // 体の左が +X
      expect(mid[11]!.x).toBeGreaterThan(0)
      expect(mid[12]!.x).toBeLessThan(0)
      // 床は 0 付近
      const lowest = Math.min(mid[29]!.y, mid[30]!.y, mid[31]!.y, mid[32]!.y)
      expect(Math.abs(lowest)).toBeLessThan(0.05)
    }
  })
})

describe('端末の傾き', () => {
  it('縦に立てた端末の、画面の面内の傾き（右側が下がると +）', () => {
    const t = tiltFromOrientation(90, 0)
    expect(t.rollDeg).toBeCloseTo(0, 6)
    expect(t.pitchDeg).toBeCloseTo(90, 6)
    // 立てた端末では gamma が大きく振れても、傾きは小さい
    const s = tiltFromOrientation(87.8, -27)
    expect(s.rollDeg).toBeCloseTo(-1, 1)
    expect(s.pitchDeg).toBeCloseTo(88, 0)
    expect(tiltFromOrientation(95, -90).rollDeg).toBeCloseTo(5, 6)
  })

  it('横向きに持ったときの、映像の回し方', () => {
    // 反時計回りに 90° 回して横にした（右側が上）
    const t = tiltFromOrientation(0, -90)
    expect(t.rollDeg).toBeCloseTo(-90, 6)
    // 画面も横になっていれば、映像はそのままで上が上
    expect(quarterTurnsOf(screenRollDeg(t.rollDeg, 90))).toEqual({ turns: 0, residualDeg: 0 })
    // 画面が縦のままなら、映像を反時計回りに 90° 回す
    expect(quarterTurnsOf(screenRollDeg(t.rollDeg, 0)).turns).toBe(-1)
    const q = quarterTurnsOf(-87)
    expect(q.turns).toBe(-1)
    expect(q.residualDeg).toBeCloseTo(3, 6)
    expect(quarterTurnsOf(178).turns).toBe(2)
  })
})
