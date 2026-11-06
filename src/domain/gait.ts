// 横から撮った歩く動画（コマごとの体の点）から、歩き方の数値を求める（docs/05 の 7 章）。
// 正常範囲とは比べない。値は自分の過去の記録と比べるためのもの
import type { Landmark, Point } from './types'
import { MIN_VISIBILITY, NOTICEABLE_K } from './constants'
import { RAD2DEG, dist, mean } from './geometry'

export const GAIT_ALGORITHM_VERSION = 1

export interface GaitFrame {
  /** 撮影の開始からの時刻（ミリ秒） */
  t: number
  /** 33 点（画像の幅・高さに対する 0..1） */
  lm: Landmark[]
}

export interface GaitInput {
  /** 人を検出できたコマ（時刻の順） */
  frames: GaitFrame[]
  width: number
  height: number
  /** 映像の傾き（度。端末の右側が下がると +）。分かれば戻してから測る */
  rollDeg?: number
  /** 撮影した全コマの 1 秒あたりの数（分からなければ検出できたコマの間隔から求める） */
  fps?: number
}

export type GaitMetricKey = 'cadence' | 'step_length' | 'trunk_lean' | 'head_forward' | 'arm_swing'

export interface GaitMetric {
  key: GaitMetricKey
  value: number | null
  /** 1σ の目安。1 回の撮影の中の、歩ごとの揺れから求める（日をまたいだ揺れは含まない） */
  uncertainty: number | null
  /** 計算に使った歩数 */
  steps: number
  status: 'ok' | 'unavailable'
  note?: string
}

export interface GaitPass {
  /** 通過の初めと終わりの時刻（ミリ秒） */
  start: number
  end: number
  /** 画像の右へ歩いたら 1、左へなら -1 */
  dir: 1 | -1
  /** 足が前後に最も開いた時刻（片足が着地したころ） */
  strikes: number[]
  /** 通過の終わりの体の大きさ / 初めの大きさ - 1（カメラに近づくと +） */
  scaleChange: number
  /** 使わなかった理由 */
  excluded?: string
}

export interface GaitAnalysis {
  algorithmVersion: number
  passes: GaitPass[]
  metrics: GaitMetric[]
  warnings: string[]
  /** 1 秒あたりのコマ数 */
  fps: number
  /** 全身が写っていたコマの数 */
  validFrames: number
  /** 傾きを戻した角度（度） */
  rollCorrectedDeg?: number
}

export const GAIT_METRIC_KEYS: GaitMetricKey[] = ['cadence', 'step_length', 'trunk_lean', 'head_forward', 'arm_swing']

export const GAIT_LABELS: Record<GaitMetricKey, { label: string; unit: string; digits: number; doc: string }> = {
  cadence: {
    label: '歩くテンポ',
    unit: '歩/分',
    digits: 0,
    doc: '1 分あたりの歩数です。足首どうしが前後に最も開いた瞬間（片足が着地したころ）の間隔から求めます。',
  },
  step_length: {
    label: '歩幅（脚の長さ比）',
    unit: '%',
    digits: 0,
    doc: '足首どうしが前後に最も開いたときの距離を、股関節から足首までの長さで割った値です。かかとからかかとまでの一般的な歩幅とは少し違います。',
  },
  trunk_lean: {
    label: '歩くときの上体の傾き',
    unit: '°',
    digits: 1,
    doc: '股関節の中点から肩の中点へ向かう線が、鉛直から進む向きにどれだけ傾いているかです（前が +）。1 歩ごとに平均します。肩が前に出ていると大きめに出ます。',
  },
  head_forward: {
    label: '歩くときの頭の位置',
    unit: '°',
    digits: 1,
    doc: '肩の中点から耳の中点へ向かう線が、鉛直から進む向きにどれだけ傾いているかです（前が +）。立ち姿の「頭部前方位の参考指標」と同じ考え方で、1 歩ごとに平均します。',
  },
  arm_swing: {
    label: '腕の振りの幅',
    unit: '°',
    digits: 0,
    doc: '肩の中点から手首へ向かう線が、前と後ろに最も振れたときの角度の差です。1 歩ごとに測って平均します。',
  },
}

/** 測れる最小の差の目安（歩ごとの揺れがこれより小さく出ても、これを下回らない） */
const FLOOR: Record<GaitMetricKey, number> = { cadence: 0.5, step_length: 1, trunk_lean: 0.5, head_forward: 0.5, arm_swing: 1 }
/** 1 つの値に必要な最小の歩数 */
const MIN_STEPS = 3
/** 足の前後の開きの山とみなす、両側の谷との差（脚の長さ比） */
const PEAK_PROMINENCE = 0.15
/** 山の両側で谷を探す幅（ミリ秒）。より高い点に当たったら、そこで探すのをやめる */
const PEAK_WINDOW_MS = 350
/** これより短い途切れ（推定が一瞬乱れたコマ）では、通過を区切らない */
const MAX_GAP_MS = 300
/** 1 歩の長さとして受け付ける範囲（ミリ秒） */
const STEP_MS = { min: 250, max: 1500 }
/** 通過の初めと終わりで体の大きさがこれ以上変わったら注意 / 使わない */
const SCALE_WARN = 0.15
const SCALE_EXCLUDE = 0.3

/** 全身が写っているかを見る点（左右の対） */
const REQUIRED_PAIRS: [number, number][] = [
  [7, 8],
  [11, 12],
  [23, 24],
  [25, 26],
  [27, 28],
  [29, 30],
]

const vis = (l: Landmark | undefined) => (l ? Math.min(l.visibility ?? 1, l.presence ?? 1) : 0)
const inFrame = (l: Landmark) => l.x >= 0.005 && l.x <= 0.995 && l.y >= 0.005 && l.y <= 0.995

/** 全身が画面の中に写っているコマか */
export function fullBodyInFrame(lm: Landmark[]): boolean {
  if (lm.length < 33) return false
  return REQUIRED_PAIRS.every(([a, b]) => inFrame(lm[a]) && inFrame(lm[b]) && Math.max(vis(lm[a]), vis(lm[b])) >= MIN_VISIBILITY)
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

const midP = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

function quantile(values: number[], q: number) {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

function median(values: number[]) {
  return quantile(values, 0.5)
}

/** [1, 2, 1] / 4 のなめらか化（端はそのまま） */
function smooth3(v: number[]) {
  return v.map((x, i) => (i === 0 || i === v.length - 1 ? x : (v[i - 1] + 2 * x + v[i + 1]) / 4))
}

/** 最小二乗の直線 y = a + b t */
function lineFit(ts: number[], ys: number[]) {
  const n = ts.length
  const mt = mean(ts)
  const my = mean(ys)
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (ts[i] - mt) ** 2
    sxy += (ts[i] - mt) * (ys[i] - my)
  }
  const b = sxx > 0 ? sxy / sxx : 0
  return { a: my - b * mt, b }
}

interface Prepared {
  t: number
  p: Point[]
  /** 各点の見えている度合い */
  v: number[]
}

/**
 * 体が立っている形か（耳 → 肩 → 股関節 → 足首の順に下へ並び、胴が鉛直から 45° 以内）。
 * 推定が 1 コマだけ乱れて、骨格が逆さや横倒しになったコマを除く
 */
function upright(p: Point[]) {
  const E = midP(p[7], p[8])
  const S = midP(p[11], p[12])
  const P = midP(p[23], p[24])
  const A = midP(p[27], p[28])
  if (!(E.y < S.y && S.y < P.y && P.y < A.y)) return false
  return Math.abs(Math.atan2(S.x - P.x, -(S.y - P.y)) * RAD2DEG) < 45
}

/** 1 回の通過（画面を横切った区間）の、計算の途中の値 */
export interface PassData {
  pass: GaitPass
  frames: Prepared[]
  /** 各コマの脚の長さ（ピクセル、傾向線） */
  leg: number[]
  /** 足首の前後の開き（脚の長さ比、なめらか化したもの） */
  sep: number[]
  /** 山の時刻での開き */
  strikeSep: number[]
}

function legLength(p: Point[]) {
  return Math.max(dist(p[23], p[27]), dist(p[24], p[28]))
}

/** 区間を、歩く向きがそろった部分に分ける */
function splitByDirection(run: Prepared[]): Prepared[][] {
  const hx = smooth3(run.map((f) => midP(f.p[23], f.p[24]).x))
  const legs = run.map((f) => legLength(f.p))
  const leg = quantile(legs, 0.9)
  const minSpeed = 0.3 * leg // 脚の長さ / 秒
  const sgn: number[] = run.map((f, i) => {
    let j0 = i
    let j1 = i
    while (j0 > 0 && f.t - run[j0 - 1].t <= 250) j0--
    while (j1 < run.length - 1 && run[j1 + 1].t - f.t <= 250) j1++
    const dt = (run[j1].t - run[j0].t) / 1000
    if (dt <= 0) return 0
    const v = (hx[j1] - hx[j0]) / dt
    return Math.abs(v) < minSpeed ? 0 : Math.sign(v)
  })
  const out: Prepared[][] = []
  let cur: Prepared[] = []
  let curSign = 0
  run.forEach((f, i) => {
    const s = sgn[i]
    if (s === 0 || (curSign !== 0 && s !== curSign)) {
      if (cur.length) out.push(cur)
      cur = s === 0 ? [] : [f]
      curSign = s
      return
    }
    curSign = s
    cur.push(f)
  })
  if (cur.length) out.push(cur)
  return out
}

/** 足首の前後の開きの山（片足が着地したころ）。時刻と、山の高さ（放物線で補間） */
function findStrikes(ts: number[], sep: number[]) {
  const out: { t: number; v: number }[] = []
  const n = sep.length
  for (let i = 1; i < n - 1; i++) {
    if (!(sep[i] >= sep[i - 1] && sep[i] > sep[i + 1])) continue
    // 両側の谷の深さ（隣の歩の山の方が高くても、その手前の谷までで測る）
    let leftMin = sep[i]
    let rightMin = sep[i]
    let leftSpan = 0
    let rightSpan = 0
    for (let j = i - 1; j >= 0 && ts[i] - ts[j] <= PEAK_WINDOW_MS && sep[j] <= sep[i]; j--) {
      leftMin = Math.min(leftMin, sep[j])
      leftSpan = ts[i] - ts[j]
    }
    for (let j = i + 1; j < n && ts[j] - ts[i] <= PEAK_WINDOW_MS && sep[j] <= sep[i]; j++) {
      rightMin = Math.min(rightMin, sep[j])
      rightSpan = ts[j] - ts[i]
    }
    if (leftSpan === 0 || rightSpan === 0) continue
    if (sep[i] - leftMin < PEAK_PROMINENCE || sep[i] - rightMin < PEAK_PROMINENCE) continue
    // 3 点の放物線で山の位置と高さを補間する
    const y0 = sep[i - 1]
    const y1 = sep[i]
    const y2 = sep[i + 1]
    const den = y0 - 2 * y1 + y2
    let d = den < 0 ? (0.5 * (y0 - y2)) / den : 0
    d = Math.max(-0.5, Math.min(0.5, d))
    const dt = d < 0 ? ts[i] - ts[i - 1] : ts[i + 1] - ts[i]
    out.push({ t: ts[i] + d * dt, v: y1 - 0.25 * (y0 - y2) * d })
  }
  // 近すぎる山は高い方を残す
  const kept: { t: number; v: number }[] = []
  for (const s of out) {
    const last = kept[kept.length - 1]
    if (last && s.t - last.t < STEP_MS.min) {
      if (s.v > last.v) kept[kept.length - 1] = s
    } else kept.push(s)
  }
  return kept
}

/** 検出できたコマを、通過ごとに分けて途中の値を求める */
export function preparePasses(input: GaitInput): { passes: PassData[]; fps: number; validFrames: number } {
  const frames = [...input.frames].sort((a, b) => a.t - b.t)
  const gaps: number[] = []
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t)
  const dt = input.fps ? 1000 / input.fps : gaps.length ? median(gaps) : 33
  const fps = 1000 / dt
  const valid: Prepared[] = frames
    .filter((f) => fullBodyInFrame(f.lm))
    .map((f) => ({ t: f.t, p: uprightPx(f.lm, input.width, input.height, input.rollDeg ?? 0), v: f.lm.map(vis) }))
    .filter((f) => upright(f.p))

  // 途切れたところで区切る
  const maxGap = Math.max(3.5 * dt, MAX_GAP_MS)
  const runs: Prepared[][] = []
  for (const f of valid) {
    const run = runs[runs.length - 1]
    if (run && f.t - run[run.length - 1].t <= maxGap) run.push(f)
    else runs.push([f])
  }

  const passes: PassData[] = []
  for (const run of runs) {
    for (const seg of splitByDirection(run)) {
      if (seg.length < 5 || seg[seg.length - 1].t - seg[0].t < 700) continue
      const ts = seg.map((f) => f.t)
      const t0 = ts[0]
      const t1 = ts[ts.length - 1]
      // 脚の長さ: 3 等分した区間ごとの 90% 点に直線を当てる（カメラとの距離の変化を追う）
      const legs = seg.map((f) => legLength(f.p))
      const third = (t1 - t0) / 3
      const pts: { t: number; v: number }[] = []
      for (let k = 0; k < 3; k++) {
        const lo = t0 + k * third
        const hi = k === 2 ? t1 + 1 : lo + third
        const vals = legs.filter((_, i) => ts[i] >= lo && ts[i] < hi)
        if (vals.length) pts.push({ t: (lo + Math.min(hi, t1)) / 2, v: quantile(vals, 0.9) })
      }
      const fit = pts.length >= 2 ? lineFit(pts.map((p) => p.t), pts.map((p) => p.v)) : { a: quantile(legs, 0.9), b: 0 }
      const legAt = (t: number) => fit.a + fit.b * t
      const leg = ts.map(legAt)
      const scaleChange = legAt(t1) / legAt(t0) - 1
      const hip0 = midP(seg[0].p[23], seg[0].p[24]).x
      const hip1 = midP(seg[seg.length - 1].p[23], seg[seg.length - 1].p[24]).x
      const dir: 1 | -1 = hip1 >= hip0 ? 1 : -1
      const sep = smooth3(seg.map((f, i) => Math.abs(f.p[27].x - f.p[28].x) / leg[i]))
      const strikes = findStrikes(ts, sep)
      const pass: GaitPass = { start: t0, end: t1, dir, strikes: strikes.map((s) => s.t), scaleChange }
      if (Math.abs(hip1 - hip0) < legAt((t0 + t1) / 2)) pass.excluded = '画面を横切る距離が短いため'
      else if (Math.abs(scaleChange) > SCALE_EXCLUDE) pass.excluded = 'カメラに近づく・遠ざかる向きに歩いたため'
      passes.push({ pass, frames: seg, leg, sep, strikeSep: strikes.map((s) => s.v) })
    }
  }
  return { passes, fps, validFrames: valid.length }
}

/** 1 歩（山から次の山まで）ごとの値 */
interface StepValues {
  dir: 1 | -1
  ms: number
  lean: number
  head: number
  arm: number
}

/** typical: すべての通過の 1 歩の時間の中央値 */
function stepValues(pd: PassData, typical: number): StepValues[] {
  const { pass, frames } = pd
  const out: StepValues[] = []
  const intervals = pass.strikes.slice(1).map((t, k) => ({ a: pass.strikes[k], b: t }))
  for (const { a, b } of intervals) {
    const ms = b - a
    // 山を 1 つ見落とした区間（ほかの歩の 1.6 倍以上）は使わない
    if (ms < STEP_MS.min || ms > STEP_MS.max || ms > 1.6 * typical) continue
    const fs = frames.filter((f) => f.t >= a && f.t <= b)
    if (fs.length < 2) continue
    const leans: number[] = []
    const heads: number[] = []
    let armMax = -Infinity
    let armMin = Infinity
    for (const f of fs) {
      const S = midP(f.p[11], f.p[12])
      const P = midP(f.p[23], f.p[24])
      const E = midP(f.p[7], f.p[8])
      leans.push(Math.atan2(pass.dir * (S.x - P.x), -(S.y - P.y)) * RAD2DEG)
      heads.push(Math.atan2(pass.dir * (E.x - S.x), -(E.y - S.y)) * RAD2DEG)
      // 手首は見えているものだけ（体の陰の手首は推定がずれやすい）。1 歩の間に、手前の腕が前から後ろまで振れる
      for (const w of [15, 16]) {
        if (f.v[w] < MIN_VISIBILITY) continue
        const W = f.p[w]
        const ang = Math.atan2(pass.dir * (W.x - S.x), W.y - S.y) * RAD2DEG
        armMax = Math.max(armMax, ang)
        armMin = Math.min(armMin, ang)
      }
    }
    out.push({ dir: pass.dir, ms, lean: mean(leans), head: mean(heads), arm: armMax > armMin ? armMax - armMin : NaN })
  }
  return out
}

function sd(values: number[]) {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1))
}

/** ほかの歩から大きく外れた値（中央値からの差が、中央絶対偏差の 3.5 倍を超える）を除く */
function inlierMask(values: number[], floor: number) {
  if (values.length < 4) return values.map(() => true)
  const med = median(values)
  const mad = 1.4826 * median(values.map((v) => Math.abs(v - med)))
  const limit = 3.5 * Math.max(mad, floor)
  return values.map((v) => Math.abs(v - med) <= limit)
}

function pooled(key: GaitMetricKey, all: number[], note?: string): GaitMetric {
  const finite = all.filter(Number.isFinite)
  const keep = inlierMask(finite, FLOOR[key])
  const values = finite.filter((_, i) => keep[i])
  if (values.length < MIN_STEPS) {
    return { key, value: null, uncertainty: null, steps: values.length, status: 'unavailable', note: `測定できた歩数が足りません（${values.length} 歩。${MIN_STEPS} 歩以上必要です）` }
  }
  const u = Math.max(sd(values) / Math.sqrt(values.length), FLOOR[key])
  return { key, value: mean(values), uncertainty: u, steps: values.length, status: 'ok', note }
}

/**
 * 角度の値。行き（右へ）と帰り（左へ）の両方があれば、それぞれの平均をさらに平均する。
 * カメラの傾きは、行きと帰りで逆向きに値に入るので打ち消し合う
 */
function directional(key: GaitMetricKey, allSteps: StepValues[], pick: (s: StepValues) => number, rollCorrected: boolean): GaitMetric {
  // 外れた歩は向きごとに見る（カメラが傾いていると、行きと帰りで値がずれるため）
  const steps = ([1, -1] as const).flatMap((d) => {
    const group = allSteps.filter((s) => s.dir === d)
    const keep = inlierMask(group.map(pick), FLOOR[key])
    return group.filter((_, i) => keep[i])
  })
  const vals = steps.map(pick)
  if (vals.length < MIN_STEPS) return pooled(key, vals)
  const right = steps.filter((s) => s.dir === 1).map(pick)
  const left = steps.filter((s) => s.dir === -1).map(pick)
  if (!right.length || !left.length) {
    const note = rollCorrected
      ? '片道だけの記録です。端末の傾きは戻していますが、往復すると傾きの影響をさらに打ち消せます。'
      : '片道だけの記録のため、カメラの傾きがそのまま値に入ります（往復すると打ち消せます）。'
    return pooled(key, vals, note)
  }
  const mr = mean(right)
  const ml = mean(left)
  const res = [...right.map((v) => v - mr), ...left.map((v) => v - ml)]
  const s = res.length > 2 ? Math.sqrt(res.reduce((a, v) => a + v * v, 0) / (res.length - 2)) : 0
  const u = Math.max(0.5 * Math.sqrt(s ** 2 / right.length + s ** 2 / left.length), FLOOR[key])
  const half = (mr - ml) / 2
  const note =
    Math.abs(half) > 2
      ? `行きと帰りで ${Math.abs(2 * half).toFixed(1)}° 違いました（カメラの傾きや、体の向きによる推定の偏りが考えられます）。両方を平均して打ち消しています。`
      : undefined
  return { key, value: (mr + ml) / 2, uncertainty: u, steps: vals.length, status: 'ok', note }
}

export function analyzeGait(input: GaitInput): GaitAnalysis {
  const { passes, fps, validFrames } = preparePasses(input)
  const warnings: string[] = []
  const used = passes.filter((p) => !p.pass.excluded)
  if (!validFrames) warnings.push('全身が画面に写ったコマが見つかりませんでした。カメラから離れて、頭から足まで入るようにしてください。')
  else if (!used.length) warnings.push('全身が写った状態で、画面を横切って歩く場面が見つかりませんでした。')
  if (fps < 20) warnings.push(`1 秒あたり ${Math.round(fps)} コマのため、テンポと歩幅の誤差が大きくなります。`)
  for (const p of used) {
    if (Math.abs(p.pass.scaleChange) > SCALE_WARN) {
      warnings.push(`画面を横切る間に体の大きさが ${Math.round(Math.abs(p.pass.scaleChange) * 100)}% 変わりました。カメラに近づく・遠ざかる向きに歩いた可能性があります。`)
    }
  }

  const allIntervals = used.flatMap((p) => p.pass.strikes.slice(1).map((t, k) => t - p.pass.strikes[k]))
  const typical = allIntervals.length ? median(allIntervals) : NaN
  const steps = used.flatMap((p) => stepValues(p, typical))
  const lengths = used.flatMap((p) => p.strikeSep.map((v) => v * 100))
  const rollCorrected = input.rollDeg !== undefined
  const metrics: GaitMetric[] = [
    pooled('cadence', steps.map((s) => 60000 / s.ms)),
    pooled('step_length', lengths),
    directional('trunk_lean', steps, (s) => s.lean, rollCorrected),
    directional('head_forward', steps, (s) => s.head, rollCorrected),
    pooled('arm_swing', steps.map((s) => s.arm)),
  ]
  return {
    algorithmVersion: GAIT_ALGORITHM_VERSION,
    passes: passes.map((p) => p.pass),
    metrics,
    warnings,
    fps,
    validFrames,
    rollCorrectedDeg: input.rollDeg,
  }
}

export function gaitMetric(a: GaitAnalysis | undefined, key: GaitMetricKey) {
  return a?.metrics.find((m) => m.key === key)
}

export interface GaitChange {
  key: GaitMetricKey
  diff: number
  /** 差が、2 回の測定の揺れを合わせた幅の NOTICEABLE_K 倍を超えたか */
  noticeable: boolean
}

/** 前の記録との差（両方とも測れた値だけ） */
export function compareGait(prev: GaitAnalysis, cur: GaitAnalysis): GaitChange[] {
  const out: GaitChange[] = []
  for (const key of GAIT_METRIC_KEYS) {
    const a = gaitMetric(prev, key)
    const b = gaitMetric(cur, key)
    if (a?.status !== 'ok' || b?.status !== 'ok' || a.value === null || b.value === null) continue
    const diff = b.value - a.value
    const u = Math.hypot(a.uncertainty ?? 0, b.uncertainty ?? 0)
    out.push({ key, diff, noticeable: Math.abs(diff) > NOTICEABLE_K * u })
  }
  return out
}

/** 保存用: 33 点 × [x, y, 見えている度合い] を小数 4 桁の数の並びにする */
export function packLandmarks(lm: Landmark[]): number[] {
  const out: number[] = []
  for (const l of lm) out.push(Math.round(l.x * 1e4) / 1e4, Math.round(l.y * 1e4) / 1e4, Math.round(vis(l) * 100) / 100)
  return out
}

export function unpackLandmarks(p: number[]): Landmark[] {
  const out: Landmark[] = []
  for (let i = 0; i + 2 < p.length; i += 3) out.push({ x: p[i], y: p[i + 1], z: 0, visibility: p[i + 2] })
  return out
}

/** 撮影のときの足元（条件をそろえるため。比べるときに違えば知らせる） */
export type Footwear = 'shoes' | 'socks' | 'barefoot'

export const FOOTWEAR_LABELS: Record<Footwear, string> = { shoes: '靴', socks: '靴下', barefoot: 'はだし' }

/** 歩き方の記録。動画は保存せず、体の点の動きだけを保存する */
export interface GaitRecord {
  id: string
  createdAt: string
  appVersion: string
  source: 'camera' | 'upload'
  modelVersion: string
  footwear?: Footwear
  video: {
    width: number
    height: number
    durationMs: number
    /** 推定にかけたコマの数 */
    frameCount: number
    fps: number
    /** 映像を時計回りに 90° 回した回数（横向きに持ったときなど） */
    quarterTurns: number
    /** 端末の傾き（回した後に残る小さな傾き。度）。分からなければなし */
    rollDeg?: number
  }
  /** 人を検出できたコマ。p は 33 点 × [x, y, 見えている度合い] */
  frames: { t: number; p: number[] }[]
  analysis: GaitAnalysis
}

export function gaitInputOf(r: Pick<GaitRecord, 'frames' | 'video'>): GaitInput {
  return {
    frames: r.frames.map((f) => ({ t: f.t, lm: unpackLandmarks(f.p) })),
    width: r.video.width,
    height: r.video.height,
    rollDeg: r.video.rollDeg,
    fps: r.video.fps,
  }
}

/** 計算の版が古ければ、保存した体の点から計算し直す */
export function upgradeGait(r: GaitRecord): GaitRecord {
  if (r.analysis.algorithmVersion === GAIT_ALGORITHM_VERSION) return r
  return { ...r, analysis: analyzeGait(gaitInputOf(r)) }
}

/** 体の向き（股関節の中点→肩の中点）から、映像を時計回りに何回 90° 回せば上が上になるか */
export function turnsFromBody(lm: Landmark[], width: number, height: number): number | null {
  if (lm.length < 33) return null
  const ok = (a: number, b: number) => Math.max(vis(lm[a]), vis(lm[b])) >= MIN_VISIBILITY
  if (!ok(11, 12) || !ok(23, 24)) return null
  const S = { x: ((lm[11].x + lm[12].x) / 2) * width, y: ((lm[11].y + lm[12].y) / 2) * height }
  const P = { x: ((lm[23].x + lm[24].x) / 2) * width, y: ((lm[23].y + lm[24].y) / 2) * height }
  const theta = Math.atan2(S.x - P.x, -(S.y - P.y)) * RAD2DEG
  const k = Math.round(-theta / 90)
  return (((k % 4) + 5) % 4) - 1
}
