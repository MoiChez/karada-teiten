// 種目ごとの定義: グラフに出す値（コマごと）、1 回の区切り方、1 回ごとの値。docs/05 の 7 章。
// どの値も、横から見た見かけの角度・位置で、正常範囲とは比べない
import type { Point } from './types'
import { angleFromVerticalDeg, interiorAngleDeg } from './geometry'
import { sidePoints } from './landmarks'
import { findPeaks, segmentsOf, type MotionKind, type PreparedBase } from './motionCore'

type Side = ReturnType<typeof sidePoints>

export interface SeriesCtx {
  s: Side
  f: 1 | -1
  /** カメラ側の脚の長さ（ピクセル） */
  leg: number
  /** 立っているときの股関節〜足首の高さ（ピクセル。スクワットの深さに使う） */
  standLeg: number
}

export interface SeriesDef {
  key: string
  label: string
  short: string
  unit: string
  digits: number
  doc: string
  value: (p: Point[], c: SeriesCtx) => number
}

export interface PreparedMotion extends PreparedBase {
  kind: MotionKind
  standLeg: number
  /** コマごとの値（frames と同じ並び） */
  series: Record<string, number[]>
}

export interface MotionEvent {
  key: string
  label: string
  index: number
  t: number
}

/** 1 回（スクワットの 1 回、エルゴの 1 本、自転車の 1 回転） */
export interface MotionCycle {
  startIndex: number
  endIndex: number
  start: number
  end: number
  events: MotionEvent[]
}

export interface MetricDef {
  key: string
  label: string
  /** 表の見出し */
  short: string
  unit: string
  digits: number
  doc: string
  /** 比べるときの最小のばらつきの目安（推定の点の揺れから見た工学的な目安で、正常範囲ではない） */
  floor: number
  value: (c: MotionCycle, prep: PreparedMotion) => number | null
}

/** 種目で一般に主に使われる筋肉（3D の体に場所を色で示すだけ。個人の測定値ではない） */
export type MuscleKey = 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'erectors' | 'lats' | 'biceps'

export const MUSCLE_LABELS: Record<MuscleKey, string> = {
  quads: '太ももの前（大腿四頭筋）',
  hamstrings: '太ももの裏（ハムストリング）',
  glutes: 'お尻（大殿筋）',
  calves: 'ふくらはぎ（下腿三頭筋）',
  erectors: '背骨に沿った筋肉（脊柱起立筋）',
  lats: '背中の上部・脇（広背筋など）',
  biceps: '腕の前（上腕二頭筋）',
}

export interface SportProfile {
  kind: MotionKind
  label: string
  /** 1 回の数え方（「回」「本」「回転」） */
  unitLabel: string
  /** グラフに点を打ち、「n 回目の〜」で移る出来事 */
  mainEvent: string
  jumpLabel: (n: number) => string
  series: SeriesDef[]
  defaultSeries: string
  metrics: MetricDef[]
  /** 計算に使えるコマか（推定が乱れて骨格が逆さになったコマなどを除く） */
  valid: (p: Point[], s: Side) => boolean
  /** 点をなめらかにする強さ（ガウスの σ、コマ数）。速い動きほど弱くする */
  smoothing: number
  findCycles: (prep: PreparedMotion) => { cycles: MotionCycle[]; warnings: string[] }
  /** 真横の確認に使うコマ（立っているコマなど） */
  sideCheckFrames: (prep: PreparedMotion) => number[]
  /** 隠れていないかを確かめる、カメラ側の点 */
  keyPoints: (s: Side) => [number, string][]
  /** 隠れていたときの撮り方の案内 */
  hiddenHint: string
  /** 撮る前の案内 */
  guide: string[]
  /** 撮るときのスマホの向きのおすすめ */
  orientation: 'portrait' | 'landscape'
  /** 一般に主に使われる筋肉（教育用の例） */
  muscles: MuscleKey[]
}

// ---------- 角度 ----------

const flex = (a: Point, b: Point, c: Point) => 180 - interiorAngleDeg(a, b, c)
const elbowOf = (s: Side) => s.wrist - 2

const KNEE: SeriesDef = {
  key: 'knee',
  label: '膝の曲がり',
  short: '膝',
  unit: '°',
  digits: 0,
  doc: '股関節・膝・足首の点を結ぶ線の角度です。脚がまっすぐなとき 0° で、曲げるほど大きくなります。横から見た見かけの角度で、骨の角度ではありません。',
  value: (p, c) => flex(p[c.s.hip], p[c.s.knee], p[c.s.ankle]),
}
const HIP: SeriesDef = {
  key: 'hip',
  label: '股関節の曲がり',
  short: '股関節',
  unit: '°',
  digits: 0,
  doc: '肩・股関節・膝の点を結ぶ線の角度です。上体と太ももが一直線のとき 0° で、曲げるほど大きくなります。骨盤そのものの傾きや、背骨の曲がりは分けて測れません。',
  value: (p, c) => flex(p[c.s.shoulder], p[c.s.hip], p[c.s.knee]),
}
const TRUNK: SeriesDef = {
  key: 'trunk',
  label: '上体の前傾',
  short: '上体',
  unit: '°',
  digits: 0,
  doc: '股関節の点から肩の点への線が、鉛直からどれだけ前に傾いたかです（後ろに傾くと −）。背中の丸みは含みません。',
  value: (p, c) => angleFromVerticalDeg(p[c.s.hip], p[c.s.shoulder], c.f),
}
const SHIN: SeriesDef = {
  key: 'shin',
  label: 'すねの前傾',
  short: 'すね',
  unit: '°',
  digits: 0,
  doc: '足首の点から膝の点への線が、鉛直からどれだけ前に傾いたかです。足首がどれだけ曲がったかの目安になります。',
  value: (p, c) => angleFromVerticalDeg(p[c.s.ankle], p[c.s.knee], c.f),
}
const ELBOW: SeriesDef = {
  key: 'elbow',
  label: 'ひじの曲がり',
  short: 'ひじ',
  unit: '°',
  digits: 0,
  doc: '肩・ひじ・手首の点を結ぶ線の角度です。腕がまっすぐなとき 0° で、曲げるほど大きくなります。',
  value: (p, c) => flex(p[c.s.shoulder], p[elbowOf(c.s)], p[c.s.wrist]),
}
const ANKLE: SeriesDef = {
  key: 'ankle',
  label: '足首の角度',
  short: '足首',
  unit: '°',
  digits: 0,
  doc: '膝・足首・足先の点を結ぶ線の角度（すねと足の甲の間）です。つま先を下げるほど大きくなります。靴を履いていると、足先の点は靴の先になります。',
  value: (p, c) => interiorAngleDeg(p[c.s.knee], p[c.s.ankle], p[c.s.foot]),
}

// ---------- 区間の中の値 ----------

const maxIn = (v: number[], a: number, b: number) => {
  let m = -Infinity
  for (let i = a; i <= b; i++) m = Math.max(m, v[i])
  return m
}
const minIn = (v: number[], a: number, b: number) => {
  let m = Infinity
  for (let i = a; i <= b; i++) m = Math.min(m, v[i])
  return m
}
const meanIn = (v: number[], a: number, b: number) => {
  let s = 0
  for (let i = a; i <= b; i++) s += v[i]
  return s / (b - a + 1)
}
const argMax = (v: number[], a: number, b: number) => {
  let k = a
  for (let i = a; i <= b; i++) if (v[i] > v[k]) k = i
  return k
}
const argMin = (v: number[], a: number, b: number) => {
  let k = a
  for (let i = a; i <= b; i++) if (v[i] < v[k]) k = i
  return k
}
export const eventOf = (c: MotionCycle, key: string) => c.events.find((e) => e.key === key)
const at = (prep: PreparedMotion, key: string, i: number | undefined) => (i === undefined ? null : prep.series[key][i])
const seconds = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? null : (b - a) / 1000)

/** 区間 [a, b] の中で、値が from から to へ半分まで動いた時刻の、区間の長さに対する割合（%） */
function halfway(prep: PreparedMotion, key: string, a: number, b: number) {
  const v = prep.series[key]
  const from = v[a]
  const to = v[b]
  const mid = (from + to) / 2
  const up = to > from
  for (let i = a; i <= b; i++) {
    if (up ? v[i] >= mid : v[i] <= mid) {
      const t0 = prep.frames[a].t
      const t1 = prep.frames[b].t
      return t1 > t0 ? ((prep.frames[i].t - t0) / (t1 - t0)) * 100 : null
    }
  }
  return null
}

const hipWidthFrames = (prep: PreparedMotion) => prep.frames.map((_, i) => i)

// ---------- スクワット ----------

/** 1 回と数える深さ（%）。ここまで下がった動きを 1 回とする */
export const REP_MIN_DEPTH = 15
/** 1 回が終わったとみなす深さ（%）。ここより浅く戻ったら区切る */
export const REP_RETURN_DEPTH = 8
/** 動き始め・立ち上がり終わりとみなす、いちばん浅いところからの深さ（%） */
const ONSET_DEPTH = 3

const DEPTH: SeriesDef = {
  key: 'depth',
  label: 'しゃがむ深さ',
  short: '深さ',
  unit: '%',
  digits: 0,
  doc: '腰（股関節の点）がどれだけ下がったかを、立っているときの股関節から足首までの高さに対する割合で表した値です。0% が立った姿勢です。',
  value: (p, c) => ((c.standLeg - (p[c.s.ankle].y - p[c.s.hip].y)) / c.standLeg) * 100,
}

function squatCycles(prep: PreparedMotion): { cycles: MotionCycle[]; warnings: string[] } {
  const d = prep.series.depth
  const n = d.length
  const segOf = segmentsOf(n, prep.breaks)
  // 深く入った区間を探す
  const exc: { from: number; to: number; open: boolean; leftOk: boolean }[] = []
  let inside = false
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
        exc.push({ from: i, to: i, open: false, leftOk: lastShallow >= 0 })
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

  const cycles: MotionCycle[] = []
  let cutStart = false
  let cutEnd = false
  exc.forEach((e, k) => {
    if (!e.leftOk) return void (cutStart = true)
    if (e.open) return void (cutEnd = true)
    const bottom = argMax(d, e.from, e.to)
    // 前後のいちばん浅いところ（同じ区間の中、前後の回の深いところまで）
    const prevTo = k > 0 && segOf[exc[k - 1].to] === segOf[bottom] ? exc[k - 1].to : segOf.indexOf(segOf[bottom])
    const nextFrom = k + 1 < exc.length && segOf[exc[k + 1].from] === segOf[bottom] ? exc[k + 1].from : segOf.lastIndexOf(segOf[bottom])
    const lo = argMin(d, prevTo, bottom)
    const hi = argMin(d, bottom, nextFrom)
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
    cycles.push({
      startIndex: start,
      endIndex: end,
      start: prep.frames[start].t,
      end: prep.frames[end].t,
      events: [{ key: 'bottom', label: 'いちばん深いところ', index: bottom, t: prep.frames[bottom].t }],
    })
  })
  const warnings: string[] = []
  if (!cycles.length && !cutStart && !cutEnd) {
    warnings.push(`しゃがむ動きを見つけられませんでした。腰が、立っているときの股関節から足首までの高さの ${REP_MIN_DEPTH}% 以上下がって、立ち上がるまでを 1 回と数えます。`)
  }
  if (cutStart) warnings.push('撮り始めにしゃがんでいた 1 回は、動き始めが写っていないため数えていません。')
  if (cutEnd) warnings.push('撮り終わりの 1 回は、立ち上がるところまで写っていないため数えていません。')
  if (!cycles.length && (cutStart || cutEnd)) warnings.push('数えられる回がありませんでした。立った姿勢から撮り始め、最後は立ち上がってから止めてください。')
  return { cycles, warnings }
}

const cycleMax =
  (key: string): MetricDef['value'] =>
  (c, prep) =>
    maxIn(prep.series[key], c.startIndex, c.endIndex)

const SQUAT: SportProfile = {
  kind: 'squat',
  label: 'スクワット',
  unitLabel: '回',
  mainEvent: 'bottom',
  jumpLabel: (n) => `${n} 回目の底`,
  series: [DEPTH, KNEE, HIP, TRUNK, SHIN],
  defaultSeries: 'knee',
  metrics: [
    { key: 'depth', label: 'いちばん深いところ', short: '深さ', unit: '%', digits: 0, doc: DEPTH.doc, floor: 2, value: cycleMax('depth') },
    { key: 'knee', label: '膝の曲がり（最大）', short: '膝', unit: '°', digits: 0, doc: KNEE.doc, floor: 2, value: cycleMax('knee') },
    { key: 'hip', label: '股関節の曲がり（最大）', short: '股関節', unit: '°', digits: 0, doc: HIP.doc, floor: 2, value: cycleMax('hip') },
    { key: 'trunk', label: '上体の前傾（最大）', short: '上体', unit: '°', digits: 0, doc: TRUNK.doc, floor: 2, value: cycleMax('trunk') },
    { key: 'shin', label: 'すねの前傾（最大）', short: 'すね', unit: '°', digits: 0, doc: SHIN.doc, floor: 2, value: cycleMax('shin') },
    {
      key: 'descent',
      label: 'しゃがむ時間',
      short: 'しゃがむ',
      unit: '秒',
      digits: 1,
      doc: '動き始めてから、いちばん深いところまでの時間です。',
      floor: 0.1,
      value: (c) => seconds(c.start, eventOf(c, 'bottom')?.t),
    },
    {
      key: 'ascent',
      label: '立ち上がる時間',
      short: '立つ',
      unit: '秒',
      digits: 1,
      doc: 'いちばん深いところから、立ち上がり終わるまでの時間です。',
      floor: 0.1,
      value: (c) => seconds(eventOf(c, 'bottom')?.t, c.end),
    },
  ],
  valid: (p, s) => p[s.shoulder].y < p[s.hip].y && p[s.knee].y < p[s.ankle].y,
  smoothing: 1.5,
  findCycles: squatCycles,
  sideCheckFrames: (prep) => prep.frames.map((_, i) => i).filter((i) => prep.series.depth[i] < REP_RETURN_DEPTH),
  keyPoints: (s) => [
    [s.hip, '股関節'],
    [s.knee, '膝'],
    [s.ankle, '足首'],
  ],
  hiddenHint: 'ラックの柱や器具が脚にかからない位置から、体の真横で撮ると確かになります。',
  guide: [
    'スマホを縦向きにして、腰の高さに置きます。体の真横から 2.5〜3 m 離れます（しゃがんだときも、頭から足まで入る距離）。',
    '体の線が分かる服にします。腕は前に伸ばすか、胸の前で組みます（体の横に下ろすと、股関節が隠れます）。バーベルを担ぐときは、そのままで大丈夫です。',
    'ラックの中で行うときは、柱や器具が脚や腰にかからない位置から、体の真横で撮ります。後ろの鏡に映った姿が大きく写らない向きがおすすめです。',
    '合図のあと、横向きのまま、いつもの速さで 3〜5 回しゃがんで立ちます。終わったら「撮り終える」を押します。',
  ],
  orientation: 'portrait',
  muscles: ['quads', 'glutes', 'hamstrings', 'erectors'],
}

// ---------- ローイングエルゴ ----------

const HANDLE: SeriesDef = {
  key: 'handle',
  label: '手の位置（足首から後ろへ）',
  short: '手',
  unit: '%',
  digits: 0,
  doc: '手首の点が、足首の点からどれだけ後ろにあるかを、脚の長さ（股関節〜膝〜足首）に対する割合で表した値です。ハンドルの位置の目安で、いちばん小さいところをキャッチ、いちばん大きいところをフィニッシュとします。',
  value: (p, c) => ((c.f * (p[c.s.ankle].x - p[c.s.wrist].x)) / c.leg) * 100,
}
const SEAT: SeriesDef = {
  key: 'seat',
  label: '腰の位置（足首から後ろへ）',
  short: '腰',
  unit: '%',
  digits: 0,
  doc: '股関節の点が、足首の点からどれだけ後ろにあるかを、脚の長さに対する割合で表した値です。シートの位置の目安です。',
  value: (p, c) => ((c.f * (p[c.s.ankle].x - p[c.s.hip].x)) / c.leg) * 100,
}

/** キャッチ（手がいちばん前）を探すときの、山の高さの最小（脚の長さの %）と、ストロークの長さとして受け付ける範囲（ミリ秒） */
const ERG_PROMINENCE = 15
const ERG_PERIOD: [number, number] = [1200, 6000]

function ergCycles(prep: PreparedMotion): { cycles: MotionCycle[]; warnings: string[] } {
  const h = prep.series.handle
  const ts = prep.frames.map((f) => f.t)
  const segOf = segmentsOf(h.length, prep.breaks)
  const catches = findPeaks(
    h.map((v) => -v),
    ts,
    segOf,
    ERG_PROMINENCE,
    ERG_PERIOD[0] * 0.8,
  )
  const cycles: MotionCycle[] = []
  for (let k = 0; k + 1 < catches.length; k++) {
    const a = catches[k]
    const b = catches[k + 1]
    if (segOf[a] !== segOf[b]) continue
    const dt = ts[b] - ts[a]
    if (dt < ERG_PERIOD[0] || dt > ERG_PERIOD[1]) continue
    const fin = argMax(h, a, b)
    cycles.push({
      startIndex: a,
      endIndex: b,
      start: ts[a],
      end: ts[b],
      events: [
        { key: 'catch', label: 'キャッチ', index: a, t: ts[a] },
        { key: 'finish', label: 'フィニッシュ', index: fin, t: ts[fin] },
      ],
    })
  }
  const warnings: string[] = []
  if (!cycles.length) {
    warnings.push('ストロークを見つけられませんでした。キャッチ（手がいちばん前）から次のキャッチまでを 1 本と数えます。体の真横から、2 本以上写るように撮ってください。')
  }
  return { cycles, warnings }
}

const atEvent =
  (series: string, ev: string): MetricDef['value'] =>
  (c, prep) =>
    at(prep, series, eventOf(c, ev)?.index)

const ERG: SportProfile = {
  kind: 'erg',
  label: 'ローイングエルゴ',
  unitLabel: '本',
  mainEvent: 'catch',
  jumpLabel: (n) => `${n} 本目のキャッチ`,
  series: [KNEE, HIP, TRUNK, ELBOW, HANDLE, SEAT],
  defaultSeries: 'trunk',
  metrics: [
    {
      key: 'rate',
      label: 'ストロークレート',
      short: 'レート',
      unit: '回/分',
      digits: 1,
      doc: 'キャッチから次のキャッチまでの時間から求めた、1 分あたりのストローク数です。',
      floor: 0.5,
      value: (c) => (c.end > c.start ? 60000 / (c.end - c.start) : null),
    },
    {
      key: 'drive',
      label: 'ドライブの時間',
      short: 'ドライブ',
      unit: '秒',
      digits: 2,
      doc: 'キャッチ（手がいちばん前）からフィニッシュ（手がいちばん後ろ）までの時間です。',
      floor: 0.05,
      value: (c) => seconds(c.start, eventOf(c, 'finish')?.t),
    },
    {
      key: 'recovery',
      label: 'リカバリーの時間',
      short: 'リカバリー',
      unit: '秒',
      digits: 2,
      doc: 'フィニッシュから次のキャッチまでの時間です。',
      floor: 0.05,
      value: (c) => seconds(eventOf(c, 'finish')?.t, c.end),
    },
    {
      key: 'ratio',
      label: 'リカバリー ÷ ドライブ',
      short: '比',
      unit: '倍',
      digits: 1,
      doc: 'リカバリーの時間がドライブの時間の何倍かです。',
      floor: 0.1,
      value: (c) => {
        const fin = eventOf(c, 'finish')?.t
        if (fin === undefined || fin <= c.start) return null
        return (c.end - fin) / (fin - c.start)
      },
    },
    { key: 'knee_catch', label: '膝の曲がり（キャッチ）', short: '膝', unit: '°', digits: 0, doc: KNEE.doc, floor: 2, value: atEvent('knee', 'catch') },
    { key: 'hip_catch', label: '股関節の曲がり（キャッチ）', short: '股関節', unit: '°', digits: 0, doc: HIP.doc, floor: 2, value: atEvent('hip', 'catch') },
    { key: 'trunk_catch', label: '上体の前傾（キャッチ）', short: '上体前', unit: '°', digits: 0, doc: TRUNK.doc, floor: 2, value: atEvent('trunk', 'catch') },
    {
      key: 'trunk_finish',
      label: '上体の傾き（フィニッシュ。後ろが −）',
      short: '上体後',
      unit: '°',
      digits: 0,
      doc: TRUNK.doc,
      floor: 2,
      value: atEvent('trunk', 'finish'),
    },
    { key: 'elbow_finish', label: 'ひじの曲がり（フィニッシュ）', short: 'ひじ', unit: '°', digits: 0, doc: ELBOW.doc, floor: 2, value: atEvent('elbow', 'finish') },
    {
      key: 'length',
      label: '手の動いた幅（脚の長さ比）',
      short: '幅',
      unit: '%',
      digits: 0,
      doc: 'キャッチからフィニッシュまでに手首の点が前後に動いた距離を、脚の長さに対する割合で表した値です。ストロークの長さの目安です。',
      floor: 2,
      value: (c, prep) => {
        const fin = eventOf(c, 'finish')?.index
        return fin === undefined ? null : prep.series.handle[fin] - prep.series.handle[c.startIndex]
      },
    },
    {
      key: 'leg_half',
      label: '脚が半分伸びた時刻（ドライブの %）',
      short: '脚半分',
      unit: '%',
      digits: 0,
      doc: 'キャッチからフィニッシュまでのうち、膝の曲がりが半分戻った時刻です（ドライブの始めが 0%、終わりが 100%）。脚・上体・腕が動く順番の目安です。',
      floor: 3,
      value: (c, prep) => {
        const fin = eventOf(c, 'finish')?.index
        return fin === undefined ? null : halfway(prep, 'knee', c.startIndex, fin)
      },
    },
    {
      key: 'trunk_half',
      label: '上体が半分開いた時刻（ドライブの %）',
      short: '上体半分',
      unit: '%',
      digits: 0,
      doc: 'キャッチからフィニッシュまでのうち、上体の傾きがキャッチとフィニッシュの中間まで動いた時刻です。',
      floor: 3,
      value: (c, prep) => {
        const fin = eventOf(c, 'finish')?.index
        return fin === undefined ? null : halfway(prep, 'trunk', c.startIndex, fin)
      },
    },
    {
      key: 'arm_half',
      label: '腕が半分引けた時刻（ドライブの %）',
      short: '腕半分',
      unit: '%',
      digits: 0,
      doc: 'キャッチからフィニッシュまでのうち、ひじの曲がりが半分まで進んだ時刻です。',
      floor: 3,
      value: (c, prep) => {
        const fin = eventOf(c, 'finish')?.index
        return fin === undefined ? null : halfway(prep, 'elbow', c.startIndex, fin)
      },
    },
  ],
  valid: (p, s) => p[s.shoulder].y < p[s.hip].y,
  // キャッチで動きが折り返すので、スクワットより弱くする
  smoothing: 1.0,
  findCycles: ergCycles,
  sideCheckFrames: hipWidthFrames,
  keyPoints: (s) => [
    [s.hip, '股関節'],
    [s.knee, '膝'],
    [s.ankle, '足首'],
    [s.wrist - 2, 'ひじ'],
    [s.wrist, '手首'],
  ],
  hiddenHint: 'エルゴの本体・モニター・手すりが体にかからない位置から、体の真横で撮ると確かになります。',
  guide: [
    'スマホを横向きにして、シートの高さ〜腰の高さに置きます。エルゴの真横から 2.5〜3 m 離れます（キャッチからフィニッシュまで、頭から足まで入る距離）。',
    'モニターのアームや手すりが、体（特に脚と腕）にかからない側から撮ります。',
    '体の線が分かる服にします。合図のあと、いつものレートで 5 本以上漕ぎます。終わったら「撮り終える」を押します。',
  ],
  orientation: 'landscape',
  muscles: ['quads', 'glutes', 'hamstrings', 'erectors', 'lats', 'biceps'],
}

// ---------- 固定式の自転車 ----------

/** 下死点（膝がいちばん伸びたところ）を探すときの、谷の深さの最小（度）と、1 回転の長さとして受け付ける範囲（ミリ秒） */
const BIKE_PROMINENCE = 15
const BIKE_PERIOD: [number, number] = [300, 3000]

function bikeCycles(prep: PreparedMotion): { cycles: MotionCycle[]; warnings: string[] } {
  const k = prep.series.knee
  const ts = prep.frames.map((f) => f.t)
  const segOf = segmentsOf(k.length, prep.breaks)
  const bdc = findPeaks(
    k.map((v) => -v),
    ts,
    segOf,
    BIKE_PROMINENCE,
    BIKE_PERIOD[0] * 0.8,
  )
  const cycles: MotionCycle[] = []
  for (let j = 0; j + 1 < bdc.length; j++) {
    const a = bdc[j]
    const b = bdc[j + 1]
    if (segOf[a] !== segOf[b]) continue
    const dt = ts[b] - ts[a]
    if (dt < BIKE_PERIOD[0] || dt > BIKE_PERIOD[1]) continue
    const top = argMax(k, a, b)
    cycles.push({
      startIndex: a,
      endIndex: b,
      start: ts[a],
      end: ts[b],
      events: [
        { key: 'bdc', label: '下死点（膝がいちばん伸びたところ）', index: a, t: ts[a] },
        { key: 'tdc', label: '上死点（膝がいちばん曲がったところ）', index: top, t: ts[top] },
      ],
    })
  }
  const warnings: string[] = []
  if (!cycles.length) {
    warnings.push('ペダルの回転を見つけられませんでした。膝がいちばん伸びたところ（下死点）から次の下死点までを 1 回転と数えます。体の真横から、2 回転以上写るように撮ってください。')
  }
  return { cycles, warnings }
}

const BIKE: SportProfile = {
  kind: 'bike',
  label: '固定式の自転車',
  unitLabel: '回転',
  mainEvent: 'bdc',
  jumpLabel: (n) => `${n} 回転目の下死点`,
  series: [KNEE, HIP, ANKLE, TRUNK],
  defaultSeries: 'knee',
  metrics: [
    {
      key: 'cadence',
      label: 'ケイデンス',
      short: '回転数',
      unit: '回/分',
      digits: 0,
      doc: '下死点から次の下死点までの時間から求めた、1 分あたりのペダルの回転数です。',
      floor: 1,
      value: (c) => (c.end > c.start ? 60000 / (c.end - c.start) : null),
    },
    { key: 'knee_bdc', label: '膝の曲がり（下死点）', short: '膝下', unit: '°', digits: 0, doc: KNEE.doc, floor: 2, value: atEvent('knee', 'bdc') },
    { key: 'knee_tdc', label: '膝の曲がり（上死点）', short: '膝上', unit: '°', digits: 0, doc: KNEE.doc, floor: 2, value: atEvent('knee', 'tdc') },
    {
      key: 'hip_open',
      label: '股関節の曲がり（いちばん開いたとき）',
      short: '股開',
      unit: '°',
      digits: 0,
      doc: HIP.doc,
      floor: 2,
      value: (c, prep) => minIn(prep.series.hip, c.startIndex, c.endIndex),
    },
    {
      key: 'hip_closed',
      label: '股関節の曲がり（いちばん閉じたとき）',
      short: '股閉',
      unit: '°',
      digits: 0,
      doc: HIP.doc,
      floor: 2,
      value: (c, prep) => maxIn(prep.series.hip, c.startIndex, c.endIndex),
    },
    { key: 'ankle_bdc', label: '足首の角度（下死点）', short: '足首', unit: '°', digits: 0, doc: ANKLE.doc, floor: 2, value: atEvent('ankle', 'bdc') },
    {
      key: 'ankle_range',
      label: '足首の角度の動いた幅',
      short: '足首幅',
      unit: '°',
      digits: 0,
      doc: '1 回転の中で、足首の角度がいちばん大きいときと小さいときの差です。',
      floor: 2,
      value: (c, prep) => maxIn(prep.series.ankle, c.startIndex, c.endIndex) - minIn(prep.series.ankle, c.startIndex, c.endIndex),
    },
    {
      key: 'trunk',
      label: '上体の前傾（平均）',
      short: '上体',
      unit: '°',
      digits: 0,
      doc: TRUNK.doc,
      floor: 2,
      value: (c, prep) => meanIn(prep.series.trunk, c.startIndex, c.endIndex),
    },
  ],
  valid: (p, s) => p[s.shoulder].y < p[s.hip].y && p[s.knee].y < p[s.ankle].y,
  // 90 回転/分では 1 回転が 20 コマしかない。σ = 1.5 だと膝の角度の山と谷が 1 割ほど削られるので、弱くする
  smoothing: 0.7,
  findCycles: bikeCycles,
  sideCheckFrames: hipWidthFrames,
  keyPoints: (s) => [
    [s.hip, '股関節'],
    [s.knee, '膝'],
    [s.ankle, '足首'],
    [s.foot, '足先'],
  ],
  hiddenHint: '自転車のフレームやハンドルが脚にかからない側から、体の真横で撮ると確かになります。',
  guide: [
    'スマホを横向きにして、サドルの高さに置きます。自転車の真横から 2〜3 m 離れます（ペダルが下にあるときも、頭から足まで入る距離）。',
    'カメラ側の脚が、フレームやハンドルで隠れないようにします。体の線が分かる服にします。',
    '合図のあと、いつもの回転数で 10 回転以上こぎます。終わったら「撮り終える」を押します。',
  ],
  orientation: 'landscape',
  muscles: ['quads', 'glutes', 'hamstrings', 'calves'],
}

export const PROFILES: Record<MotionKind, SportProfile> = { squat: SQUAT, erg: ERG, bike: BIKE }
export const MOTION_KIND_LIST: MotionKind[] = ['squat', 'erg', 'bike']
