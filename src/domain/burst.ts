// 立ち直しながら撮った複数枚の骨格をまとめる。
// 1. 各撮影の点を、位置（重心）と大きさ（重心からの距離の二乗平均）でそろえる
// 2. そろえた形の平均を「今回の姿勢」とし、代表の写真（平均に最も近い 1 枚）の位置と大きさに戻す
// 3. 平均からの残差から、1 枚あたりの点のぶれ（体の高さ比）を求める。立ち直しによる姿勢の違いも含む
import type { Landmark, Plane, Point } from './types'
import { MIN_VISIBILITY } from './constants'
import { LM, sidePoints } from './landmarks'
import { bodyHeightPx, visibilityOf } from './metrics'

export interface BurstFrameInput {
  /** その写真の正規化座標（0..1） */
  landmarks: Landmark[]
  width: number
  height: number
}

export interface BurstMerge {
  /** 平均した点（代表の写真の正規化座標） */
  landmarks: Landmark[]
  /** 各撮影の点を代表の写真の位置と大きさにそろえたもの（usedIndices の順） */
  frames: Landmark[][]
  /** 入力のうち、骨格を検出できて平均に使った写真の番号 */
  usedIndices: number[]
  /** 代表の写真の、入力での番号 */
  repIndex: number
  /** 1 枚あたりの点のぶれ（体の高さ比、1σ）。点が足りなければ null */
  spreadFrac: number | null
}

/** ぶれの計算に使う点（腕と顔の細かい点は動きやすいので除く） */
export function burstCorePoints(plane: Plane, nearSide: 'left' | 'right' = 'left'): number[] {
  if (plane === 'front') return [7, 8, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30]
  const s = sidePoints(nearSide)
  return [s.ear, s.shoulder, s.hip, s.knee, s.ankle, s.heel]
}

function requiredPoints(plane: Plane, nearSide: 'left' | 'right'): number[] {
  if (plane === 'front') return [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip, LM.leftAnkle, LM.rightAnkle]
  const s = sidePoints(nearSide)
  return [s.shoulder, s.hip, s.ankle]
}

const usable = (l: Landmark | undefined) =>
  !!l && l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1 && visibilityOf(l) >= MIN_VISIBILITY

/** 2 枚以上で骨格を検出できなければ null */
export function mergeBurst(plane: Plane, inputs: BurstFrameInput[], nearSide: 'left' | 'right' = 'left'): BurstMerge | null {
  const required = requiredPoints(plane, nearSide)
  const valid = inputs
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => f.landmarks.length >= 33 && required.every((j) => usable(f.landmarks[j])))
  if (valid.length < 2) return null
  const align = burstCorePoints(plane, nearSide).filter((j) => valid.every(({ f }) => usable(f.landmarks[j])))
  if (align.length < 4) return null

  const px = (f: BurstFrameInput, j: number): Point => ({ x: f.landmarks[j].x * f.width, y: f.landmarks[j].y * f.height })

  // 位置と大きさをそろえた形（重心が原点、大きさ 1）
  const shapes = valid.map(({ f }) => {
    const pts = align.map((j) => px(f, j))
    const c = { x: avg(pts.map((p) => p.x)), y: avg(pts.map((p) => p.y)) }
    const s = Math.sqrt(avg(pts.map((p) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2)))
    const u = f.landmarks.map((_, j) => {
      const p = px(f, j)
      return { x: (p.x - c.x) / s, y: (p.y - c.y) / s }
    })
    return { c, s, u }
  })
  const K = valid.length
  const meanShape = new Map(align.map((j) => [j, { x: avg(shapes.map((sh) => sh.u[j].x)), y: avg(shapes.map((sh) => sh.u[j].y)) }]))
  const devOf = (k: number) => align.reduce((sum, j) => sum + (shapes[k].u[j].x - meanShape.get(j)!.x) ** 2 + (shapes[k].u[j].y - meanShape.get(j)!.y) ** 2, 0)
  const devs = shapes.map((_, k) => devOf(k))
  const repK = devs.indexOf(Math.min(...devs))
  const rep = valid[repK].f
  const { c: cr, s: sr } = shapes[repK]

  // 代表の写真の座標に戻す
  const frames: Landmark[][] = valid.map(({ f }, k) =>
    f.landmarks.map((l, j) => ({ ...l, x: (cr.x + sr * shapes[k].u[j].x) / rep.width, y: (cr.y + sr * shapes[k].u[j].y) / rep.height })),
  )

  // 点ごとの平均（検出できた枚だけを使う）
  const landmarks: Landmark[] = frames[0].map((_, j) => {
    const ks = valid.map((_, k) => k).filter((k) => usable(valid[k].f.landmarks[j]))
    const use = ks.length ? ks : valid.map((_, k) => k)
    const pick = (fn: (l: Landmark) => number | undefined) => {
      const vals = use.map((k) => fn(frames[k][j])).filter((v): v is number => v !== undefined)
      return vals.length ? avg(vals) : undefined
    }
    return {
      x: pick((l) => l.x)!,
      y: pick((l) => l.y)!,
      z: pick((l) => l.z) ?? 0,
      visibility: pick((l) => l.visibility),
      presence: pick((l) => l.presence),
    }
  })

  // 1 枚あたりのぶれ。自由度 = (枚数 − 1) × (2 × 点の数 − 3)（各枚の位置 2 + 大きさ 1 を合わせた分を引く）
  const rss = devs.reduce((a, b) => a + b, 0)
  const df = (K - 1) * (2 * align.length - 3)
  const pts = landmarks.map((l) => ({ x: l.x * rep.width, y: l.y * rep.height }))
  const Hpx = bodyHeightPx(plane, (i) => pts[i], (i) => usable(landmarks[i]), nearSide)
  const spreadFrac = df >= 10 && Hpx ? Math.round((Math.sqrt(rss / df) * sr * 1e5) / Hpx) / 1e5 : null

  return {
    landmarks,
    frames,
    usedIndices: valid.map((v) => v.index),
    repIndex: valid[repK].index,
    spreadFrac,
  }
}

function avg(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length
}
