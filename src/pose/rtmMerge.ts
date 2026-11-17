// RTMPose（Halpe 26 点）の 2D の点で、MediaPipe の 33 点の位置を置き換えるための計算（画面や推定モデルに依らない部分）。
// MediaPipe は人を見つけて 3D の点（world）と見えている度合いを出し、RTMPose はその人のまわりを切り抜いて 2D の点を細かく出す。
// 合成の動画（正解つき）で比べると、RTMPose の 2D の点は外れが少なく（誤差の 90% 点で体の高さの 12.6% → 8.8%）、
// 左右の脚の取り違えも半分ほどだった（docs/08）
import type { Landmark } from '../domain/types'

/** モデルに入れる絵の大きさ（幅・高さ） */
export const RTM_W = 192
export const RTM_H = 256
/** SimCC の 1 画素あたりの区切りの数 */
const SPLIT = 2
/** 切り抜く範囲を、点の範囲より何倍広げるか */
const PADDING = 1.25
/** これより点数が低い点は、MediaPipe の位置のままにする（合成の動画で、外れの小さい点の 99% はこれ以上だった） */
export const RTM_MIN_SCORE = 0.3

/** MediaPipe の番号 → Halpe 26 の番号（足先は親指、かかとはかかと） */
export const MP_FROM_HALPE: [number, number][] = [
  [0, 0],
  [2, 1],
  [5, 2],
  [7, 3],
  [8, 4],
  [11, 5],
  [12, 6],
  [13, 7],
  [14, 8],
  [15, 9],
  [16, 10],
  [23, 11],
  [24, 12],
  [25, 13],
  [26, 14],
  [27, 15],
  [28, 16],
  [29, 24],
  [30, 25],
  [31, 20],
  [32, 21],
]

/** Halpe にない点は、近くの点と同じだけ動かす（目の内側・外側 → 目、口 → 鼻、手の指 → 手首） */
const FOLLOW: [number, number][] = [
  [1, 2],
  [3, 2],
  [4, 5],
  [6, 5],
  [9, 0],
  [10, 0],
  [17, 15],
  [19, 15],
  [21, 15],
  [18, 16],
  [20, 16],
  [22, 16],
]

export interface CropBox {
  /** 切り抜く範囲の中心と大きさ（元の絵のピクセル） */
  cx: number
  cy: number
  w: number
  h: number
}

/** MediaPipe の点（0..1）から、切り抜く範囲を決める（点の範囲を 1.25 倍に広げ、縦横比を 192:256 にそろえる） */
export function cropBox(landmarks: Landmark[], width: number, height: number): CropBox | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [m] of MP_FROM_HALPE) {
    const l = landmarks[m]
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) continue
    x0 = Math.min(x0, l.x * width)
    x1 = Math.max(x1, l.x * width)
    y0 = Math.min(y0, l.y * height)
    y1 = Math.max(y1, l.y * height)
  }
  if (!(x1 > x0) || !(y1 > y0)) return null
  let w = (x1 - x0) * PADDING
  let h = (y1 - y0) * PADDING
  if (w * RTM_H > h * RTM_W) h = (w * RTM_H) / RTM_W
  else w = (h * RTM_W) / RTM_H
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h }
}

/** SimCC の出力（点ごとの横・縦の分布）から、切り抜いた絵の上の位置と点数を出す。点数は横と縦の最大の小さい方 */
export function decodeSimcc(simccX: ArrayLike<number>, simccY: ArrayLike<number>, k: number): { x: number; y: number; score: number }[] {
  const nx = simccX.length / k
  const ny = simccY.length / k
  const out: { x: number; y: number; score: number }[] = []
  for (let i = 0; i < k; i++) {
    let bx = 0
    let vx = -Infinity
    for (let j = 0; j < nx; j++) {
      const v = simccX[i * nx + j]
      if (v > vx) {
        vx = v
        bx = j
      }
    }
    let by = 0
    let vy = -Infinity
    for (let j = 0; j < ny; j++) {
      const v = simccY[i * ny + j]
      if (v > vy) {
        vy = v
        by = j
      }
    }
    out.push({ x: bx / SPLIT, y: by / SPLIT, score: Math.min(vx, vy) })
  }
  return out
}

/** 切り抜いた絵の上の位置 → 元の絵の 0..1 の位置 */
export function toImage(p: { x: number; y: number; score: number }[], box: CropBox, width: number, height: number) {
  return p.map((q) => ({
    x: (box.cx - box.w / 2 + (q.x * box.w) / RTM_W) / width,
    y: (box.cy - box.h / 2 + (q.y * box.h) / RTM_H) / height,
    score: q.score,
  }))
}

/**
 * MediaPipe の点の 2D の位置を、RTMPose の点で置き換える。奥行き（z）・見えている度合い・3D の点は MediaPipe のまま。
 * 点数の低い点は置き換えない。Halpe にない点は、近くの点と同じだけ動かす
 */
export function mergeRtm(mp: Landmark[], rtm: { x: number; y: number; score: number }[], minScore = RTM_MIN_SCORE): { landmarks: Landmark[]; replaced: number } {
  const out = mp.map((l) => ({ ...l }))
  const delta = new Map<number, { dx: number; dy: number }>()
  for (const [m, h] of MP_FROM_HALPE) {
    const r = rtm[h]
    const l = out[m]
    if (!r || !l || !(r.score >= minScore) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue
    delta.set(m, { dx: r.x - l.x, dy: r.y - l.y })
    l.x = r.x
    l.y = r.y
  }
  for (const [m, base] of FOLLOW) {
    const d = delta.get(base)
    const l = out[m]
    if (!d || !l) continue
    l.x += d.dx
    l.y += d.dy
  }
  return { landmarks: out, replaced: delta.size }
}
