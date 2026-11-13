// 固定式の自転車の、クランクの角度（0〜360°）と、角度ごとの関節の角度の平均と揺れ。
// 腰（サドルの上でほぼ動かない）から見た足首の位置の軌跡に円を当て、その中心のまわりの向きをクランクの角度とする
// （上死点 0°、前 90°、下死点 180°）。腰から見るので、手持ちでカメラが少し動いても崩れにくい。
// 斜めから撮ると円が楕円に見えるので、点の広がりで縦横をそろえてから円を当てる。
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
  /** 縦横をそろえた後の、軌跡と円のずれ（rms ÷ 半径） */
  roundness: number
  /** 軌跡の縦横比（短い向き ÷ 長い向き。真横から撮ると 1 に近く、斜めから撮るほど小さい） */
  aspect: number
  /** 顔の向きから見て、後ろ向きに回っていた（角度の向きを入れ替えた） */
  reversed: boolean
}

/** 円から外れすぎ（rms が半径のこの割合を超える）なら、クランクの角度は出さない */
const MAX_ROUNDNESS = 0.3
/** 軌跡がこれより細い（ほとんど線）なら、円とみなさない */
const MIN_ASPECT = 0.2

/** 点の広がり（共分散）から、縦横をそろえる変換（平均を引き、主な向きに回し、それぞれの広がりで割る） */
function whitening(ps: Point[]) {
  const n = ps.length
  const mx = ps.reduce((a, p) => a + p.x, 0) / n
  const my = ps.reduce((a, p) => a + p.y, 0) / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of ps) {
    sxx += (p.x - mx) ** 2
    syy += (p.y - my) ** 2
    sxy += (p.x - mx) * (p.y - my)
  }
  sxx /= n
  syy /= n
  sxy /= n
  const tr = sxx + syy
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)))
  const l1 = tr / 2 + disc
  const l2 = tr / 2 - disc
  if (!(l1 > 0) || !(l2 > 0)) return null
  const a = Math.abs(sxy) > 1e-12 ? Math.atan2(l1 - sxx, sxy) : sxx >= syy ? 0 : Math.PI / 2
  const c = Math.cos(a)
  const s = Math.sin(a)
  const k1 = 1 / Math.sqrt(l1)
  const k2 = 1 / Math.sqrt(l2)
  /** 向き（平均を引かない） */
  const dir = (dx: number, dy: number): Point => ({ x: (c * dx + s * dy) * k1, y: (-s * dx + c * dy) * k2 })
  return { map: (p: Point) => dir(p.x - mx, p.y - my), dir, aspect: Math.sqrt(l2 / l1) }
}

export function crankAngles(prep: PreparedMotion): CrankAngles | null {
  const s = sidePoints(prep.nearSide)
  const rel = prep.frames.map((fr) => ({ x: fr.px[s.ankle].x - fr.px[s.hip].x, y: fr.px[s.ankle].y - fr.px[s.hip].y }))
  if (rel.length < 5) return null
  const w = whitening(rel)
  if (!w || w.aspect < MIN_ASPECT) return null
  const pts = rel.map(w.map)
  const circle = fitCircle(pts)
  if (!circle || !(circle.r > 0)) return null
  const roundness = circle.rms / circle.r
  if (roundness > MAX_ROUNDNESS) return null
  // 上（画像の上向き）と前（顔の向き）を同じ変換で移した向きを基準に、上を 0°、前の側を + にする
  const up = w.dir(0, -1)
  const fwd = w.dir(prep.f, 0)
  const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
  const side = Math.sign(cross(up, fwd)) || 1
  let angle = pts.map((p) => {
    const d = { x: p.x - circle.cx, y: p.y - circle.cy }
    const a = Math.atan2(side * cross(up, d), up.x * d.x + up.y * d.y) * RAD2DEG
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
  return { angle, roundness, aspect: w.aspect, reversed }
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
