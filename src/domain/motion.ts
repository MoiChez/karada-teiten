// 動きの記録（スクワット・ローイングエルゴ・固定式の自転車）の入口。横から撮った動画の、コマごとの体の点から
// 関節の角度を求め、1 回ごとに区切る（docs/05 の 7 章）。正常範囲とは比べず、良し悪しも判定しない。
// 値は自分の過去の記録と比べるためのもの。土台は motionCore.ts、種目ごとの定義は motionSports.ts
import { MIN_VISIBILITY, NOTICEABLE_K } from './constants'
import { mean, std } from './geometry'
import { sidePoints } from './landmarks'
import {
  prepareBase,
  quantile,
  unpackLandmarks,
  unpackWorld,
  vis,
  type MotionEdit,
  type MotionFrameData,
  type MotionInput,
  type MotionKind,
  type MotionVideoInfo,
} from './motionCore'
import { PROFILES, type MotionCycle, type PreparedMotion, type SeriesCtx } from './motionSports'
import type { ConstraintNote } from './motionConstraints'
import { resolveBody, squatLoad, type BodyParams, type ResolvedBody } from './motionLoad'
import { barSeries } from './motionBar'
import { crankAngles } from './motionCrank'
import { frontalValues, viewOf, type ViewInfo } from './motionFrontal'

export * from './motionCore'
export { MOTION_KIND_LIST, MUSCLE_LABELS, PROFILES, REP_MIN_DEPTH, eventOf } from './motionSports'
export type { MetricDef, MotionCycle, MotionEvent, MuscleKey, PreparedMotion, SeriesDef, SportProfile } from './motionSports'

export const MOTION_ALGORITHM_VERSION = 7

export const MOTION_KINDS: Record<MotionKind, { label: string }> = {
  squat: { label: PROFILES.squat.label },
  squat_front: { label: PROFILES.squat_front.label },
  erg: { label: PROFILES.erg.label },
  bike: { label: PROFILES.bike.label },
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
  /** 推定した体の点（書き換えない） */
  frames: MotionFrameData[]
  /** 手で直した点（新しい順ではなく、直した順） */
  edits?: MotionEdit[]
  /** 身長・体重・持つ重さ（入力されたものだけ。撮ったときのプロフィールの値か、結果の画面で入れた値） */
  body?: BodyParams
  analysis: MotionAnalysis
}

export function motionInputOf(r: Pick<MotionRecord, 'frames' | 'video'> & { edits?: MotionEdit[]; body?: BodyParams }): MotionInput {
  return {
    frames: r.frames.map((f) => ({ t: f.t, lm: unpackLandmarks(f.p), world: f.w ? unpackWorld(f.w) : undefined })),
    width: r.video.width,
    height: r.video.height,
    rollDeg: r.video.rollDeg,
    edits: r.edits,
    body: r.body,
  }
}

/** 検出できたコマから、なめらかにした点とコマごとの値を求める */
export function prepareMotion(input: MotionInput, kind: MotionKind = 'squat'): PreparedMotion | null {
  const profile = PROFILES[kind]
  const base = prepareBase(input, profile.valid, profile.smoothing, profile.constrain)
  if (!base) return null
  const s = sidePoints(base.nearSide)
  // 撮った向きと、体の左へ向かう画面の向き（正面から撮ったら画面の右、それ以外は画面の左）
  const view = viewOf(input.frames, input.width, input.height)
  const leftDir: 1 | -1 = view.noseForward !== null && view.noseForward > 0 ? 1 : -1
  // 立っているときの股関節〜足首の高さ（高い方から 1 割のところ）。正面・後ろからは左右の中点で
  const standLeg = quantile(
    profile.frontal ? base.frames.map((fr) => frontalValues(fr.px, leftDir)?.hipHeight ?? NaN).filter(Number.isFinite) : base.frames.map((fr) => fr.px[s.ankle].y - fr.px[s.hip].y),
    0.9,
  )
  const body = resolveBody(input.body)
  const ctx: SeriesCtx = { s, f: base.f, leg: base.leg, standLeg: standLeg > 0 ? standLeg : base.leg, body, leftDir }
  const series: Record<string, number[]> = {}
  for (const def of profile.series) {
    const value = def.value
    if (value) series[def.key] = base.frames.map((fr) => value(fr.px, ctx))
  }
  const load = profile.load ? (squatLoad(base.frames, s, base.f, body, base.breaks) ?? undefined) : undefined
  if (profile.load) {
    const none = base.frames.map(() => NaN)
    series.ratio = load?.ratio ?? none
    series.ratio_lo = load?.ratioLo ?? none
    series.ratio_hi = load?.ratioHi ?? none
  }
  const prep: PreparedMotion = { ...base, kind, standLeg: ctx.standLeg, series, body, load, view, leftDir }
  if (profile.load) prep.bar = barSeries(prep) ?? undefined
  if (profile.crank) prep.crank = crankAngles(prep) ?? undefined
  return prep
}

export function findCycles(prep: PreparedMotion) {
  return PROFILES[prep.kind].findCycles(prep)
}

// ---------- まとめ ----------

export interface MotionMetric {
  key: string
  /** 回ごとの値の平均 */
  value: number | null
  /** 回ごとの値の標準偏差（2 回以上のとき） */
  sd: number | null
  /** 比べるときのばらつき（平均の揺れ。目安の下限あり） */
  uncertainty: number | null
  /** 値を出せた回の数 */
  reps: number
  status: 'ok' | 'unavailable'
}

export interface MotionCycleSummary {
  start: number
  end: number
  events: { key: string; t: number }[]
  values: Record<string, number | null>
}

export interface MotionAnalysis {
  algorithmVersion: number
  kind: MotionKind
  facing: 'left' | 'right'
  nearSide: 'left' | 'right'
  /** 計算に使えたコマの数 */
  validFrames: number
  cycles: MotionCycleSummary[]
  metrics: MotionMetric[]
  warnings: string[]
  /** 使った器具の前提（エルゴ・自転車） */
  constraints?: ConstraintNote[]
  /** 重心と負担の推定に使った身長・体重・持つ重さ（スクワット。仮定の値かどうかも） */
  body?: ResolvedBody
  /** 真横から撮れていたか（false なら、anyView でない値は参考にならない。古い記録は undefined） */
  sideView?: boolean
  /** 撮った向き（横・正面・後ろ・斜め） */
  view?: ViewInfo
}

/**
 * 横向きの確認: 左右の股関節の間隔 / 胴の長さ がこれを超えたら、真横から撮れていない可能性を知らせる。
 * 肩ではなく腰で見るのは、バーベルを担ぐと腕が上がり、肩の点が左右に広がって見えるため。
 * 実在の人の写真では、真横 0.01〜0.16（バーを担いだ写真 0.14）、斜め後ろ 0.30 前後、正面 0.26〜0.45 だった
 */
const SIDE_HIP_RATIO_MAX = 0.2
/** 計算に使うカメラ側の点の、見えている度合いの中央値がこれ未満なら、隠れていることを知らせる */
const HIDDEN_VIS = 0.5

export function cycleValues(c: MotionCycle, prep: PreparedMotion): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const m of PROFILES[prep.kind].metrics) {
    const v = m.value(c, prep)
    out[m.key] = v !== null && Number.isFinite(v) ? v : null
  }
  return out
}

/** スクワットは、撮った向きで、横からの計算（squat）か正面・後ろからの計算（squat_front）かを選ぶ */
export function kindForView(input: MotionInput, kind: MotionKind): MotionKind {
  if (kind !== 'squat' && kind !== 'squat_front') return kind
  const v = viewOf(input.frames, input.width, input.height).view
  return v === 'front' || v === 'rear' ? 'squat_front' : 'squat'
}

export function analyzeMotion(input: MotionInput, requested: MotionKind = 'squat'): MotionAnalysis {
  const kind = kindForView(input, requested)
  const profile = PROFILES[kind]
  const warnings: string[] = []
  const prep = prepareMotion(input, kind)
  const empty = (): MotionMetric[] => profile.metrics.map((m) => ({ key: m.key, value: null, sd: null, uncertainty: null, reps: 0, status: 'unavailable' }))
  if (!prep) {
    return {
      algorithmVersion: MOTION_ALGORITHM_VERSION,
      kind,
      facing: 'left',
      nearSide: 'left',
      validFrames: 0,
      cycles: [],
      metrics: empty(),
      warnings: ['体を検出できたコマが少なく、測れませんでした。全身が画面に入る距離で、体の真横から撮ってください。'],
    }
  }
  const { cycles, warnings: cycleWarnings } = profile.findCycles(prep)

  // 真横から撮れているか（左右の股関節の間隔 / 胴の長さ）
  let sideView = true
  const s = sidePoints(prep.nearSide)
  const ratios = (profile.frontal ? [] : profile.sideCheckFrames(prep))
    .map((i) => prep.frames[i])
    .filter((fr) => [23, 24].every((i) => vis(fr.lm[i]) >= MIN_VISIBILITY * 0.6))
    .map((fr) => {
      const p = fr.px
      const hw = Math.hypot(p[23].x - p[24].x, p[23].y - p[24].y)
      const torso = Math.hypot(p[s.shoulder].x - p[s.hip].x, p[s.shoulder].y - p[s.hip].y)
      return torso > 0 ? hw / torso : 0
    })
  if (ratios.length >= 5 && quantile(ratios, 0.5) > SIDE_HIP_RATIO_MAX) {
    sideView = false
    warnings.push(
      `体が真横を向いていないようです（腰の幅から見た向き）。${anyViewLabels(profile)}は使えますが、角度・位置などのほかの値は、横から見た見かけの値として求めているため、この動画では参考になりません。次は体の真横から撮ってください。${kind === 'squat' ? '左右の差を見たいときは、斜めではなく真正面か真後ろから撮ると、左右の差を測ります。' : ''}`,
    )
  }
  // カメラ側の点が隠れていないか（器具・体の陰）
  const hidden = profile
    .keyPoints(s)
    .filter(([i]) => quantile(prep.frames.map((fr) => (fr.edited.includes(i) ? 1 : vis(fr.lm[i]))), 0.5) < HIDDEN_VIS)
    .map(([, name]) => name)
  if (hidden.length) warnings.push(`カメラ側の${hidden.join('・')}がはっきり写っていないコマが多く、位置を推測して計算しています。${profile.hiddenHint}`)
  warnings.push(...cycleWarnings)
  // 自転車: 足首の点が、顔の向きから見て後ろ向きに回っている（実際に後ろ向きにこぐことはまれなので、推定の取り違えを疑う）
  if (prep.crank?.reversed) {
    warnings.push(
      '足首の点が、顔の向きから見て後ろ向きに回っているように推定されました。実際に前にこいでいた場合は、推定モデルが体の向きか、手前と奥の脚を取り違えています。値と 3D は、推定した動きのとおりに出しています。',
    )
  }

  const values = cycles.map((c) => cycleValues(c, prep))
  const metrics: MotionMetric[] = profile.metrics.map((m) => {
    const v = values.map((r) => r[m.key]).filter((x): x is number => x !== null)
    if (!v.length) return { key: m.key, value: null, sd: null, uncertainty: null, reps: 0, status: 'unavailable' }
    const sd = v.length >= 2 ? std(v) : null
    const se = sd !== null ? sd / Math.sqrt(v.length) : 0
    return { key: m.key, value: mean(v), sd, uncertainty: Math.max(se, m.floor), reps: v.length, status: 'ok' }
  })
  return {
    algorithmVersion: MOTION_ALGORITHM_VERSION,
    kind,
    facing: prep.f === 1 ? 'right' : 'left',
    nearSide: prep.nearSide,
    validFrames: prep.frames.length,
    cycles: cycles.map((c, k) => ({ start: c.start, end: c.end, events: c.events.map((e) => ({ key: e.key, t: e.t })), values: values[k] })),
    metrics,
    warnings,
    constraints: prep.constraints.length ? prep.constraints : undefined,
    body: prep.load ? prep.body : undefined,
    sideView,
    view: prep.view,
  }
}

/** 真横でなくても使える値の名前（「回数・深さ・しゃがむ時間…」） */
function anyViewLabels(profile: (typeof PROFILES)[MotionKind]) {
  return ['回数', ...profile.metrics.filter((m) => m.anyView).map((m) => m.label)].join('・')
}

export function motionMetric(a: MotionAnalysis | undefined, key: string) {
  return a?.metrics.find((m) => m.key === key)
}

export interface MotionChange {
  key: string
  diff: number
  noticeable: boolean
}

/** 前の記録との差（同じ種目で、両方とも測れた値だけ）。差が両方のばらつきを合わせた 2 倍を超えれば「差が見られる」 */
export function compareMotion(prev: MotionAnalysis, cur: MotionAnalysis): MotionChange[] {
  if ((prev.kind ?? 'squat') !== (cur.kind ?? 'squat')) return []
  const out: MotionChange[] = []
  for (const def of PROFILES[cur.kind ?? 'squat'].metrics) {
    const a = motionMetric(prev, def.key)
    const b = motionMetric(cur, def.key)
    if (a?.status !== 'ok' || b?.status !== 'ok' || a.value === null || b.value === null) continue
    const diff = b.value - a.value
    out.push({ key: def.key, diff, noticeable: Math.abs(diff) > NOTICEABLE_K * Math.hypot(a.uncertainty ?? 0, b.uncertainty ?? 0) })
  }
  return out
}

/** 計算の版が古ければ、保存した体の点（と手で直した点）から計算し直す */
export function upgradeMotion(r: MotionRecord): MotionRecord {
  const kind = r.kind ?? 'squat'
  if (r.analysis.algorithmVersion === MOTION_ALGORITHM_VERSION && r.analysis.kind === kind) return r
  const analysis = analyzeMotion(motionInputOf(r), kind)
  return { ...r, kind: analysis.kind, analysis }
}

/** 記録から、なめらかにした点・コマごとの値・区切りを作り直す（画面で使う） */
export function prepareRecord(r: MotionRecord): { prep: PreparedMotion; cycles: MotionCycle[] } | null {
  const prep = prepareMotion(motionInputOf(r), r.kind ?? 'squat')
  if (!prep) return null
  return { prep, cycles: findCycles(prep).cycles }
}


// ---------- 記録どうしを比べる（1 回の始めから終わりまでを 0〜100% にそろえる） ----------

/** 1 回の中の値を、始め（0%）から終わり（100%）まで等間隔の n 点に取り直す（時間で直線補間） */
export function cycleCurve(prep: PreparedMotion, c: MotionCycle, key: string, n = 101): number[] {
  const v = prep.series[key]
  const out: number[] = []
  let j = c.startIndex
  for (let k = 0; k < n; k++) {
    const t = c.start + ((c.end - c.start) * k) / (n - 1)
    while (j < c.endIndex && prep.frames[j + 1].t <= t) j++
    const a = prep.frames[j].t
    const b = prep.frames[Math.min(j + 1, c.endIndex)].t
    const w = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0
    out.push(v[j] + (v[Math.min(j + 1, c.endIndex)] - v[j]) * w)
  }
  return out
}

/** すべての回の平均の曲線（0〜100%）。回がなければ null */
export function meanCurve(prep: PreparedMotion, cycles: MotionCycle[], key: string, n = 101): number[] | null {
  if (!cycles.length) return null
  const curves = cycles.map((c) => cycleCurve(prep, c, key, n))
  return Array.from({ length: n }, (_, k) => mean(curves.map((cv) => cv[k])))
}

/** 比べるときに知らせる、条件の違い */
export function compareConditions(a: MotionRecord, b: MotionRecord): string[] {
  const out: string[] = []
  if (a.source !== b.source) out.push('撮り方（アプリのカメラ / 選んだ動画）が違います。')
  if (a.analysis.facing !== b.analysis.facing) out.push('体の向き（画面の左向き / 右向き）が違います。カメラ側の半身が左右で入れ替わっています。')
  if (Math.abs(a.video.fps - b.video.fps) > 3) out.push(`1 秒あたりのコマ数が違います（${Math.round(a.video.fps)} と ${Math.round(b.video.fps)}）。`)
  if (!!a.edits?.length !== !!b.edits?.length) out.push('片方だけ、点を手で直しています。')
  if (a.analysis.warnings.length || b.analysis.warnings.length) out.push('撮影の注意が出ている記録があります（それぞれの記録を開くと見られます）。')
  return out
}
