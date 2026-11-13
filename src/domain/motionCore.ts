// 動きの記録の土台（種目によらない部分）: 保存する形、点の詰め方、なめらか化、向き、山と谷の検出。
// 種目ごとの値と区切りは motionSports.ts、外から使う入口は motion.ts
import type { Landmark, Point } from './types'
import { MIN_VISIBILITY } from './constants'
import { RAD2DEG } from './geometry'
import { sidePoints } from './landmarks'
import { pointState } from './metrics'

export type MotionKind = 'squat' | 'erg' | 'bike'

// ---------- 保存する形 ----------

/** 1 コマの体の点。p: 33 点 × [x, y, 見えている度合い]（画像に対する比）。w: 33 点 × [x, y, z]（推定モデルの 3D、メートル、腰の中心が原点、y は下向き） */
export interface MotionFrameData {
  t: number
  p: number[]
  w?: number[]
}

export interface MotionVideoInfo {
  width: number
  height: number
  durationMs: number
  /** 推定にかけたコマの数 */
  frameCount: number
  fps: number
  /** 映像を時計回りに 90° 回した回数 */
  quarterTurns: number
  /** 端末の傾き（回した後に残る小さな傾き。度）。分からなければなし */
  rollDeg?: number
}

/** 手で直した点（そのコマの、画像に対する比の位置）。推定した点（frames）は書き換えずに別に持つ */
export interface MotionEdit {
  t: number
  i: number
  x: number
  y: number
}

export function packLandmarks(lm: Landmark[]): number[] {
  const out: number[] = []
  for (const l of lm) out.push(Math.round(l.x * 1e4) / 1e4, Math.round(l.y * 1e4) / 1e4, Math.round(vis(l) * 100) / 100)
  return out
}

export function packWorld(lm: Landmark[]): number[] {
  const out: number[] = []
  for (const l of lm) out.push(Math.round(l.x * 1e3) / 1e3, Math.round(l.y * 1e3) / 1e3, Math.round(l.z * 1e3) / 1e3)
  return out
}

export function unpackLandmarks(p: number[]): Landmark[] {
  const out: Landmark[] = []
  for (let i = 0; i + 2 < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: 0, visibility: p[i + 2] })
  return out
}

export function unpackWorld(w: number[]): Landmark[] {
  const out: Landmark[] = []
  for (let i = 0; i + 2 < w.length; i += 3) out.push({ x: w[i], y: w[i + 1], z: w[i + 2] })
  return out
}

// ---------- 計算の途中 ----------

export interface MotionInput {
  frames: { t: number; lm: Landmark[]; world?: Landmark[] }[]
  width: number
  height: number
  rollDeg?: number
  edits?: MotionEdit[]
}

export interface PreparedFrame {
  t: number
  /** なめらかにした点（画像に対する比。画像に重ねて描くのに使う。手で直した点はその位置） */
  lm: Landmark[]
  /** lm の、傾きを戻したピクセル座標（計算に使う） */
  px: Point[]
  /** なめらかにした 3D の点（あれば） */
  world?: Landmark[]
  /** 手で直した点 */
  edited: number[]
}

export interface PreparedBase {
  frames: PreparedFrame[]
  /** 顔が画像の右を向いていれば +1 */
  f: 1 | -1
  nearSide: 'left' | 'right'
  /** カメラ側の脚の長さ（股関節〜膝〜足首。ピクセル、中央値） */
  leg: number
  /** 区間の切れ目（このコマの前で途切れている） */
  breaks: Set<number>
}

/** これより長い途切れ（ミリ秒）があれば、前後を別の区間にする */
const MAX_GAP_MS = 250

export const vis = (l: Landmark | undefined) => (l ? Math.min(l.visibility ?? 1, l.presence ?? 1) : 0)

export function quantile(values: number[], q: number) {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** 映像の傾きを戻したピクセル座標（画像の中心のまわりに、時計回りに rollDeg 回す） */
export function uprightPx(lm: Landmark[], width: number, height: number, rollDeg = 0): Point[] {
  const r = rollDeg / RAD2DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  const cx = width / 2
  const cy = height / 2
  return lm.map((l) => {
    const dx = l.x * width - cx
    const dy = l.y * height - cy
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
  })
}

/** ガウスの重み（σ コマ、前後 2σ まで）で、区間の中だけ前後のコマとなめらかにする */
function kernelOf(sigma: number) {
  const half = Math.max(1, Math.ceil(2 * sigma))
  const out: { k: number; w: number }[] = []
  for (let k = -half; k <= half; k++) out.push({ k, w: Math.exp(-(k * k) / (2 * sigma * sigma)) })
  return out
}

export function smoothSeries(v: number[], segOf: number[], sigma = 1.5): number[] {
  const kernel = kernelOf(sigma)
  return v.map((_, i) => {
    let s = 0
    let ws = 0
    for (const { k, w } of kernel) {
      const j = i + k
      if (j < 0 || j >= v.length || segOf[j] !== segOf[i] || !Number.isFinite(v[j])) continue
      s += v[j] * w
      ws += w
    }
    return ws > 0 ? s / ws : v[i]
  })
}

function smoothLandmarks(list: Landmark[][], segOf: number[], withZ: boolean, sigma: number): Landmark[][] {
  if (!list.length) return []
  const n = list[0].length
  const out: Landmark[][] = list.map((f) => f.map((l) => ({ ...l })))
  for (let i = 0; i < n; i++) {
    const xs = smoothSeries(
      list.map((f) => f[i].x),
      segOf,
      sigma,
    )
    const ys = smoothSeries(
      list.map((f) => f[i].y),
      segOf,
      sigma,
    )
    const zs = withZ
      ? smoothSeries(
          list.map((f) => f[i].z),
          segOf,
          sigma,
        )
      : null
    for (let k = 0; k < list.length; k++) {
      out[k][i].x = xs[k]
      out[k][i].y = ys[k]
      if (zs) out[k][i].z = zs[k]
    }
  }
  return out
}

/** 横から見て、カメラ側の半身と顔の向きを、すべてのコマから決める */
function orientationOf(frames: MotionInput['frames'], width: number): { nearSide: 'left' | 'right'; f: 1 | -1 } {
  const leftSet = [7, 11, 23, 25, 27, 29, 31]
  const rightSet = [8, 12, 24, 26, 28, 30, 32]
  let vl = 0
  let vr = 0
  for (const fr of frames) {
    vl += leftSet.reduce((s, i) => s + vis(fr.lm[i]), 0)
    vr += rightSet.reduce((s, i) => s + vis(fr.lm[i]), 0)
  }
  const nearSide = vl >= vr ? 'left' : 'right'
  const s = sidePoints(nearSide)
  const cues = frames.map((fr) => (fr.lm[0].x - fr.lm[s.ear].x + (fr.lm[s.foot].x - fr.lm[s.heel].x)) * width)
  return { nearSide, f: quantile(cues, 0.5) >= 0 ? 1 : -1 }
}

/** 手で直した点を、そのコマに当てる（見えている度合いは 1 にする） */
function applyEdits(frames: MotionInput['frames'], edits: MotionEdit[] | undefined) {
  if (!edits?.length) return frames.map((fr) => ({ ...fr, edited: [] as number[] }))
  const byT = new Map<number, MotionEdit[]>()
  for (const e of edits) byT.set(e.t, [...(byT.get(e.t) ?? []), e])
  return frames.map((fr) => {
    const list = byT.get(fr.t)
    if (!list) return { ...fr, edited: [] as number[] }
    const lm = fr.lm.map((l) => ({ ...l }))
    for (const e of list) lm[e.i] = { ...lm[e.i], x: e.x, y: e.y, visibility: 1, presence: 1 }
    return { ...fr, lm, edited: list.map((e) => e.i) }
  })
}

/**
 * 検出できたコマから、なめらかにした点を求める。valid は、計算に使えるコマか（種目ごと。傾きを戻したピクセル座標）。
 * sigma は、なめらかにする強さ（コマ数）。速い動きほど弱くする（強すぎると、角度の山と谷が削られる）。
 * 手で直した点は、なめらか化の後もその位置のままにする（前後のコマに引き戻されないように）
 */
export function prepareBase(input: MotionInput, valid: (p: Point[], s: ReturnType<typeof sidePoints>) => boolean, sigma = 1.5): PreparedBase | null {
  const { width, height } = input
  const usable = applyEdits(
    input.frames.filter((fr) => fr.lm.length >= 33),
    input.edits,
  )
  if (usable.length < 5) return null
  const { nearSide, f } = orientationOf(usable, width)
  const s = sidePoints(nearSide)
  const need = [s.shoulder, s.hip, s.knee, s.ankle]
  const ok = usable.filter((fr) => {
    if (!need.every((i) => pointState(fr.lm[i]) !== 'none')) return false
    return valid(uprightPx(fr.lm, width, height, input.rollDeg), s)
  })
  if (ok.length < 5) return null

  const segOf: number[] = []
  const breaks = new Set<number>()
  let seg = 0
  ok.forEach((fr, k) => {
    if (k > 0 && fr.t - ok[k - 1].t > MAX_GAP_MS) {
      seg++
      breaks.add(k)
    }
    segOf.push(seg)
  })
  const lms = smoothLandmarks(
    ok.map((fr) => fr.lm),
    segOf,
    false,
    sigma,
  )
  ok.forEach((fr, k) => {
    for (const i of fr.edited) lms[k][i] = { ...fr.lm[i] }
  })
  const hasWorld = ok.every((fr) => fr.world && fr.world.length >= 33)
  const worlds = hasWorld
    ? smoothLandmarks(
        ok.map((fr) => fr.world!),
        segOf,
        true,
        sigma,
      )
    : null
  const frames: PreparedFrame[] = ok.map((fr, k) => ({
    t: fr.t,
    lm: lms[k],
    px: uprightPx(lms[k], width, height, input.rollDeg),
    world: worlds?.[k],
    edited: fr.edited,
  }))
  const leg = quantile(
    frames.map((fr) => Math.hypot(fr.px[s.hip].x - fr.px[s.knee].x, fr.px[s.hip].y - fr.px[s.knee].y) + Math.hypot(fr.px[s.knee].x - fr.px[s.ankle].x, fr.px[s.knee].y - fr.px[s.ankle].y)),
    0.5,
  )
  if (!(leg > 0)) return null
  return { frames, f, nearSide, leg, breaks }
}

/** 区間の番号（途切れで分ける） */
export function segmentsOf(n: number, breaks: Set<number>): number[] {
  const out: number[] = []
  let seg = 0
  for (let i = 0; i < n; i++) {
    if (breaks.has(i)) seg++
    out.push(seg)
  }
  return out
}

/**
 * 山（極大）を探す。prominence: 両側の谷からの高さの最小、minGap: 山どうしの最小の間（ミリ秒）。
 * 区間の切れ目をまたがない。谷を探すときは値の符号を反転して渡す
 */
export function findPeaks(v: number[], ts: number[], segOf: number[], prominence: number, minGap: number): number[] {
  const n = v.length
  const cand: number[] = []
  for (let i = 1; i < n - 1; i++) {
    if (segOf[i - 1] !== segOf[i] || segOf[i + 1] !== segOf[i]) continue
    if (v[i] >= v[i - 1] && v[i] > v[i + 1]) cand.push(i)
  }
  const prom = (i: number) => {
    let left = v[i]
    for (let j = i - 1; j >= 0 && segOf[j] === segOf[i]; j--) {
      if (v[j] > v[i]) break
      left = Math.min(left, v[j])
    }
    let right = v[i]
    for (let j = i + 1; j < n && segOf[j] === segOf[i]; j++) {
      if (v[j] > v[i]) break
      right = Math.min(right, v[j])
    }
    return v[i] - Math.max(left, right)
  }
  const strong = cand.filter((i) => prom(i) >= prominence)
  // 近すぎる山は高い方を残す
  const out: number[] = []
  for (const i of strong) {
    const last = out[out.length - 1]
    if (last !== undefined && segOf[last] === segOf[i] && ts[i] - ts[last] < minGap) {
      if (v[i] > v[last]) out[out.length - 1] = i
    } else out.push(i)
  }
  return out
}

// ---------- 映像の向き ----------

/** 全身が写っているかを見る点（左右の対） */
const REQUIRED_PAIRS: [number, number][] = [
  [7, 8],
  [11, 12],
  [23, 24],
  [25, 26],
  [27, 28],
  [29, 30],
]
const inFrame = (l: Landmark) => l.x >= 0.005 && l.x <= 0.995 && l.y >= 0.005 && l.y <= 0.995

/** 全身が画面の中に写っているコマか */
export function fullBodyInFrame(lm: Landmark[]): boolean {
  if (lm.length < 33) return false
  return REQUIRED_PAIRS.every(([a, b]) => inFrame(lm[a]) && inFrame(lm[b]) && Math.max(vis(lm[a]), vis(lm[b])) >= MIN_VISIBILITY)
}

/** 体の向き（股関節の中点→肩の中点）から、映像を時計回りに何回 90° 回せば上が上になるか */
export function turnsFromBody(lm: Landmark[], width: number, height: number): number | null {
  if (lm.length < 33) return null
  const ok = (a: number, b: number) => Math.max(vis(lm[a]), vis(lm[b])) >= MIN_VISIBILITY
  if (!ok(11, 12) || !ok(23, 24) || !ok(27, 28)) return null
  const at = (a: number, b: number) => ({ x: ((lm[a].x + lm[b].x) / 2) * width, y: ((lm[a].y + lm[b].y) / 2) * height })
  const S = at(11, 12)
  const P = at(23, 24)
  const A = at(27, 28)
  const angle = (from: Point, to: Point) => Math.atan2(to.x - from.x, -(to.y - from.y)) * RAD2DEG
  const trunk = angle(P, S)
  const legs = angle(A, P)
  // 胴と脚の向きが食い違う（推定が乱れている・しゃがむ・座っている）ときは決めない
  let diff = Math.abs(trunk - legs) % 360
  if (diff > 180) diff = 360 - diff
  if (diff > 45) return null
  const k = Math.round(-trunk / 90)
  return (((k % 4) + 5) % 4) - 1
}

/**
 * 何コマかの体の向きから、映像を回す回数を決める。過半数（3 コマ以上）が同じ向きを示したときだけ回す。
 * 1 コマの推定の乱れ（骨格が逆さに出るなど）で、映像全体を回してしまわないため
 */
export function voteTurns(votes: (number | null)[]): number {
  const counts = new Map<number, number>()
  for (const k of votes) if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1)
  let best = 0
  let bestCount = 0
  for (const [k, c] of counts) {
    if (c > bestCount) {
      best = k
      bestCount = c
    }
  }
  return best !== 0 && bestCount >= 3 ? best : 0
}
