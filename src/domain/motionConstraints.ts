// 器具が決める動きの前提で、ずれやすい点を補う（エルゴ: 足はフットプレート・腰はレールの上）。
// 膝は、脚がよく伸びたコマで測った太もも・すねの長さから決める（エルゴ・自転車）。
// 横から撮った画面の上の位置だけを扱う。手で直した点は書き換えない。補った点は constrained に記録する
import type { Point } from './types'
import { RAD2DEG, interiorAngleDeg, straightBlend } from './geometry'
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

/** 股関節→足首の線に対して、点がどちら側にあるか（外積の値） */
const crossOf = (hip: Point, ankle: Point, p: Point) => (ankle.x - hip.x) * (p.y - hip.y) - (ankle.y - hip.y) * (p.x - hip.x)

/**
 * 股関節と足首の位置と、太もも・すねの長さから、膝の位置を求める（2 つの円の交点）。
 * 交点は 2 つあるので、side（股関節→足首の線に対する外積の符号）の側を選ぶ。side がなければ、もとの膝の点と同じ側。
 * 届かないときは、脚をまっすぐ伸ばした位置にする
 */
export function kneeFromBones(hip: Point, ankle: Point, thigh: number, shank: number, rawKnee: Point, side?: 1 | -1): Point {
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
  const pick = side ?? (Math.abs(cross) > 1e-6 ? Math.sign(cross) : -Math.sign(ux) || 1)
  // 線に垂直な向き（外積が正になる側）
  const nx = -uy * pick
  const ny = ux * pick
  return { x: hip.x + ux * a + nx * h, y: hip.y + uy * a + ny * h }
}

/**
 * 股関節と足首の位置はそのままに、膝の曲がり flexDeg（まっすぐが 0°）と、太もも : すねの比で膝を置く。
 * 骨の長さは、足首に届くように同じ割合で伸び縮みさせる（三角形の形だけを決める）
 */
export function kneeFromAngle(hip: Point, ankle: Point, thigh: number, shank: number, flexDeg: number, side: 1 | -1): Point {
  const d = dist(hip, ankle)
  if (d < 1e-6) return hip
  const ux = (ankle.x - hip.x) / d
  const uy = (ankle.y - hip.y) / d
  const f = (Math.max(0, Math.min(170, flexDeg)) * Math.PI) / 180
  // 太もも r・すね 1 − r の三角形で、膝の内角 180° − f のときの、股関節〜足首の長さ
  const r = thigh / (thigh + shank)
  const span = Math.sqrt(r * r + (1 - r) * (1 - r) + 2 * r * (1 - r) * Math.cos(f))
  const t = (r * d) / span
  const sh = ((1 - r) * d) / span
  const a = (d * d + t * t - sh * sh) / (2 * d)
  const h = Math.sqrt(Math.max(0, t * t - a * a))
  return { x: hip.x + ux * a - uy * side * h, y: hip.y + uy * a + ux * side * h }
}

/**
 * 膝が曲がる側（記録の中で、股関節→足首の線からはっきり離れたコマの多い側）。
 * エルゴと自転車では膝が反対へ曲がることはないが、脚が伸び切ったコマでは、推定の膝の点が線の反対側へ揺れることがある。
 * コマごとに側を選ぶと、そのコマだけ膝が逆に折れるので、記録で 1 つに決める
 */
export function kneeSide(frames: PreparedFrame[], s: Side, leg: number): 1 | -1 | undefined {
  let pos = 0
  let neg = 0
  for (const fr of frames) {
    const hip = fr.px[s.hip]
    const ankle = fr.px[s.ankle]
    const d = dist(hip, ankle)
    if (!(d > 1e-6)) continue
    const off = crossOf(hip, ankle, fr.px[s.knee]) / d
    if (off > 0.05 * leg) pos++
    else if (off < -0.05 * leg) neg++
  }
  return pos === 0 && neg === 0 ? undefined : pos >= neg ? 1 : -1
}

/**
 * 1 コマの膝の位置。脚が縮んでいるとき（股関節〜足首が骨の長さの合計の 88% まで）は、骨の長さから決める
 * （推定の膝の点は、脚を畳むほど股関節の方へずれるため）。伸びかけ（98% 以上）は、推定の膝の点の曲がりに沿わせる
 * （長さから決めると、画面の上の骨の長さが数 % 変わるだけで実際より大きく曲がり、伸び切った瞬間にカクンと伸びる。
 * 利用者のエルゴで、フィニッシュの手前に推定の点は 6〜14° のところ 20〜35° 曲がり、次のコマで 0° になった）。その間はなめらかにつなぐ
 */
export function placeKnee(hip: Point, ankle: Point, rawKnee: Point, bones: { thigh: number; shank: number }, side: 1 | -1 | undefined): Point {
  const byBones = kneeFromBones(hip, ankle, bones.thigh, bones.shank, rawKnee, side)
  const d = dist(hip, ankle)
  const w = straightBlend(d, bones.thigh + bones.shank)
  if (!(w > 0) || !side) return byBones
  const flexOf = (k: Point) => 180 - interiorAngleDeg(hip, k, ankle)
  // 推定の膝が反対側にあるときは、まっすぐとみなす（反対へは曲げない）
  const rawFlex = Math.sign(crossOf(hip, ankle, rawKnee)) === side ? flexOf(rawKnee) : 0
  const flex = (1 - w) * flexOf(byBones) + w * (Number.isFinite(rawFlex) ? rawFlex : 0)
  return kneeFromAngle(hip, ankle, bones.thigh, bones.shank, flex, side)
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
  const side = kneeSide(frames, s, bones.thigh + bones.shank)
  for (const fr of frames) put(fr, s.knee, placeKnee(fr.px[s.hip], fr.px[s.ankle], fr.px[s.knee], bones, side), size)
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
