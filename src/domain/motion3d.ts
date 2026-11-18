// 向きによらない 3D（コマごとの v: 19 点の 3D と上の向き。src/domain/view3d.ts）から、スクワットの角度と深さを求める。
// 斜め・正面・後ろ・下から撮った動画で使う（真横から撮った動画は、これまでどおり画面の上の見かけの角度）。
// 角度は左右の脚の平均。前は「左右の股関節を結ぶ向き × 上の向き」（体の正面）
import { VIEW3D_INDEX, view3dOutput } from './view3d'

type V3 = { x: number; y: number; z: number }
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const mul = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const len = (a: V3) => Math.hypot(a.x, a.y, a.z)
const unit = (a: V3) => mul(a, 1 / (len(a) || 1))
const DEG = 180 / Math.PI

/** b での曲がり（180° − 内角） */
function flex(a: V3, b: V3, c: V3) {
  const u = sub(a, b)
  const v = sub(c, b)
  const cos = dot(u, v) / ((len(u) * len(v)) || 1)
  return 180 - Math.acos(Math.max(-1, Math.min(1, cos))) * DEG
}

/** 上の向きからの傾き（前が +） */
function lean(v: V3, up: V3, front: V3) {
  const a = Math.acos(Math.max(-1, Math.min(1, dot(unit(v), up)))) * DEG
  return dot(v, front) >= 0 ? a : -a
}

export interface Frame3D {
  P: (mp: number) => V3
  up: V3
  /** 体の正面の向き（水平） */
  front: V3
  /** 体の左の向き（水平） */
  left: V3
}

/** コマの v を、点を引ける形にする */
export function frame3d(v: number[] | undefined): Frame3D | null {
  if (!v || v.length < 60) return null
  const o = view3dOutput(Float32Array.from(v))
  const P = (mp: number) => {
    const p = o.points[VIEW3D_INDEX[mp]]
    return { x: p.x, y: p.y, z: p.z }
  }
  const up = o.up
  const l = sub(P(23), P(24))
  const leftH = unit(sub(l, mul(up, dot(l, up))))
  // カメラの座標（右 +x・下 +y・奥 +z）で、体の正面 = 左 × 上（カメラの方を向いた人なら、左 = +x、上 = −y で、正面 = −z）
  const front = unit(cross(leftH, up))
  return { P, up, front, left: leftH }
}

/** 前後 ±k コマの平均（NaN は除く） */
function smooth(v: number[], k = 2): number[] {
  return v.map((_, i) => {
    let s = 0
    let n = 0
    for (let j = Math.max(0, i - k); j <= Math.min(v.length - 1, i + k); j++) {
      if (Number.isFinite(v[j])) {
        s += v[j]
        n++
      }
    }
    return n ? s / n : NaN
  })
}

/** スクワットの値の列（膝・股関節・上体・すね・太ももの傾き・深さ）。v のないコマは NaN */
export function squat3dSeries(vs: (number[] | undefined)[]): Record<'knee' | 'hip' | 'trunk' | 'shin' | 'thigh' | 'depth', number[]> {
  const fs = vs.map(frame3d)
  const both = (f: (side: 'l' | 'r') => number) => (f('l') + f('r')) / 2
  const pick = (side: 'l' | 'r', l: number, r: number) => (side === 'l' ? l : r)
  const knee = fs.map((F) => (F ? both((s) => flex(F.P(pick(s, 23, 24)), F.P(pick(s, 25, 26)), F.P(pick(s, 27, 28)))) : NaN))
  const hip = fs.map((F) => (F ? both((s) => flex(F.P(pick(s, 11, 12)), F.P(pick(s, 23, 24)), F.P(pick(s, 25, 26)))) : NaN))
  const mid = (F: Frame3D, a: number, b: number) => mul(add(F.P(a), F.P(b)), 0.5)
  const trunk = fs.map((F) => (F ? lean(sub(mid(F, 11, 12), mid(F, 23, 24)), F.up, F.front) : NaN))
  const shin = fs.map((F) => (F ? both((s) => lean(sub(F.P(pick(s, 25, 26)), F.P(pick(s, 27, 28))), F.up, F.front)) : NaN))
  // 太ももの傾き: 水平が 0、股関節が膝より下（深い）と +
  const thigh = fs.map((F) =>
    F
      ? both((s) => {
          const d = sub(F.P(pick(s, 23, 24)), F.P(pick(s, 25, 26)))
          const h = dot(d, F.up)
          const flat = len(sub(d, mul(F.up, h)))
          return -Math.atan2(h, flat) * DEG
        })
      : NaN,
  )
  // 深さ: 足首から股関節までの、上の向きの高さ。立っているとき（高い方から 1 割）からの下がり。
  // 高さは「太ももの長さ × 太ももの鉛直からの傾きの cos + すねの長さ × すねの cos」（左右の平均）で求め、長さは記録の中の中央値にする。
  // 股関節の点の高さをそのまま使うと、推定の脚の長さがコマごとに少し変わるだけで高さが揺れ、膝がほとんど曲がっていないのに
  // 深さが 15% を超えて 1 回と数えることがあった（実際の人の動画）
  const lens = (a: number, b: number) => {
    const v = fs.flatMap((F) => (F ? [len(sub(F.P(a), F.P(b)))] : [])).sort((x, y) => x - y)
    return v.length ? v[Math.floor(v.length / 2)] : NaN
  }
  const Lt = (lens(23, 25) + lens(24, 26)) / 2
  const Ls = (lens(25, 27) + lens(26, 28)) / 2
  const cosUp = (F: Frame3D, a: number, b: number) => dot(unit(sub(F.P(a), F.P(b))), F.up)
  const height = fs.map((F) => (F ? both((s) => Lt * cosUp(F, pick(s, 23, 24), pick(s, 25, 26)) + Ls * cosUp(F, pick(s, 25, 26), pick(s, 27, 28))) : NaN))
  const hs = height.filter(Number.isFinite).sort((a, b) => a - b)
  const stand = hs.length ? hs[Math.floor((hs.length - 1) * 0.9)] : NaN
  const depth = height.map((h) => (Number.isFinite(h) && stand > 0 ? ((stand - h) / stand) * 100 : NaN))
  return { knee: smooth(knee), hip: smooth(hip), trunk: smooth(trunk), shin: smooth(shin), thigh: smooth(thigh), depth: smooth(depth) }
}
