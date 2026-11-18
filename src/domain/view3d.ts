// どの向きから撮った動画でも、推定の点から 3D の体を出す小さなモデル（tools/view3d で、3D の人形の合成データで学習した）。
// 入力は前後 ±0.2 秒の 5 コマの、画面の上の点（両股関節の中点を原点、広がりを 1）・見えている度合い・推定モデルの 3D。
// 出力は、カメラの向きの座標（右が +x、下が +y、奥が +z）の 3D の点（両股関節の中点を原点、体の高さを 1）と、上の向き（床に垂直）。
// 計算は端末の中だけで行う（重みは public/models/ のファイル）
import type { Landmark, Point } from './types'

/** 使う点（MediaPipe の点の番号）。tools/view3d/common.py の USED と同じ並び */
export const VIEW3D_POINTS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
const N = VIEW3D_POINTS.length
const IDX: Record<number, number> = Object.fromEntries(VIEW3D_POINTS.map((m, k) => [m, k]))
/** 前後のコマ（ミリ秒） */
export const VIEW3D_WINDOW_MS = [-200, -100, 0, 100, 200]
const IN_FRAME = N * 2 + N + N * 3

interface Packed {
  shape: number[]
  data: string
}
export interface View3DModelFile {
  version: number
  hidden: number
  blocks: number
  mu: Packed
  sd: Packed
  layers: Record<string, { w: Packed; b: Packed }>
  test?: { x: number[][]; y: number[][] }
}

interface Dense {
  w: Float32Array
  b: Float32Array
  rows: number
  cols: number
}
export interface View3DModel {
  mu: Float32Array
  sd: Float32Array
  inp: Dense
  blocks: [Dense, Dense][]
  out: Dense
}

/** float16（2 バイト）を float32 にする */
function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

function unpack(p: Packed): Float32Array {
  const bin = typeof atob === 'function' ? atob(p.data) : Buffer.from(p.data, 'base64').toString('binary')
  const out = new Float32Array(bin.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = half(bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8))
  return out
}

function dense(l: { w: Packed; b: Packed }): Dense {
  return { w: unpack(l.w), b: unpack(l.b), rows: l.w.shape[0], cols: l.w.shape[1] }
}

export function parseView3DModel(f: View3DModelFile): View3DModel {
  const blocks: [Dense, Dense][] = []
  for (let k = 0; k < f.blocks; k++) blocks.push([dense(f.layers[`b${k}a`]), dense(f.layers[`b${k}b`])])
  return { mu: unpack(f.mu), sd: unpack(f.sd), inp: dense(f.layers.inp), blocks, out: dense(f.layers.out) }
}

function apply(l: Dense, x: Float32Array): Float32Array {
  const y = new Float32Array(l.rows)
  for (let r = 0; r < l.rows; r++) {
    let s = l.b[r]
    const o = r * l.cols
    for (let c = 0; c < l.cols; c++) s += l.w[o + c] * x[c]
    y[r] = s
  }
  return y
}

const relu = (x: Float32Array) => x.map((v) => (v > 0 ? v : 0))

/** モデルの計算（入力は正規化する前の特徴） */
export function runView3D(m: View3DModel, x: ArrayLike<number>): Float32Array {
  const z = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) z[i] = (x[i] - m.mu[i]) / m.sd[i]
  let h = relu(apply(m.inp, z))
  for (const [a, b] of m.blocks) {
    const r = apply(b, relu(apply(a, h)))
    h = relu(h.map((v, i) => v + r[i]))
  }
  return apply(m.out, h)
}

/** 1 コマの入力（tools/view3d/common.py の frame_features と同じ）。px: ピクセルの点、lm: 見えている度合い、world: 推定モデルの 3D */
export function view3dFrameFeatures(px: Point[], lm: Landmark[], world: Landmark[]): Float32Array {
  const p = VIEW3D_POINTS.map((m) => px[m])
  const vis = VIEW3D_POINTS.map((m) => Math.min(lm[m].visibility ?? 1, lm[m].presence ?? 1))
  const hip = { x: (p[IDX[23]].x + p[IDX[24]].x) / 2, y: (p[IDX[23]].y + p[IDX[24]].y) / 2 }
  let num = 0
  let den = 0
  for (let k = 0; k < N; k++) {
    const w = Math.min(1, Math.max(0.2, vis[k]))
    num += w * ((p[k].x - hip.x) ** 2 + (p[k].y - hip.y) ** 2)
    den += w
  }
  const s = Math.sqrt(num / den / 2) + 1e-6
  const wv = VIEW3D_POINTS.map((m) => world[m])
  const wh = { x: (wv[IDX[23]].x + wv[IDX[24]].x) / 2, y: (wv[IDX[23]].y + wv[IDX[24]].y) / 2, z: (wv[IDX[23]].z + wv[IDX[24]].z) / 2 }
  let ws = 0
  for (const q of wv) ws += (q.x - wh.x) ** 2 + (q.y - wh.y) ** 2 + (q.z - wh.z) ** 2
  ws = Math.sqrt(ws / N) + 1e-6
  const out = new Float32Array(IN_FRAME)
  for (let k = 0; k < N; k++) {
    out[2 * k] = (p[k].x - hip.x) / s
    out[2 * k + 1] = (p[k].y - hip.y) / s
    out[N * 2 + k] = vis[k]
    out[N * 3 + 3 * k] = (wv[k].x - wh.x) / ws
    out[N * 3 + 3 * k + 1] = (wv[k].y - wh.y) / ws
    out[N * 3 + 3 * k + 2] = (wv[k].z - wh.z) / ws
  }
  return out
}

export interface View3DResult {
  /** 3D の点（VIEW3D_POINTS の並び。カメラの向きの座標、両股関節の中点を原点、体の高さを 1） */
  points: { x: number; y: number; z: number }[]
  /** 上の向き（カメラの座標、長さ 1） */
  up: { x: number; y: number; z: number }
}

export function view3dOutput(y: Float32Array): View3DResult {
  const points = Array.from({ length: N }, (_, k) => ({ x: y[3 * k], y: y[3 * k + 1], z: y[3 * k + 2] }))
  const u = { x: y[N * 3], y: y[N * 3 + 1], z: y[N * 3 + 2] }
  const l = Math.hypot(u.x, u.y, u.z) || 1
  return { points, up: { x: u.x / l, y: u.y / l, z: u.z / l } }
}

export const VIEW3D_INDEX = IDX
