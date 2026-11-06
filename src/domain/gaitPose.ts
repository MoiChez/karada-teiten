// 歩き方の 3D 再生用に、横から撮った体の点を、コマごとの関節の位置（Pose3D）にする。
// 測ったのは横から見た動き（前後と上下）だけなので、左右の位置は標準の体の幅を当てる（表示だけに使う）
import type { Point } from './types'
import type { Pose3D, Vec3 } from './fusion3d'
import { preparePasses, type GaitInput } from './gait'
import { dist } from './geometry'

/** 体の高さ（耳〜かかと）を 1 としたときの、体の中心から左右への距離（標準の体の目安） */
const LATERAL: Record<number, number> = { 7: 0.06, 11: 0.11, 13: 0.125, 15: 0.13, 23: 0.06, 25: 0.06, 27: 0.06, 29: 0.06, 31: 0.065 }
const USED = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
/** 左右を取り違えやすい点の組（脚と腕。つながりで入れ替わりを見る） */
const SWAP_GROUPS: [number, number][][] = [
  [
    [25, 26],
    [27, 28],
    [29, 30],
    [31, 32],
  ],
  [
    [13, 14],
    [15, 16],
  ],
]

/** 推定モデルが左右の脚（腕）を取り違えたコマを、前のコマとのつながりで直す */
export function fixSwaps(frames: Point[][]): Point[][] {
  const out: Point[][] = []
  for (const f of frames) {
    const prev = out[out.length - 1]
    const cur = [...f]
    if (prev) {
      for (const group of SWAP_GROUPS) {
        let same = 0
        let swapped = 0
        for (const [a, b] of group) {
          same += dist(cur[a], prev[a]) + dist(cur[b], prev[b])
          swapped += dist(cur[b], prev[a]) + dist(cur[a], prev[b])
        }
        if (swapped < 0.5 * same) {
          for (const [a, b] of group) [cur[a], cur[b]] = [cur[b], cur[a]]
        }
      }
    }
    out.push(cur)
  }
  return out
}

export interface GaitClip {
  dir: 1 | -1
  start: number
  end: number
  /** 歩く速さ（体の高さ / 秒）。床を動かして見せるのに使う */
  speed: number
  frames: { t: number; pose: Pose3D }[]
}

function quantile(values: number[], q: number) {
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** 各点の座標を、前後のコマと [1, 2, 1] / 4 でなめらかにする */
function smoothFrames(frames: Point[][]): Point[][] {
  return frames.map((f, k) => {
    if (k === 0 || k === frames.length - 1) return f
    return f.map((p, i) => ({
      x: (frames[k - 1][i].x + 2 * p.x + frames[k + 1][i].x) / 4,
      y: (frames[k - 1][i].y + 2 * p.y + frames[k + 1][i].y) / 4,
    }))
  })
}

/** 使った通過ごとの、再生用の関節の位置。X: 体の左が +、Y: 上が +、Z: 進む向きが +（体の高さを 1 とする） */
export function gaitClips(input: GaitInput): GaitClip[] {
  const { passes } = preparePasses(input)
  const clips: GaitClip[] = []
  for (const pd of passes) {
    if (pd.pass.excluded) continue
    const ts = pd.frames.map((f) => f.t)
    const pts = smoothFrames(fixSwaps(pd.frames.map((f) => f.p)))
    const H = quantile(
      pts.map((p) => Math.max(p[29].y, p[30].y) - (p[7].y + p[8].y) / 2),
      0.9,
    )
    if (!(H > 0)) continue
    const floorY = quantile(
      pts.map((p) => Math.max(p[29].y, p[30].y, p[31].y, p[32].y)),
      0.95,
    )
    // 腰の中点の進み（直線）。そこからのずれだけを再生し、その場で歩くように見せる
    const hx = pts.map((p) => (p[23].x + p[24].x) / 2)
    const mt = ts.reduce((a, b) => a + b, 0) / ts.length
    const mx = hx.reduce((a, b) => a + b, 0) / hx.length
    let sxx = 0
    let sxy = 0
    ts.forEach((t, i) => {
      sxx += (t - mt) ** 2
      sxy += (t - mt) * (hx[i] - mx)
    })
    const slope = sxx > 0 ? sxy / sxx : 0
    const trend = (t: number) => mx + slope * (t - mt)
    const dir = pd.pass.dir
    const frames = pts.map((p, k) => {
      const points: (Vec3 | null)[] = Array.from({ length: 33 }, () => null)
      for (const i of USED) {
        const base = i === 0 ? 0 : i % 2 === 1 ? i : i - 1
        const lateral = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (LATERAL[base] ?? 0.06)
        points[i] = { x: lateral, y: (floorY - p[i].y) / H, z: (dir * (p[i].x - trend(ts[k]))) / H }
      }
      return { t: ts[k], pose: { points, depthSource: 'side_photo' as const } }
    })
    clips.push({ dir, start: ts[0], end: ts[ts.length - 1], speed: (Math.abs(slope) * 1000) / H, frames })
  }
  return clips
}
