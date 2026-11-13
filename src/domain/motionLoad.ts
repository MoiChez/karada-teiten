// 推定の重心と、関節の負担（条件付きの準静的なモデル）。スクワットだけ。
// 外から加わる力（床反力）は測っていないので、すべて仮定の上に立つ推定で、測った値ではない。
// - 重心: Winter (2009) の体節の質量比と重心の位置。横から見た画面の上で、左右の手足は同じ位置とみなす
// - 負担: 床反力は鉛直で、大きさは（体重 + 持つ重さ）×（重力 + 重心の上下の加速度）。左右の脚に分け、
//   足の上の 1 点（足圧中心）にかかるとして、足首・膝・股関節のまわりの力のモーメントを求める（体節の重さも入れる）。
//   ゆっくりした動きでは体はほぼつり合っているので、足圧中心は推定の重心の真下（足の外なら足の端）に置く
// - 仮定を動かした幅: 足圧中心を、その位置から足の長さの ±25%、左右の配分を 4:6〜6:4 で動かしたときの最小〜最大
import type { Point } from './types'
import { H_TO_STATURE } from './constants'
import { angleFromVerticalDeg, interiorAngleDeg } from './geometry'
import type { sidePoints } from './landmarks'
import { quantile, segmentsOf, type PreparedFrame } from './motionCore'

type Side = ReturnType<typeof sidePoints>

// ---------- 体の大きさ ----------

/** 記録ごとの体の値（入力されたものだけ） */
export interface BodyParams {
  heightCm?: number
  weightKg?: number
  /** 持つ重さ（バーベルなど） */
  loadKg?: number
}

/** 入力がないときに置く値 */
export const BODY_PRIOR = { heightCm: 170, weightKg: 70, loadKg: 0 } as const

export interface ResolvedBody {
  heightCm: number
  weightKg: number
  loadKg: number
  /** 仮定の値を使ったか */
  assumed: { height: boolean; weight: boolean; load: boolean }
}

const ok = (v: number | undefined, lo: number, hi: number): v is number => v !== undefined && Number.isFinite(v) && v >= lo && v <= hi

export function resolveBody(b: BodyParams | undefined): ResolvedBody {
  const h = ok(b?.heightCm, 100, 230)
  const w = ok(b?.weightKg, 20, 250)
  const l = ok(b?.loadKg, 0, 400)
  return {
    heightCm: h ? b!.heightCm! : BODY_PRIOR.heightCm,
    weightKg: w ? b!.weightKg! : BODY_PRIOR.weightKg,
    loadKg: l ? b!.loadKg! : BODY_PRIOR.loadKg,
    assumed: { height: !h, weight: !w, load: !l },
  }
}

// ---------- 重心（Winter 2009） ----------

/** 体節の質量比（体重に対する割合。手足は片側）。両側を足すと 1 になる */
export const SEGMENT_MASS = { head: 0.081, trunk: 0.497, upperArm: 0.028, forearm: 0.022, thigh: 0.1, shank: 0.0465, foot: 0.0145 } as const
/** 体節の重心の位置（近位の点からの割合） */
const SEGMENT_COM = { upperArm: 0.436, forearm: 0.682, thigh: 0.433, shank: 0.433, foot: 0.5 } as const

const G = 9.81
const lerp = (a: Point, b: Point, k: number): Point => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
const elbowOf = (s: Side) => s.wrist - 2

/** 脚の体節の重心（片側）: 太もも・すね・足 */
function legSegments(p: Point[], s: Side) {
  return {
    thigh: lerp(p[s.hip], p[s.knee], SEGMENT_COM.thigh),
    shank: lerp(p[s.knee], p[s.ankle], SEGMENT_COM.shank),
    foot: lerp(p[s.heel], p[s.foot], SEGMENT_COM.foot),
  }
}

/** 上体（頭・胴・両腕）の重心と、その質量比の合計 */
function upperBody(p: Point[], s: Side): { c: Point; m: number } {
  const parts: [Point, number][] = [
    [p[s.ear], SEGMENT_MASS.head],
    [lerp(p[s.hip], p[s.shoulder], 0.5), SEGMENT_MASS.trunk],
    [lerp(p[s.shoulder], p[elbowOf(s)], SEGMENT_COM.upperArm), 2 * SEGMENT_MASS.upperArm],
    [lerp(p[elbowOf(s)], p[s.wrist], SEGMENT_COM.forearm), 2 * SEGMENT_MASS.forearm],
  ]
  const m = parts.reduce((a, [, w]) => a + w, 0)
  return { c: { x: parts.reduce((a, [q, w]) => a + q.x * w, 0) / m, y: parts.reduce((a, [q, w]) => a + q.y * w, 0) / m }, m }
}

/** 全身の重心（横から見た画面の上。左右の手足は同じ位置とみなす）。持つ重さは手首の位置に足す */
export function bodyCom(p: Point[], s: Side, weightKg = 1, loadKg = 0): Point {
  const up = upperBody(p, s)
  const leg = legSegments(p, s)
  const parts: [Point, number][] = [
    [up.c, up.m],
    [leg.thigh, 2 * SEGMENT_MASS.thigh],
    [leg.shank, 2 * SEGMENT_MASS.shank],
    [leg.foot, 2 * SEGMENT_MASS.foot],
  ]
  const load = loadKg / weightKg
  if (load > 0) parts.push([p[s.wrist], load])
  const m = parts.reduce((a, [, w]) => a + w, 0)
  return { x: parts.reduce((a, [q, w]) => a + q.x * w, 0) / m, y: parts.reduce((a, [q, w]) => a + q.y * w, 0) / m }
}

// ---------- 負担 ----------

/** 足圧中心を、重心の真下から動かす量（足の長さに対する割合）と、カメラ側の脚への配分の、基準の仮定と動かす範囲 */
export const COP_SHIFTS = [-0.25, -0.125, 0, 0.125, 0.25]
export const SPLIT_BASE = 0.5
export const SPLIT_RANGE = [0.4, 0.5, 0.6]
/** 膝の負担がこれ（Nm）より小さいコマ（ほぼ立っているとき）は、比を出さない */
export const KNEE_MOMENT_MIN = 10
/** 重心の上下の加速度は、重力の ± この割合までに抑える */
const ACC_CLIP = 0.5

export type JointKey = 'knee' | 'hip' | 'trunk' | 'ankle'
export type ContractionPhase = 'concentric' | 'eccentric' | 'isometric'

export interface LoadSeries {
  /** 1 ピクセルあたりのメートル（立っているときの耳〜かかとの高さを、身長 × 0.91 とした） */
  mPerPx: number
  /** 推定の重心（持つ重さを含む。傾きを戻したピクセル座標） */
  com: Point[]
  /** 股関節 ÷ 膝の負担の比（基準の仮定）と、仮定を動かした幅。膝の負担が小さいコマは NaN */
  ratio: number[]
  ratioLo: number[]
  ratioHi: number[]
  /** 関節ごとの、基準の大きさに対する負担の割合（0〜1 に収めた推定の要求度） */
  demand: Record<JointKey, number[]>
  /** 関節の動きの向き（伸びながら / 縮みながら / ほぼ止まって） */
  phase: Record<JointKey, ContractionPhase[]>
}

/** 関節を伸ばす向きの負担の大きさ（片脚。基準の仮定の割合 split・足圧中心 cop）。x は前向きが +、メートル */
function legMoments(p: Point[], s: Side, toM: (q: Point) => Point, force: number, split: number, cop: number, weightKg: number) {
  const q = (i: number) => toM(p[i])
  const seg = legSegments(p, s)
  const thigh = toM(seg.thigh)
  const shank = toM(seg.shank)
  const foot = toM(seg.foot)
  const heel = q(s.heel)
  const toe = q(s.foot)
  const xCop = heel.x + (toe.x - heel.x) * cop
  const F = force * split
  const mg = (w: number) => w * weightKg * G
  const around = (x: number, segs: [Point, number][]) => F * (xCop - x) - segs.reduce((a, [c, w]) => a + mg(w) * (c.x - x), 0)
  return {
    ankle: around(q(s.ankle).x, [[foot, SEGMENT_MASS.foot]]),
    knee: around(q(s.knee).x, [
      [foot, SEGMENT_MASS.foot],
      [shank, SEGMENT_MASS.shank],
    ]),
    hip: around(q(s.hip).x, [
      [foot, SEGMENT_MASS.foot],
      [shank, SEGMENT_MASS.shank],
      [thigh, SEGMENT_MASS.thigh],
    ]),
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const flex = (a: Point, b: Point, c: Point) => 180 - interiorAngleDeg(a, b, c)

/**
 * 要求度 D = clip(0.7 × |負担| / 基準 + 0.3 × 曲がりの度合い, 0.05, 1)。
 * 基準は「（体重 + 重さ）× 重力 × 身長の 10%」（脚は片脚ぶんで半分）。曲がりの度合いは、膝・股関節 120°、上体 60°、すね 45° を 1 とする
 */
const W_MOMENT = 0.7
const W_ROM = 0.3
const ROM_FULL: Record<JointKey, number> = { knee: 120, hip: 120, trunk: 60, ankle: 45 }
/** これより遅い（度/秒）と「ほぼ止まって」 */
const STILL_DEG_PER_S = 15

export function squatLoad(frames: PreparedFrame[], s: Side, f: 1 | -1, body: ResolvedBody, breaks: Set<number>): LoadSeries | null {
  const n = frames.length
  if (n < 5) return null
  const standH = quantile(
    frames.map((fr) => fr.px[s.heel].y - fr.px[s.ear].y),
    0.9,
  )
  if (!(standH > 0)) return null
  const stature = body.heightCm / 100
  const mPerPx = (stature * H_TO_STATURE) / standH
  // 前向き（顔の向き）を +x、上を +y にしたメートル
  const toM = (q: Point): Point => ({ x: f * q.x * mPerPx, y: -q.y * mPerPx })
  const M = body.weightKg + body.loadKg
  const com = frames.map((fr) => bodyCom(fr.px, s, body.weightKg, body.loadKg))
  const comY = com.map((c) => toM(c).y)
  const ts = frames.map((fr) => fr.t / 1000)
  const segOf = segmentsOf(n, breaks)
  // 重心の上下の加速度（前後 3 コマの差から）
  const acc = comY.map((_, k) => {
    const a = k - 3
    const b = k + 3
    if (a < 0 || b >= n || segOf[a] !== segOf[k] || segOf[b] !== segOf[k]) return 0
    const v1 = (comY[k] - comY[a]) / (ts[k] - ts[a])
    const v2 = (comY[b] - comY[k]) / (ts[b] - ts[k])
    return clamp((2 * (v2 - v1)) / (ts[b] - ts[a]), -ACC_CLIP * G, ACC_CLIP * G)
  })

  const ratio: number[] = []
  const ratioLo: number[] = []
  const ratioHi: number[] = []
  const moments: Record<JointKey, number[]> = { knee: [], hip: [], trunk: [], ankle: [] }
  // 足圧中心の基準: 重心の真下（かかと 0〜つま先 1。足の外なら端）
  const copBase = frames.map((fr, k) => {
    const heel = fr.px[s.heel].x
    const toe = fr.px[s.foot].x
    return Math.abs(toe - heel) < 1 ? 0.5 : clamp((com[k].x - heel) / (toe - heel), 0, 1)
  })
  frames.forEach((fr, k) => {
    const force = M * (G + acc[k])
    const base = legMoments(fr.px, s, toM, force, SPLIT_BASE, copBase[k], body.weightKg)
    moments.knee.push(Math.abs(base.knee))
    moments.hip.push(Math.abs(base.hip))
    moments.ankle.push(Math.abs(base.ankle))
    // 上体（と持つ重さ）が股関節のまわりに作る負担（背中を伸ばす筋肉の目安）
    const up = upperBody(fr.px, s)
    const hipX = toM(fr.px[s.hip]).x
    moments.trunk.push(Math.abs(G * (up.m * body.weightKg * (toM(up.c).x - hipX) + body.loadKg * (toM(fr.px[s.wrist]).x - hipX))))
    const r = (m: { hip: number; knee: number }) => (Math.abs(m.knee) >= KNEE_MOMENT_MIN ? Math.abs(m.hip) / Math.abs(m.knee) : NaN)
    const v = r(base)
    let lo = Infinity
    let hi = -Infinity
    for (const cop of COP_SHIFTS.map((d) => clamp(copBase[k] + d, 0, 1))) {
      for (const split of SPLIT_RANGE) {
        const x = r(legMoments(fr.px, s, toM, force, split, cop, body.weightKg))
        if (!Number.isFinite(x)) continue
        lo = Math.min(lo, x)
        hi = Math.max(hi, x)
      }
    }
    ratio.push(v)
    ratioLo.push(Number.isFinite(v) && Number.isFinite(lo) ? Math.min(lo, v) : NaN)
    ratioHi.push(Number.isFinite(v) && Number.isFinite(hi) ? Math.max(hi, v) : NaN)
  })

  // 要求度と、動きの向き
  const angles: Record<JointKey, number[]> = {
    knee: frames.map((fr) => flex(fr.px[s.hip], fr.px[s.knee], fr.px[s.ankle])),
    hip: frames.map((fr) => flex(fr.px[s.shoulder], fr.px[s.hip], fr.px[s.knee])),
    trunk: frames.map((fr) => angleFromVerticalDeg(fr.px[s.hip], fr.px[s.shoulder], f)),
    ankle: frames.map((fr) => angleFromVerticalDeg(fr.px[s.ankle], fr.px[s.knee], f)),
  }
  const legRef = 0.5 * M * G * 0.1 * stature
  const ref: Record<JointKey, number> = {
    knee: legRef,
    hip: legRef,
    ankle: legRef,
    trunk: (upperBody(frames[0].px, s).m * body.weightKg + body.loadKg) * G * 0.1 * stature,
  }
  const demand = {} as Record<JointKey, number[]>
  const phase = {} as Record<JointKey, ContractionPhase[]>
  for (const j of ['knee', 'hip', 'trunk', 'ankle'] as JointKey[]) {
    demand[j] = moments[j].map((m, k) => clamp(W_MOMENT * (m / ref[j]) + W_ROM * clamp(angles[j][k] / ROM_FULL[j], 0, 1), 0.05, 1))
    phase[j] = angles[j].map((_, k) => {
      const a = Math.max(0, k - 2)
      const b = Math.min(n - 1, k + 2)
      if (segOf[a] !== segOf[b] || ts[b] <= ts[a]) return 'isometric'
      const w = (angles[j][b] - angles[j][a]) / (ts[b] - ts[a])
      // どの関節も伸ばす向きに力を出している前提: 曲がっていく = 伸びながら、戻っていく = 縮みながら
      return w > STILL_DEG_PER_S ? 'eccentric' : w < -STILL_DEG_PER_S ? 'concentric' : 'isometric'
    })
  }
  return { mPerPx, com, ratio, ratioLo, ratioHi, demand, phase }
}

/** 筋肉と、その要求度を決める関節（スクワット） */
export const MUSCLE_JOINT = { quads: 'knee', glutes: 'hip', hamstrings: 'hip', erectors: 'trunk', calves: 'ankle' } as const

export const PHASE_LABELS: Record<ContractionPhase, string> = {
  eccentric: '伸びながら力を出す',
  concentric: '縮みながら力を出す',
  isometric: 'ほぼ止まって力を出す',
}
