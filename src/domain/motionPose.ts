// 動きの 3D 再生用に、コマごとの関節の位置（Pose3D）を作る。
// 前後と上下は、横から撮った画面上の点（カメラ側の半身）から求め、角度のグラフと同じ動きにする。
// 左右の位置だけは、推定モデルの 3D の点（奥行きの推定）から取る。なければ標準の体の幅を当てる（表示だけに使う）
import type { Pose3D, Vec3 } from './fusion3d'
import type { Landmark } from './types'
import type { PreparedMotion } from './motion'
import { sidePoints } from './landmarks'

/** 体の高さ（耳〜かかと）を 1 としたときの、体の中心から左右への距離（標準の体の目安） */
const LATERAL: Record<number, number> = { 7: 0.06, 11: 0.11, 13: 0.125, 15: 0.13, 23: 0.06, 25: 0.06, 27: 0.06, 29: 0.06, 31: 0.065 }
const USED = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]

function quantile(values: number[], q: number) {
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** 左右の対の点を、カメラ側の点にそろえる（左の点 → 右の点が対になる添え字） */
const nearOf = (i: number, near: 'left' | 'right') => {
  if (i === 0) return 0
  const left = i % 2 === 1 ? i : i - 1
  return near === 'left' ? left : left + 1
}

/** 推定モデルの 3D の点から、体の左右の向きの単位ベクトル（水平面の中）を求める */
function lateralAxis(worlds: Landmark[][]) {
  let x = 0
  let z = 0
  for (const w of worlds) {
    x += w[23].x - w[24].x + (w[11].x - w[12].x)
    z += w[23].z - w[24].z + (w[11].z - w[12].z)
  }
  const n = Math.hypot(x, z)
  return n > 0 ? { x: x / n, z: z / n } : null
}

/** X: 体の左が +、Y: 上が +、Z: 前が +（体の高さを 1 とする）。かかとが床（Y = 0）、立っているときの足首が Z = 0 */
export function motionPoses(prep: PreparedMotion): { t: number; pose: Pose3D }[] {
  const s = sidePoints(prep.nearSide)
  const fr = prep.frames
  const H = quantile(
    fr.map((f) => f.px[s.heel].y - f.px[s.ear].y),
    0.9,
  )
  if (!(H > 0)) return []
  const floorY = quantile(
    fr.map((f) => Math.max(f.px[s.heel].y, f.px[s.foot].y)),
    0.9,
  )
  const ankleX = quantile(
    fr.map((f) => f.px[s.ankle].x),
    0.5,
  )
  const worlds = fr.every((f) => f.world) ? fr.map((f) => f.world!) : null
  const axis = worlds ? lateralAxis(worlds) : null
  const Hw = worlds
    ? quantile(
        worlds.map((w) => w[s.heel].y - w[s.ear].y),
        0.9,
      )
    : 0
  const useWorld = !!axis && Hw > 0

  return fr.map((f) => {
    const points: (Vec3 | null)[] = Array.from({ length: 33 }, () => null)
    const w = f.world
    const hipMid = w ? { x: (w[23].x + w[24].x) / 2, z: (w[23].z + w[24].z) / 2 } : null
    for (const i of USED) {
      const p = f.px[nearOf(i, prep.nearSide)]
      let x: number
      if (useWorld && w && hipMid) {
        x = ((w[i].x - hipMid.x) * axis!.x + (w[i].z - hipMid.z) * axis!.z) / Hw
      } else {
        const base = i === 0 ? 0 : i % 2 === 1 ? i : i - 1
        x = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (LATERAL[base] ?? 0.06)
      }
      points[i] = { x, y: (floorY - p.y) / H, z: (prep.f * (p.x - ankleX)) / H }
    }
    return { t: f.t, pose: { points, depthSource: 'side_photo' as const } }
  })
}

/** 時刻 t（ミリ秒）の姿勢。コマの間は直線で補う */
export function poseAtTime(list: { t: number; pose: Pose3D }[], t: number): Pose3D | null {
  if (!list.length) return null
  let lo = 0
  let hi = list.length - 1
  if (t <= list[0].t) return list[0].pose
  if (t >= list[hi].t) return list[hi].pose
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (list[m].t <= t) lo = m
    else hi = m
  }
  const a = list[lo]
  const b = list[hi]
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0
  return {
    depthSource: a.pose.depthSource,
    points: a.pose.points.map((p, i) => {
      const q = b.pose.points[i]
      if (!p || !q) return p
      return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, z: p.z + (q.z - p.z) * k }
    }),
  }
}
