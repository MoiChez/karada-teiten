// 動きの 3D 再生用に、コマごとの関節の位置（Pose3D）を作る。
// 前後と上下は、横から撮った画面上の点（カメラ側の半身）から求め、角度のグラフと同じ動きにする。
// 左右の位置は標準の体の幅を当てる（表示だけに使う）。本人の骨の長さと胴の上の端も付ける（3D の体を動画に重ねるため）。
// 自転車では、奥側の脚をカメラ側の脚の半回転ずれた動きにする（左右の脚は逆の位置にあるため）
import type { BoneLengths, Pose3D, Vec3 } from './fusion3d'
import type { Point } from './types'
import type { MotionCycle, PreparedMotion } from './motionSports'
import { sidePoints } from './landmarks'
import { PAIRS, bodySideIndex } from './motionFrontal'

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

/** 奥側の脚の点（自転車で半回転ずらす点） */
const FAR_LEG = (near: 'left' | 'right') => (near === 'left' ? [26, 28, 30, 32] : [25, 27, 29, 31])

/** X: 体の左が +、Y: 上が +、Z: 前が +（体の高さを 1 とする）。かかとが床（Y = 0）、立っているときの足首が Z = 0 */
/** 横から撮った記録の、3D の座標の決め方（体の高さ・床・前後の 0・動かない点でのずらし） */
function sideFrame(prep: PreparedMotion) {
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
  // 動かない点（自転車は腰、ほかは足首）を中央の位置に留めるように、コマごとに全体をずらす。
  // 手持ちでカメラが動いても、3D の体と器具の形がずれないように（その点の本当の小さな動きは消える）
  const anchor = prep.kind === 'bike' ? s.hip : s.ankle
  const ax = quantile(
    fr.map((f) => f.px[anchor].x),
    0.5,
  )
  const ay = quantile(
    fr.map((f) => f.px[anchor].y),
    0.5,
  )
  const shift = (k: number): Point => ({ x: fr[k].px[anchor].x - ax, y: fr[k].px[anchor].y - ay })
  const at = (k: number, i: number): Point => ({ x: fr[k].px[i].x - shift(k).x, y: fr[k].px[i].y - shift(k).y })
  const floorY = quantile(
    fr.map((_, k) => Math.max(at(k, s.heel).y, at(k, s.foot).y)),
    0.9,
  )
  const ankleX = quantile(
    fr.map((_, k) => at(k, s.ankle).x),
    0.5,
  )
  return { s, fr, H, at, shift, floorY, ankleX }
}

/** 正面・後ろから撮った記録の、3D の座標の決め方（体の高さ・床・左右の 0） */
function frontFrame(prep: PreparedMotion) {
  const fr = prep.frames
  const H = quantile(
    fr.map((f) => Math.max(f.px[29].y, f.px[30].y) - (f.px[7].y + f.px[8].y) / 2),
    0.9,
  )
  const floorY = quantile(
    fr.map((f) => Math.max(f.px[29].y, f.px[30].y, f.px[31].y, f.px[32].y)),
    0.9,
  )
  const cx = quantile(
    fr.map((f) => (f.px[27].x + f.px[28].x) / 2),
    0.5,
  )
  return { fr, H, floorY, cx }
}

/**
 * 3D の座標を、撮った動画の画面（傾きを戻したピクセル）に重ねるための対応。
 * 画面の横 = originX + shift.x + （3D の横の座標）× H、画面の縦 = floorY + shift.y − y × H。
 * 3D の横の座標は、カメラ camera の向きから見た右向き（横からなら ±Z、正面・後ろからなら ±X）
 */
export interface PoseMapping {
  ts: number[]
  H: number
  originX: number
  floorY: number
  shifts: Point[]
  /** 動画を撮ったカメラの位置: 顔が画面の右向き（体の右側から） / 左向き / 体の前から / 後ろから */
  camera: 'right' | 'left' | 'front' | 'rear'
}

export function poseMapping(prep: PreparedMotion): PoseMapping | null {
  const ts = prep.frames.map((f) => f.t)
  if (prep.kind === 'squat_front') {
    const { H, floorY, cx } = frontFrame(prep)
    if (!(H > 0)) return null
    return { ts, H, originX: cx, floorY, shifts: ts.map(() => ({ x: 0, y: 0 })), camera: prep.view?.view === 'front' ? 'front' : 'rear' }
  }
  const { H, shift, floorY, ankleX } = sideFrame(prep)
  if (!(H > 0)) return null
  return { ts, H, originX: ankleX, floorY, shifts: ts.map((_, k) => shift(k)), camera: prep.f === 1 ? 'right' : 'left' }
}

export function motionPoses(prep: PreparedMotion, cycles: MotionCycle[] = []): { t: number; pose: Pose3D }[] {
  if (prep.kind === 'squat_front') return frontalPoses(prep)
  const { s, fr, H, at, floorY, ankleX } = sideFrame(prep)
  if (!(H > 0)) return []
  // 自転車: 1 回転の長さの中央値の半分
  const periods = cycles.map((c) => c.end - c.start).sort((a, b) => a - b)
  const half = prep.kind === 'bike' && periods.length ? periods[Math.floor(periods.length / 2)] / 2 : 0
  const ts = fr.map((f) => f.t)
  const far = new Set(FAR_LEG(prep.nearSide))
  /** コマ k のカメラ側の点（股関節からの相対位置） */
  const nearRel = (k: number, i: number): Point => {
    const p = fr[k].px[i]
    const h = fr[k].px[s.hip]
    return { x: p.x - h.x, y: p.y - h.y }
  }
  const last = ts[ts.length - 1]
  // 自転車の奥側の脚: クランクの角度が半回転（180°）ずれたコマのカメラ側の脚の形を使う。
  // 回転の速さが変わっても、左右のペダルが常に反対の位置になるように（時間でずらすと、速さが変わるとずれる）
  const crank = prep.kind === 'bike' ? prep.crank : undefined
  const span = half ? Math.max(3, Math.round((half * 2.4) / Math.max(1, (last - ts[0]) / Math.max(1, ts.length - 1)))) : 0
  const opposite = (k: number): number => {
    if (!crank) return nearestIndex(ts, ts[k] + half <= last ? ts[k] + half : ts[k] - half)
    const want = (crank.angle[k] + 180) % 360
    let best = k
    let bestScore = Infinity
    for (let j = Math.max(0, k - span); j <= Math.min(fr.length - 1, k + span); j++) {
      let d = Math.abs(crank.angle[j] - want) % 360
      if (d > 180) d = 360 - d
      const score = d + Math.abs(j - k) * 0.5
      if (score < bestScore) {
        bestScore = score
        best = j
      }
    }
    return best
  }
  // 左右の位置は、標準の体の幅で固定する。横からの映像では推定モデルの奥行き（左右）の推定が当てにならず、
  // コマごとに使うと体がくねくね揺れ、中央値でも脚が大きく開いて見えたため（座った姿勢では体の高さの換算も外れる）
  const out = fr.map((f, k) => {
    const points: (Vec3 | null)[] = Array.from({ length: 33 }, () => null)
    const j = half && far.size ? opposite(k) : k
    for (const i of USED) {
      let p = at(k, nearOf(i, prep.nearSide))
      if (half && far.has(i)) {
        const r = nearRel(j, nearOf(i, prep.nearSide))
        const h = at(k, s.hip)
        p = { x: h.x + r.x, y: h.y + r.y }
      }
      const base = i === 0 ? 0 : i % 2 === 1 ? i : i - 1
      const x = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (LATERAL[base] ?? 0.06)
      points[i] = { x, y: (floorY - p.y) / H, z: (prep.f * (p.x - ankleX)) / H }
    }
    const pose: Pose3D = { points, depthSource: 'side_photo' }
    return { t: f.t, pose }
  })
  const bones = sideBoneLengths(out.map((o) => o.pose))
  for (const o of out) o.pose.bones = bones
  return out
}

/** 前後（z）と上下（y）の面の上の点 */
interface UV {
  u: number
  v: number
}
const uvMid = (a: Vec3, b: Vec3): UV => ({ u: (a.z + b.z) / 2, v: (a.y + b.y) / 2 })

/** 標準の体の「両肩の関節の中点〜耳の中点」の長さの、「股関節の中点〜両肩の関節の中点」に対する比（3D の人形 3 体で 0.50〜0.54） */
const NECK_TO_TRUNK = 0.52

/**
 * 横から撮った記録の、本人の骨の長さ（前後・上下の面の上の長さの、長い方から 4 分の 1 のところ）。
 * 3D の手足を標準の体の長さのままにすると、ひじや膝が動画の点からずれる（利用者のエルゴで、標準の腕は 2 割近く短かった）ため。
 * 長い方の値を使うのは、斜めから撮ると手足が短く写るコマがあるため（いちばん長い値は推定の揺れを拾うので使わない）
 */
export function sideBoneLengths(poses: Pose3D[]): BoneLengths | undefined {
  const len = (a: number, b: number) =>
    poses
      .map((p) => {
        const A = p.points[a]
        const B = p.points[b]
        return A && B ? Math.hypot(A.y - B.y, A.z - B.z) : NaN
      })
      .filter((v) => Number.isFinite(v))
  const pick = (a: number, b: number) => {
    const v = len(a, b)
    return v.length ? quantile(v, 0.75) : NaN
  }
  const out: BoneLengths = { upperArm: pick(11, 13), foreArm: pick(13, 15), thigh: pick(23, 25), shank: pick(25, 27) }
  if (!Object.values(out).every((v) => v > 0)) return undefined
  // 胴の長さ: 推定の肩の点は肩先で、3D の肩の関節より高い（利用者のエルゴで、耳〜肩の点は標準の体の耳〜肩の関節の 7 割）。
  // 肩の点との距離を使うと 3D の頭が耳より上にずれるので、股関節と耳の点（どちらも確かな点）から、胴の向きに沿って
  // 「胴の長さ t ＋ 首の長さ 0.52 t」で耳に届く t を、コマごとに求めて中央値を取る
  const ts: number[] = []
  for (const p of poses) {
    const [hl, hr, el, er, sl, sr] = [p.points[23], p.points[24], p.points[7], p.points[8], p.points[11], p.points[12]]
    if (!hl || !hr || !el || !er || !sl || !sr) continue
    const Hp = uvMid(hl, hr)
    const top = uvMid(sl, sr)
    const D = { u: uvMid(el, er).u - Hp.u, v: uvMid(el, er).v - Hp.v }
    const ul = Math.hypot(top.u - Hp.u, top.v - Hp.v)
    if (!(ul > 1e-6)) continue
    const du = (D.u * (top.u - Hp.u) + D.v * (top.v - Hp.v)) / ul
    const a = 1 - NECK_TO_TRUNK * NECK_TO_TRUNK
    const disc = du * du - a * (D.u * D.u + D.v * D.v)
    if (disc < 0) continue
    const t = (du - Math.sqrt(disc)) / a
    if (t > 0) ts.push(t)
  }
  if (ts.length) out.trunk = quantile(ts, 0.5)
  return out
}

/**
 * 正面・後ろから撮ったスクワットの 3D。左右と上下は画面の上の点（両側。体の左右に付け替える）から取る。
 * 前後は、正面からは画面に出ないので、骨の長さから組み立てる: 立っているときの太もも・すね・胴などの画面の上の長さを
 * その骨の長さとし、しゃがんで見かけが短くなった分だけ前後に傾いているとする（膝は足首より前、腰は膝より後ろ、
 * 肩は腰より前、つま先はかかとより前）。推定モデルの奥行きは、正面・後ろからの映像では当てにならないため使わない。
 * 体の高さ（耳〜かかと）を 1、かかとを床、足首の中点を左右と前後の 0 とする
 */
function frontalPoses(prep: PreparedMotion): { t: number; pose: Pose3D }[] {
  const { fr, H, floorY, cx } = frontFrame(prep)
  const L = prep.leftDir
  if (!(H > 0)) return []
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
  const midP = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  // コマごとに、体の左・右の点を付け替えた並び
  const sided = fr.map((f) => {
    const out: Point[] = [...f.px]
    for (const pair of Object.values(PAIRS)) {
      const [li, ri] = bodySideIndex(f.px, pair, L)
      out[pair[0]] = f.px[li]
      out[pair[1]] = f.px[ri]
    }
    return out
  })
  /** 骨の長さ（画面の上の長さの、長い方から 1 割のところ。立っているときの長さ） */
  const bone = (a: number, b: number, c?: number, e?: number) =>
    quantile(
      sided.map((p) => (c !== undefined && e !== undefined ? (d(p[a], p[b]) + d(p[c], p[e])) / 2 : d(p[a], p[b]))),
      0.9,
    )
  const shank = bone(25, 27, 26, 28)
  const thigh = bone(23, 25, 24, 26)
  const trunkLen = quantile(
    sided.map((p) => d(midP(p[11], p[12]), midP(p[23], p[24]))),
    0.9,
  )
  const upperArm = bone(11, 13, 12, 14)
  const foreArm = bone(13, 15, 14, 16)
  const footLen = 0.13 * H
  /** 骨の長さ len のうち、画面の上で見えている長さ seen を除いた、前後の長さ */
  const depth = (len: number, seen: number) => Math.sqrt(Math.max(0, len * len - seen * seen))

  return fr.map((f, k) => {
    const p = sided[k]
    const z: number[] = Array(33).fill(0)
    for (const [hip, knee, ankle, heel, toe] of [
      [23, 25, 27, 29, 31],
      [24, 26, 28, 30, 32],
    ] as const) {
      z[ankle] = 0
      z[knee] = depth(shank, d(p[knee], p[ankle]))
      z[hip] = z[knee] - depth(thigh, d(p[hip], p[knee]))
      z[heel] = -0.03 * H
      z[toe] = depth(footLen, d(p[toe], p[ankle]))
    }
    const zHip = (z[23] + z[24]) / 2
    const zSh = zHip + depth(trunkLen, d(midP(p[11], p[12]), midP(p[23], p[24])))
    z[11] = zSh
    z[12] = zSh
    // 腕: ひじは肩より少し後ろ、手首はひじの前後（見かけの長さから。向きは推定モデルの奥行きの符号を使う）
    const w = f.world
    const sign = (a: number, b: number) => {
      if (!w) return 1
      // 推定モデルの奥行きは、カメラに近いほど小さい。正面から撮ったときは体の前がカメラ側
      const fwd = prep.view?.view === 'front' ? -1 : 1
      return fwd * (w[a].z - w[b].z) >= 0 ? 1 : -1
    }
    for (const [sh, el, wr] of [
      [11, 13, 15],
      [12, 14, 16],
    ] as const) {
      z[el] = z[sh] + sign(el, sh) * depth(upperArm, d(p[el], p[sh]))
      z[wr] = z[el] + sign(wr, el) * depth(foreArm, d(p[wr], p[el]))
    }
    // 頭: 耳は肩の上、鼻は耳より前
    z[7] = zSh + 0.01 * H
    z[8] = zSh + 0.01 * H
    z[0] = zSh + 0.07 * H
    const points: (Vec3 | null)[] = Array.from({ length: 33 }, () => null)
    for (const i of [0, ...Object.values(PAIRS).flat()]) points[i] = { x: (L * (p[i].x - cx)) / H, y: (floorY - p[i].y) / H, z: z[i] / H }
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

const lerp3 = (p: Vec3, q: Vec3, k: number): Vec3 => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, z: p.z + (q.z - p.z) * k })

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
    bones: a.pose.bones,
    points: a.pose.points.map((p, i) => {
      const q = b.pose.points[i]
      if (!p || !q) return p
      return lerp3(p, q, k)
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
