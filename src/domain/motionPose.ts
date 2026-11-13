// 動きの 3D 再生用に、コマごとの関節の位置（Pose3D）を作る。
// 前後と上下は、横から撮った画面上の点（カメラ側の半身）から求め、角度のグラフと同じ動きにする。
// 左右の位置だけは、推定モデルの 3D の点（奥行きの推定）から取る。なければ標準の体の幅を当てる（表示だけに使う）。
// 自転車では、奥側の脚をカメラ側の脚の半回転ずれた動きにする（左右の脚は逆の位置にあるため）
import type { Pose3D, Vec3 } from './fusion3d'
import type { Landmark, Point } from './types'
import type { MotionCycle, PreparedMotion } from './motionSports'
import { sidePoints } from './landmarks'

/**
 * 座って行う種目で、体の大きさをそろえる比（標準の体の「股関節〜膝〜足首の長さ / 耳〜かかとの高さ」）。
 * 3D の人形（tools/blender/make_mannequins.py）の 3 体で 0.52〜0.55。表示の大きさだけに使う
 */
const LEG_TO_HEIGHT = 0.53

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

/** 奥側の脚の点（自転車で半回転ずらす点） */
const FAR_LEG = (near: 'left' | 'right') => (near === 'left' ? [26, 28, 30, 32] : [25, 27, 29, 31])

/** X: 体の左が +、Y: 上が +、Z: 前が +（体の高さを 1 とする）。かかとが床（Y = 0）、立っているときの足首が Z = 0 */
export function motionPoses(prep: PreparedMotion, cycles: MotionCycle[] = []): { t: number; pose: Pose3D }[] {
  const s = sidePoints(prep.nearSide)
  const fr = prep.frames
  // 立って行う種目は耳〜かかとの高さ、座って行う種目は脚の長さから体の高さを決める
  const H =
    prep.kind === 'squat'
      ? quantile(
          fr.map((f) => f.px[s.heel].y - f.px[s.ear].y),
          0.9,
        )
      : prep.leg / LEG_TO_HEIGHT
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
  // 自転車: 1 回転の長さの中央値の半分
  const periods = cycles.map((c) => c.end - c.start).sort((a, b) => a - b)
  const half = prep.kind === 'bike' && periods.length ? periods[Math.floor(periods.length / 2)] / 2 : 0
  const ts = fr.map((f) => f.t)
  const far = new Set(FAR_LEG(prep.nearSide))
  /** 時刻 t のカメラ側の点（股関節からの相対位置） */
  const nearRel = (t: number, i: number): Point => {
    const k = nearestIndex(ts, t)
    const p = fr[k].px[i]
    const h = fr[k].px[s.hip]
    return { x: p.x - h.x, y: p.y - h.y }
  }
  const last = ts[ts.length - 1]

  return fr.map((f) => {
    const points: (Vec3 | null)[] = Array.from({ length: 33 }, () => null)
    const w = f.world
    const hipMid = w ? { x: (w[23].x + w[24].x) / 2, z: (w[23].z + w[24].z) / 2 } : null
    for (const i of USED) {
      let p = f.px[nearOf(i, prep.nearSide)]
      if (half && far.has(i)) {
        // 半回転先（終わりを過ぎるなら半回転前）のカメラ側の脚の形を、今の股関節の位置に置く
        const tt = f.t + half <= last ? f.t + half : f.t - half
        const r = nearRel(tt, nearOf(i, prep.nearSide))
        p = { x: f.px[s.hip].x + r.x, y: f.px[s.hip].y + r.y }
      }
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

function nearestIndex(ts: number[], t: number) {
  let lo = 0
  let hi = ts.length - 1
  if (t <= ts[0]) return 0
  if (t >= ts[hi]) return hi
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (ts[m] <= t) lo = m
    else hi = m
  }
  return t - ts[lo] <= ts[hi] - t ? lo : hi
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

// ---------- 器具（表示だけ） ----------

export interface MotionEquipment {
  /** エルゴ: シートの高さ・レールの前後の範囲・足を置く板の位置 */
  erg?: { seatY: number; railFrom: number; railTo: number; foot: { y: number; z: number } }
  /** 自転車: クランクの軸の位置と半径（足首の点の通り道に当てた円）・サドル・ハンドル */
  bike?: { crank: { y: number; z: number; r: number }; saddle: { y: number; z: number }; bar: { y: number; z: number } | null }
}

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)

/**
 * 3D に添える器具の形を、体の点の動きから決める（器具を検出したものではない。表示の手がかり）。
 * エルゴ: シートは股関節のいちばん低い位置の少し下、レールは腰の動いた範囲。自転車: カメラ側の足首の点が回る円をクランクとみなす
 */
export function motionEquipment(kind: PreparedMotion['kind'], poses: { t: number; pose: Pose3D }[], near: 'left' | 'right'): MotionEquipment {
  if (!poses.length) return {}
  const s = sidePoints(near)
  const P = (i: number) => poses.map((p) => p.pose.points[i]).filter((v): v is Vec3 => !!v)
  if (kind === 'erg') {
    const hips = P(s.hip)
    const ankles = P(s.ankle)
    if (!hips.length || !ankles.length) return {}
    const zs = hips.map((h) => h.z)
    return {
      erg: {
        seatY: Math.min(...hips.map((h) => h.y)) - 0.045,
        railFrom: Math.min(...zs) - 0.2,
        railTo: avg(ankles.map((a) => a.z)) + 0.25,
        foot: { y: avg(ankles.map((a) => a.y)), z: avg(ankles.map((a) => a.z)) + 0.02 },
      },
    }
  }
  if (kind === 'bike') {
    const ankles = P(s.ankle)
    const hips = P(s.hip)
    const wrists = P(s.wrist)
    if (ankles.length < 3 || !hips.length) return {}
    // 円の当てはめ（代数的な最小二乗: z² + y² + D z + E y + F = 0）
    let szz = 0, szy = 0, syy = 0, sz = 0, sy = 0, szr = 0, syr = 0, sr = 0
    const n = ankles.length
    for (const a of ankles) {
      const r2 = a.z * a.z + a.y * a.y
      szz += a.z * a.z
      szy += a.z * a.y
      syy += a.y * a.y
      sz += a.z
      sy += a.y
      szr += a.z * r2
      syr += a.y * r2
      sr += r2
    }
    // [szz szy sz; szy syy sy; sz sy n] [D E F]^T = -[szr syr sr]^T
    const M = [
      [szz, szy, sz],
      [szy, syy, sy],
      [sz, sy, n],
    ]
    const rhs = [-szr, -syr, -sr]
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    const d0 = det(M)
    if (Math.abs(d0) < 1e-12) return {}
    const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? rhs[i] : v)))
    const D = det(col(0)) / d0
    const E = det(col(1)) / d0
    const F = det(col(2)) / d0
    const cz = -D / 2
    const cy = -E / 2
    const r = Math.sqrt(Math.max(0, cz * cz + cy * cy - F))
    if (!(r > 0.02 && r < 0.4)) return {}
    return {
      bike: {
        crank: { y: cy, z: cz, r },
        saddle: { y: avg(hips.map((h) => h.y)) - 0.04, z: avg(hips.map((h) => h.z)) },
        bar: wrists.length ? { y: avg(wrists.map((w) => w.y)), z: avg(wrists.map((w) => w.z)) } : null,
      },
    }
  }
  return {}
}
