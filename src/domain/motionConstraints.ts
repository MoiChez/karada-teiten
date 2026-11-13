// 器具が決める動きの前提で、ずれやすい点を補う（エルゴ: 足はフットプレート・腰はレールの上）。
// 膝は、脚がよく伸びたコマで測った太もも・すねの長さから決める（エルゴ・自転車）。
// 横から撮った画面の上の位置だけを扱う。手で直した点は書き換えない。補った点は constrained に記録する
import type { Point } from './types'
import { RAD2DEG } from './geometry'
import type { sidePoints } from './landmarks'
import { quantile, type PreparedFrame } from './motionCore'

type Side = ReturnType<typeof sidePoints>

export interface FrameSize {
  width: number
  height: number
  rollDeg?: number
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** 傾きを戻したピクセル座標を、画像に対する比に戻す（uprightPx の逆） */
export function pxToNorm(p: Point, size: FrameSize): Point {
  const r = (size.rollDeg ?? 0) / RAD2DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  const cx = size.width / 2
  const cy = size.height / 2
  const dx = p.x - cx
  const dy = p.y - cy
  return { x: (cx + dx * c + dy * s) / size.width, y: (cy - dx * s + dy * c) / size.height }
}

/** 脚がよく伸びたコマ（股関節〜足首が長い方から 3 割）での、太ももとすねの長さ（中央値、ピクセル） */
export function legBones(frames: PreparedFrame[], s: Side): { thigh: number; shank: number } | null {
  if (frames.length < 5) return null
  const reach = frames.map((fr) => dist(fr.px[s.hip], fr.px[s.ankle]))
  const cut = quantile(reach, 0.7)
  const ext = frames.filter((_, k) => reach[k] >= cut)
  const thigh = quantile(
    ext.map((fr) => dist(fr.px[s.hip], fr.px[s.knee])),
    0.5,
  )
  const shank = quantile(
    ext.map((fr) => dist(fr.px[s.knee], fr.px[s.ankle])),
    0.5,
  )
  return thigh > 0 && shank > 0 ? { thigh, shank } : null
}

/**
 * 股関節と足首の位置と、太もも・すねの長さから、膝の位置を求める（2 つの円の交点）。
 * 交点は 2 つあるので、もとの膝の点と同じ側を選ぶ。届かないときは、脚をまっすぐ伸ばした位置にする
 */
export function kneeFromBones(hip: Point, ankle: Point, thigh: number, shank: number, rawKnee: Point): Point {
  const d = dist(hip, ankle)
  if (d < 1e-6) return rawKnee
  const ux = (ankle.x - hip.x) / d
  const uy = (ankle.y - hip.y) / d
  if (d >= thigh + shank) {
    const k = thigh / (thigh + shank)
    return { x: hip.x + (ankle.x - hip.x) * k, y: hip.y + (ankle.y - hip.y) * k }
  }
  // 太ももの長さに沿った位置 a と、線からの高さ h
  const a = Math.max(-thigh, Math.min(thigh, (d * d + thigh * thigh - shank * shank) / (2 * d)))
  const h = Math.sqrt(Math.max(0, thigh * thigh - a * a))
  // もとの膝が、股関節→足首の線のどちら側にあるか（外積の向き。ほぼ線の上なら、画面の上側）
  const cross = ux * (rawKnee.y - hip.y) - uy * (rawKnee.x - hip.x)
  const side = Math.abs(cross) > 1e-6 ? Math.sign(cross) : -Math.sign(ux) || 1
  // 線に垂直な向き（外積が正になる側）
  const nx = -uy * side
  const ny = ux * side
  return { x: hip.x + ux * a + nx * h, y: hip.y + uy * a + ny * h }
}

/** 点のばらつき（x と y の四分位範囲の大きい方） */
function spreadOf(ps: Point[]) {
  const iqr = (v: number[]) => quantile(v, 0.75) - quantile(v, 0.25)
  return Math.max(
    iqr(ps.map((p) => p.x)),
    iqr(ps.map((p) => p.y)),
  )
}

/** 点 i を、手で直していなければ p に置き換える */
function put(fr: PreparedFrame, i: number, p: Point, size: FrameSize) {
  if (fr.edited.includes(i)) return
  fr.px[i] = p
  const n = pxToNorm(p, size)
  fr.lm[i] = { ...fr.lm[i], x: n.x, y: n.y }
  if (!fr.constrained.includes(i)) fr.constrained.push(i)
}

/** 膝を、太もも・すねの長さから置き直す */
function placeKnees(frames: PreparedFrame[], s: Side, size: FrameSize) {
  const bones = legBones(frames, s)
  if (!bones) return
  for (const fr of frames) put(fr, s.knee, kneeFromBones(fr.px[s.hip], fr.px[s.ankle], bones.thigh, bones.shank, fr.px[s.knee]), size)
}

/** 動きの前提が使えたか（使えなかったときは、その理由） */
export interface ConstraintNote {
  key: 'footplate' | 'rail' | 'knee'
  applied: boolean
}

/**
 * エルゴ: 足首はフットプレートに留まり、腰（股関節）はレールに沿って一直線に動き、
 * 膝は太ももとすねの長さで決まる。三脚で固定して撮った前提で、点がそう動いていないときは使わない
 */
export function constrainErg(frames: PreparedFrame[], s: Side, size: FrameSize, leg: number): ConstraintNote[] {
  const notes: ConstraintNote[] = []
  // 足首: 位置のばらつきが脚の長さの 6% 以内なら、中央の位置に留める
  const ankles = frames.map((fr) => fr.px[s.ankle])
  const footplate = spreadOf(ankles) <= 0.06 * leg
  if (footplate) {
    const c = {
      x: quantile(
        ankles.map((p) => p.x),
        0.5,
      ),
      y: quantile(
        ankles.map((p) => p.y),
        0.5,
      ),
    }
    for (const fr of frames) put(fr, s.ankle, c, size)
  }
  notes.push({ key: 'footplate', applied: footplate })
  // 腰: 前後の位置に対して高さが一直線（最小二乗）からずれていなければ、線の上に乗せる
  const hips = frames.map((fr) => fr.px[s.hip])
  const mx = hips.reduce((a, p) => a + p.x, 0) / hips.length
  const my = hips.reduce((a, p) => a + p.y, 0) / hips.length
  let sxx = 0
  let sxy = 0
  for (const p of hips) {
    sxx += (p.x - mx) ** 2
    sxy += (p.x - mx) * (p.y - my)
  }
  const slope = sxx > 0 ? sxy / sxx : 0
  const resid = hips.map((p) => p.y - (my + slope * (p.x - mx)))
  const rail = sxx > 0 && Math.abs(slope) < 0.5 && spreadOf(resid.map((r) => ({ x: 0, y: r }))) <= 0.05 * leg
  if (rail) for (const fr of frames) put(fr, s.hip, { x: fr.px[s.hip].x, y: my + slope * (fr.px[s.hip].x - mx) }, size)
  notes.push({ key: 'rail', applied: rail })
  placeKnees(frames, s, size)
  notes.push({ key: 'knee', applied: true })
  return notes
}

/** 自転車: 膝は太ももとすねの長さで決まる（腰はサドルの上で、大きくは動かない） */
export function constrainBike(frames: PreparedFrame[], s: Side, size: FrameSize): ConstraintNote[] {
  placeKnees(frames, s, size)
  return [{ key: 'knee', applied: true }]
}
