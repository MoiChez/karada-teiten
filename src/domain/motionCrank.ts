// 固定式の自転車の、クランクの角度（0〜360°）と、角度ごとの関節の角度の平均と揺れ。
// 足首の点の軌跡に円を当て、その中心のまわりの足首の向きをクランクの角度とする（上死点 0°、前 90°、下死点 180°）。
// 足首はペダルの軸から少し離れているため、クランクそのものの角度とは少しずれる
import type { Point } from './types'
import { RAD2DEG } from './geometry'
import { sidePoints } from './landmarks'
import type { MotionCycle, PreparedMotion } from './motionSports'

/** 点の並びに当てた円（代数的な最小二乗、Kasa の方法）。当てられなければ null */
export function fitCircle(ps: Point[]): { cx: number; cy: number; r: number; rms: number } | null {
  const n = ps.length
  if (n < 5) return null
  const mx = ps.reduce((a, p) => a + p.x, 0) / n
  const my = ps.reduce((a, p) => a + p.y, 0) / n
  let suu = 0
  let svv = 0
  let suv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (const p of ps) {
    const u = p.x - mx
    const v = p.y - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const b1 = (suuu + suvv) / 2
  const b2 = (svvv + svuu) / 2
  const uc = (b1 * svv - b2 * suv) / det
  const vc = (b2 * suu - b1 * suv) / det
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  const cx = mx + uc
  const cy = my + vc
  const rms = Math.sqrt(ps.reduce((a, p) => a + (Math.hypot(p.x - cx, p.y - cy) - r) ** 2, 0) / n)
  return { cx, cy, r, rms }
}

export interface CrankAngles {
  /** コマごとのクランクの角度（度、0〜360。上死点 0°、こぐ向きに増える） */
  angle: number[]
  circle: { cx: number; cy: number; r: number; rms: number }
  /** 足首の軌跡が円からどれだけ外れているか（rms ÷ 半径） */
  roundness: number
  /** 顔の向きから見て、後ろ向きに回っていた（角度の向きを入れ替えた） */
  reversed: boolean
}

/** 円から外れすぎ（rms が半径のこの割合を超える）なら、クランクの角度は出さない */
const MAX_ROUNDNESS = 0.3

export function crankAngles(prep: PreparedMotion): CrankAngles | null {
  const s = sidePoints(prep.nearSide)
  const ankles = prep.frames.map((fr) => fr.px[s.ankle])
  const circle = fitCircle(ankles)
  if (!circle || !(circle.r > 0)) return null
  const roundness = circle.rms / circle.r
  if (roundness > MAX_ROUNDNESS) return null
  // 上が 0°、顔の向き（前）が 90°
  let angle = ankles.map((p) => {
    const a = Math.atan2(prep.f * (p.x - circle.cx), -(p.y - circle.cy)) * RAD2DEG
    return (a + 360) % 360
  })
  // 回っている向きに角度が増えるようにする（顔の向きの推定が逆のときや、後ろ向きにこいだときも、上死点からの進み具合になる）
  let turn = 0
  for (let k = 1; k < angle.length; k++) {
    let d = angle[k] - angle[k - 1]
    if (d > 180) d -= 360
    if (d < -180) d += 360
    turn += d
  }
  const reversed = turn < 0
  if (reversed) angle = angle.map((a) => (360 - a) % 360)
  return { angle, circle, roundness, reversed }
}

/** クランクの角度 bins 等分ごとの、値の平均と標準偏差（回転の中のコマだけ）。コマのない区間は NaN */
export function crankProfile(prep: PreparedMotion, crank: CrankAngles, cycles: MotionCycle[], key: string, bins = 36) {
  const v = prep.series[key]
  const sum = Array(bins).fill(0)
  const sq = Array(bins).fill(0)
  const n = Array(bins).fill(0)
  for (const c of cycles) {
    for (let k = c.startIndex; k < c.endIndex; k++) {
      if (!Number.isFinite(v[k])) continue
      const b = Math.min(bins - 1, Math.floor((crank.angle[k] / 360) * bins))
      sum[b] += v[k]
      sq[b] += v[k] * v[k]
      n[b]++
    }
  }
  const mean = sum.map((x, b) => (n[b] ? x / n[b] : NaN))
  const sd = sq.map((x, b) => (n[b] >= 2 ? Math.sqrt(Math.max(0, x / n[b] - mean[b] ** 2)) : NaN))
  return { mean, sd, n, centers: mean.map((_, b) => ((b + 0.5) * 360) / bins) }
}
