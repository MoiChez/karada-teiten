// 動きの記録（今はスクワット）。横から撮った動画の、コマごとの体の点から関節の角度を求め、1 回ごとに区切る（docs/05 の 7 章）。
// 正常範囲とは比べず、良し悪しも判定しない。値は自分の過去の記録と比べるためのもの
import type { Landmark, Point } from './types'
import { MIN_VISIBILITY, NOTICEABLE_K } from './constants'
import { RAD2DEG, angleFromVerticalDeg, interiorAngleDeg, mean, std } from './geometry'
import { sidePoints } from './landmarks'
import { pointState } from './metrics'

export const MOTION_ALGORITHM_VERSION = 1

export type MotionKind = 'squat'

export const MOTION_KINDS: Record<MotionKind, { label: string }> = {
  squat: { label: 'スクワット' },
}

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

/** 動きの記録。動画（コマの画像）は、残すと選んだときだけ別の表に保存する */
export interface MotionRecord {
  id: string
  createdAt: string
  appVersion: string
  kind: MotionKind
  source: 'camera' | 'upload'
  modelVersion: string
  video: MotionVideoInfo
  /** 動画をこの端末に残したか */
  videoSaved: boolean
  frames: MotionFrameData[]
  analysis: MotionAnalysis
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

function unpackWorld(w: number[]): Landmark[] {
  const out: Landmark[] = []
  for (let i = 0; i + 2 < w.length; i += 3) out.push({ x: w[i], y: w[i + 1], z: w[i + 2] })
  return out
}

// ---------- 値の定義 ----------

export type SeriesKey = 'depth' | 'knee' | 'hip' | 'trunk' | 'shin'

export const SERIES_KEYS: SeriesKey[] = ['depth', 'knee', 'hip', 'trunk', 'shin']

export const SERIES: Record<SeriesKey, { label: string; short: string; unit: string; digits: number; doc: string }> = {
  depth: {
    label: 'しゃがむ深さ',
    short: '深さ',
    unit: '%',
    digits: 0,
    doc: '腰（股関節の点）がどれだけ下がったかを、立っているときの股関節から足首までの高さに対する割合で表した値です。0% が立った姿勢です。',
  },
  knee: {
    label: '膝の曲がり',
    short: '膝',
    unit: '°',
    digits: 0,
    doc: '股関節・膝・足首の点を結ぶ線の角度です。脚がまっすぐなとき 0° で、曲げるほど大きくなります。横から見た見かけの角度で、骨の角度ではありません。',
  },
  hip: {
    label: '股関節の曲がり',
    short: '股関節',
    unit: '°',
    digits: 0,
    doc: '肩・股関節・膝の点を結ぶ線の角度です。上体と太ももが一直線のとき 0° で、曲げるほど大きくなります。骨盤そのものの傾きは測れません。',
  },
  trunk: {
    label: '上体の前傾',
    short: '上体',
    unit: '°',
    digits: 0,
    doc: '股関節の点から肩の点への線が、鉛直からどれだけ前に傾いたかです。背中の丸みは含みません。',
  },
  shin: {
    label: 'すねの前傾',
    short: 'すね',
    unit: '°',
    digits: 0,
    doc: '足首の点から膝の点への線が、鉛直からどれだけ前に傾いたかです。足首がどれだけ曲がったかの目安になります。',
  },
}

export type MotionMetricKey = SeriesKey | 'descent' | 'ascent'

export const MOTION_METRIC_KEYS: MotionMetricKey[] = ['depth', 'knee', 'hip', 'trunk', 'shin', 'descent', 'ascent']

export const MOTION_METRICS: Record<MotionMetricKey, { label: string; unit: string; digits: number; doc: string }> = {
  depth: { label: 'いちばん深いところ', unit: '%', digits: 0, doc: SERIES.depth.doc },
  knee: { label: '膝の曲がり（最大）', unit: '°', digits: 0, doc: SERIES.knee.doc },
  hip: { label: '股関節の曲がり（最大）', unit: '°', digits: 0, doc: SERIES.hip.doc },
  trunk: { label: '上体の前傾（最大）', unit: '°', digits: 0, doc: SERIES.trunk.doc },
  shin: { label: 'すねの前傾（最大）', unit: '°', digits: 0, doc: SERIES.shin.doc },
  descent: { label: 'しゃがむ時間', unit: '秒', digits: 1, doc: '動き始めてから、いちばん深いところまでの時間です。' },
  ascent: { label: '立ち上がる時間', unit: '秒', digits: 1, doc: 'いちばん深いところから、立ち上がり終わるまでの時間です。' },
}

/**
 * 比べるときの最小のばらつきの目安（1 回ごとの揺れがこれより小さく出ても、これを下回らない）。
 * 推定の点の揺れから見積もった工学的な目安で、正常範囲ではない
 */
const MIN_UNCERTAINTY: Record<MotionMetricKey, number> = { depth: 2, knee: 2, hip: 2, trunk: 2, shin: 2, descent: 0.1, ascent: 0.1 }

/** 1 回と数える深さ（%）。ここまで下がった動きを 1 回とする */
export const REP_MIN_DEPTH = 15
/** 1 回が終わったとみなす深さ（%）。ここより浅く戻ったら区切る */
const REP_RETURN_DEPTH = 8
/** 動き始め・立ち上がり終わりとみなす、いちばん浅いところからの深さ（%） */
const ONSET_DEPTH = 3
/** これより長い途切れ（ミリ秒）があれば、前後を別の区間にする */
const MAX_GAP_MS = 250
/** 横向きの確認: 肩幅 / 胴の長さ がこれを超えたら、真横から撮れていない可能性を知らせる */
const SIDE_RATIO_MAX = 0.35

// ---------- 計算の途中 ----------

export interface MotionInput {
  frames: { t: number; lm: Landmark[]; world?: Landmark[] }[]
  width: number
  height: number
  rollDeg?: number
}

export function motionInputOf(r: Pick<MotionRecord, 'frames' | 'video'>): MotionInput {
  return {
    frames: r.frames.map((f) => ({ t: f.t, lm: unpackLandmarks(f.p), world: f.w ? unpackWorld(f.w) : undefined })),
    width: r.video.width,
    height: r.video.height,
    rollDeg: r.video.rollDeg,
  }
}

export interface PreparedFrame {
  t: number
  /** なめらかにした点（画像に対する比。画像に重ねて描くのに使う） */
  lm: Landmark[]
  /** なめらかにした点の、傾きを戻したピクセル座標（計算に使う） */
  px: Point[]
  /** なめらかにした 3D の点（あれば） */
  world?: Landmark[]
}

export interface PreparedMotion {
  frames: PreparedFrame[]
  /** 顔が画像の右を向いていれば +1 */
  f: 1 | -1
  nearSide: 'left' | 'right'
  /** 立っているときの股関節〜足首の高さ（ピクセル） */
  leg: number
  /** コマごとの値（frames と同じ並び） */
  series: Record<SeriesKey, number[]>
  /** 区間の切れ目（このコマの前で途切れている） */
  breaks: Set<number>
}

const vis = (l: Landmark | undefined) => (l ? Math.min(l.visibility ?? 1, l.presence ?? 1) : 0)

function quantile(values: number[], q: number) {
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

/** ガウスの重み（σ = 1.5 コマ）で、区間の中だけ前後のコマとなめらかにする */
const KERNEL = [-3, -2, -1, 0, 1, 2, 3].map((k) => ({ k, w: Math.exp(-(k * k) / (2 * 1.5 * 1.5)) }))

function smoothSeries(v: number[], segOf: number[]): number[] {
  return v.map((_, i) => {
    let s = 0
    let ws = 0
    for (const { k, w } of KERNEL) {
      const j = i + k
      if (j < 0 || j >= v.length || segOf[j] !== segOf[i] || !Number.isFinite(v[j])) continue
      s += v[j] * w
      ws += w
    }
    return ws > 0 ? s / ws : v[i]
  })
}

function smoothLandmarks(list: Landmark[][], segOf: number[], withZ: boolean): Landmark[][] {
  if (!list.length) return []
  const n = list[0].length
  const out: Landmark[][] = list.map((f) => f.map((l) => ({ ...l })))
  for (let i = 0; i < n; i++) {
    const xs = smoothSeries(
      list.map((f) => f[i].x),
      segOf,
    )
    const ys = smoothSeries(
      list.map((f) => f[i].y),
      segOf,
    )
    const zs = withZ
      ? smoothSeries(
          list.map((f) => f[i].z),
          segOf,
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

/** 検出できたコマから、なめらかにした点とコマごとの値を求める */
export function prepareMotion(input: MotionInput): PreparedMotion | null {
  const { width, height } = input
  const usable = input.frames.filter((fr) => fr.lm.length >= 33)
  if (usable.length < 5) return null
  const { nearSide, f } = orientationOf(usable, width)
  const s = sidePoints(nearSide)
  const need = [s.shoulder, s.hip, s.knee, s.ankle]
  const valid = usable.filter((fr) => {
    if (!need.every((i) => pointState(fr.lm[i]) !== 'none')) return false
    const p = uprightPx(fr.lm, width, height, input.rollDeg)
    // 推定が乱れて骨格が逆さ・横倒しになったコマを除く（肩が股関節より上、膝が足首より上）
    return p[s.shoulder].y < p[s.hip].y && p[s.knee].y < p[s.ankle].y
  })
  if (valid.length < 5) return null

  const segOf: number[] = []
  const breaks = new Set<number>()
  let seg = 0
  valid.forEach((fr, k) => {
    if (k > 0 && fr.t - valid[k - 1].t > MAX_GAP_MS) {
      seg++
      breaks.add(k)
    }
    segOf.push(seg)
  })
  const lms = smoothLandmarks(
    valid.map((fr) => fr.lm),
    segOf,
    false,
  )
  const hasWorld = valid.every((fr) => fr.world && fr.world.length >= 33)
  const worlds = hasWorld
    ? smoothLandmarks(
        valid.map((fr) => fr.world!),
        segOf,
        true,
      )
    : null
  const frames: PreparedFrame[] = valid.map((fr, k) => ({
    t: fr.t,
    lm: lms[k],
    px: uprightPx(lms[k], width, height, input.rollDeg),
    world: worlds?.[k],
  }))

  // 立っているときの股関節〜足首の高さ（高い方から 1 割のところ）
  const leg = quantile(
    frames.map((fr) => fr.px[s.ankle].y - fr.px[s.hip].y),
    0.9,
  )
  if (!(leg > 0)) return null

  const series: Record<SeriesKey, number[]> = { depth: [], knee: [], hip: [], trunk: [], shin: [] }
  for (const fr of frames) {
    const p = fr.px
    series.depth.push(((leg - (p[s.ankle].y - p[s.hip].y)) / leg) * 100)
    series.knee.push(180 - interiorAngleDeg(p[s.hip], p[s.knee], p[s.ankle]))
    series.hip.push(180 - interiorAngleDeg(p[s.shoulder], p[s.hip], p[s.knee]))
    series.trunk.push(angleFromVerticalDeg(p[s.hip], p[s.shoulder], f))
    series.shin.push(angleFromVerticalDeg(p[s.ankle], p[s.knee], f))
  }
  return { frames, f, nearSide, leg, series, breaks }
}

// ---------- 1 回ごとに区切る ----------

export interface MotionRep {
  /** 動き始め・いちばん深いところ・立ち上がり終わりの時刻（ミリ秒） */
  start: number
  bottom: number
  end: number
  /** いちばん深いところのコマの位置（prepareMotion の frames の添え字） */
  bottomIndex: number
  startIndex: number
  endIndex: number
  /** その回の中での最大 */
  max: Record<SeriesKey, number>
}

/**
 * 深さが REP_MIN_DEPTH を超えてから REP_RETURN_DEPTH 未満に戻るまでを 1 回とする。
 * 動き始め・終わりは、前後のいちばん浅いところから ONSET_DEPTH 深くなった（浅くなった）時刻
 */
export function findReps(prep: PreparedMotion): { reps: MotionRep[]; cutStart: boolean; cutEnd: boolean } {
  const d = prep.series.depth
  const n = d.length
  const segOf: number[] = []
  let seg = 0
  for (let i = 0; i < n; i++) {
    if (prep.breaks.has(i)) seg++
    segOf.push(seg)
  }
  // 深く入った区間（excursion）を探す
  const exc: { from: number; to: number; open: boolean; leftOk: boolean }[] = []
  let inside = false
  let leftOk = false
  let lastShallow = -1
  for (let i = 0; i < n; i++) {
    if (i > 0 && segOf[i] !== segOf[i - 1]) {
      if (inside) exc[exc.length - 1].open = true
      inside = false
      lastShallow = -1
    }
    if (!inside) {
      if (d[i] < REP_RETURN_DEPTH) lastShallow = i
      if (d[i] >= REP_MIN_DEPTH) {
        inside = true
        leftOk = lastShallow >= 0
        exc.push({ from: i, to: i, open: false, leftOk })
      }
    } else {
      exc[exc.length - 1].to = i
      if (d[i] < REP_RETURN_DEPTH) {
        inside = false
        lastShallow = i
      }
    }
  }
  if (inside && exc.length) exc[exc.length - 1].open = true

  const reps: MotionRep[] = []
  let cutStart = false
  let cutEnd = false
  const argMin = (a: number, b: number) => {
    let k = a
    for (let i = a; i <= b; i++) if (d[i] < d[k]) k = i
    return k
  }
  exc.forEach((e, k) => {
    if (!e.leftOk) {
      cutStart = true
      return
    }
    if (e.open) {
      cutEnd = true
      return
    }
    let bottom = e.from
    for (let i = e.from; i <= e.to; i++) if (d[i] > d[bottom]) bottom = i
    // 前後のいちばん浅いところ（同じ区間の中、前後の回の深いところまで）
    const prevTo = k > 0 && segOf[exc[k - 1].to] === segOf[bottom] ? exc[k - 1].to : segOf.indexOf(segOf[bottom])
    const nextFrom = k + 1 < exc.length && segOf[exc[k + 1].from] === segOf[bottom] ? exc[k + 1].from : segOf.lastIndexOf(segOf[bottom])
    const lo = argMin(prevTo, bottom)
    const hi = argMin(bottom, nextFrom)
    let start = lo
    for (let i = bottom; i >= lo; i--) {
      if (d[i] <= d[lo] + ONSET_DEPTH) {
        start = i
        break
      }
    }
    let end = hi
    for (let i = bottom; i <= hi; i++) {
      if (d[i] <= d[hi] + ONSET_DEPTH) {
        end = i
        break
      }
    }
    const max = {} as Record<SeriesKey, number>
    for (const key of SERIES_KEYS) {
      let m = -Infinity
      for (let i = start; i <= end; i++) m = Math.max(m, prep.series[key][i])
      max[key] = m
    }
    reps.push({
      start: prep.frames[start].t,
      bottom: prep.frames[bottom].t,
      end: prep.frames[end].t,
      startIndex: start,
      bottomIndex: bottom,
      endIndex: end,
      max,
    })
  })
  return { reps, cutStart, cutEnd }
}

// ---------- まとめ ----------

export interface MotionMetric {
  key: MotionMetricKey
  /** 回ごとの値の平均 */
  value: number | null
  /** 回ごとの値の標準偏差（2 回以上のとき） */
  sd: number | null
  /** 比べるときのばらつき（平均の揺れ。目安の下限あり） */
  uncertainty: number | null
  reps: number
  status: 'ok' | 'unavailable'
}

export interface MotionAnalysis {
  algorithmVersion: number
  facing: 'left' | 'right'
  nearSide: 'left' | 'right'
  /** 計算に使えたコマの数 */
  validFrames: number
  reps: { start: number; bottom: number; end: number; values: Record<MotionMetricKey, number> }[]
  metrics: MotionMetric[]
  warnings: string[]
}

export function repValues(r: MotionRep): Record<MotionMetricKey, number> {
  return { ...r.max, descent: (r.bottom - r.start) / 1000, ascent: (r.end - r.bottom) / 1000 }
}

export function analyzeMotion(input: MotionInput): MotionAnalysis {
  const warnings: string[] = []
  const prep = prepareMotion(input)
  if (!prep) {
    return {
      algorithmVersion: MOTION_ALGORITHM_VERSION,
      facing: 'left',
      nearSide: 'left',
      validFrames: 0,
      reps: [],
      metrics: MOTION_METRIC_KEYS.map((key) => ({ key, value: null, sd: null, uncertainty: null, reps: 0, status: 'unavailable' })),
      warnings: ['体を検出できたコマが少なく、測れませんでした。全身が画面に入る距離で、体の真横から撮ってください。'],
    }
  }
  const { reps, cutStart, cutEnd } = findReps(prep)

  // 真横から撮れているか（立っているコマの肩幅 / 胴の長さ）
  const s = sidePoints(prep.nearSide)
  const standing = prep.frames.filter((_, i) => prep.series.depth[i] < REP_RETURN_DEPTH)
  const ratios = standing
    .filter((fr) => [11, 12, 23, 24].every((i) => vis(fr.lm[i]) >= MIN_VISIBILITY * 0.6))
    .map((fr) => {
      const p = fr.px
      const sw = Math.hypot(p[11].x - p[12].x, p[11].y - p[12].y)
      const torso = Math.hypot(p[s.shoulder].x - p[s.hip].x, p[s.shoulder].y - p[s.hip].y)
      return torso > 0 ? sw / torso : 0
    })
  if (ratios.length >= 5 && quantile(ratios, 0.5) > SIDE_RATIO_MAX) {
    warnings.push('体が真横を向いていないようです。角度は横から見た見かけの値なので、斜めから撮ると変わります。次は体の真横から撮ってください。')
  }
  if (!reps.length) {
    warnings.push(`しゃがむ動きを見つけられませんでした。腰が、立っているときの股関節から足首までの高さの ${REP_MIN_DEPTH}% 以上下がって、立ち上がるまでを 1 回と数えます。`)
  }
  if (cutStart) warnings.push('撮り始めにしゃがんでいた 1 回は、動き始めが写っていないため数えていません。')
  if (cutEnd) warnings.push('撮り終わりの 1 回は、立ち上がるところまで写っていないため数えていません。')

  const values = reps.map(repValues)
  const metrics: MotionMetric[] = MOTION_METRIC_KEYS.map((key) => {
    const v = values.map((r) => r[key]).filter((x) => Number.isFinite(x))
    if (!v.length) return { key, value: null, sd: null, uncertainty: null, reps: 0, status: 'unavailable' }
    const sd = v.length >= 2 ? std(v) : null
    const se = sd !== null ? sd / Math.sqrt(v.length) : 0
    return { key, value: mean(v), sd, uncertainty: Math.max(se, MIN_UNCERTAINTY[key]), reps: v.length, status: 'ok' }
  })
  return {
    algorithmVersion: MOTION_ALGORITHM_VERSION,
    facing: prep.f === 1 ? 'right' : 'left',
    nearSide: prep.nearSide,
    validFrames: prep.frames.length,
    reps: reps.map((r, k) => ({ start: r.start, bottom: r.bottom, end: r.end, values: values[k] })),
    metrics,
    warnings,
  }
}

export function motionMetric(a: MotionAnalysis | undefined, key: MotionMetricKey) {
  return a?.metrics.find((m) => m.key === key)
}

export interface MotionChange {
  key: MotionMetricKey
  diff: number
  noticeable: boolean
}

/** 前の記録との差（両方とも測れた値だけ）。差が両方のばらつきを合わせた 2 倍を超えれば「差が見られる」 */
export function compareMotion(prev: MotionAnalysis, cur: MotionAnalysis): MotionChange[] {
  const out: MotionChange[] = []
  for (const key of MOTION_METRIC_KEYS) {
    const a = motionMetric(prev, key)
    const b = motionMetric(cur, key)
    if (a?.status !== 'ok' || b?.status !== 'ok' || a.value === null || b.value === null) continue
    const diff = b.value - a.value
    out.push({ key, diff, noticeable: Math.abs(diff) > NOTICEABLE_K * Math.hypot(a.uncertainty ?? 0, b.uncertainty ?? 0) })
  }
  return out
}

/** 計算の版が古ければ、保存した体の点から計算し直す */
export function upgradeMotion(r: MotionRecord): MotionRecord {
  if (r.analysis.algorithmVersion === MOTION_ALGORITHM_VERSION) return r
  return { ...r, analysis: analyzeMotion(motionInputOf(r)) }
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
  // 胴と脚の向きが食い違う（推定が乱れている・深くしゃがんでいる）ときは決めない
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
