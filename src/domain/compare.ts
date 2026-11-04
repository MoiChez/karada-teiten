// 2 回の測定の比較と、推移・行動記録のまとめ
import type { AssessmentSession, CheckIn, ComputedMetric, MetricKey, RoutineLog, TraitKey } from './types'
import { COMPARE_WARN, NOTICEABLE_K, PRECISE_SHOTS } from './constants'
import { fmtAbs, fmtValue } from './format'
import { prefersTowardZero } from './metrics'
import { correctedSet } from './session'

export type ChangeLabel = 'improved' | 'stable' | 'worsened' | 'flipped' | 'changed'

export const CHANGE_LABELS: Record<ChangeLabel, string> = {
  improved: '改善傾向',
  stable: '横ばい',
  worsened: '悪化傾向',
  flipped: '向きが反対に',
  changed: '位置が変化',
}

export interface MetricChange {
  key: MetricKey
  label: string
  plane: ComputedMetric['plane']
  unit: ComputedMetric['unit']
  before: number
  after: number
  diff: number
  change: ChangeLabel
  /** 変化の大きさ（判定の閾値の何倍か） */
  significance: number
  threshold: number
  confidence: number
  beforeDirection: string
  afterDirection: string
  sentence: string
}

export interface ConditionWarning {
  key: string
  message: string
}

export interface Comparison {
  before: AssessmentSession
  after: AssessmentSession
  days: number
  changes: MetricChange[]
  unavailable: { key: MetricKey; label: string; reason: string }[]
  top: MetricChange[]
  counts: Record<'improved' | 'stable' | 'worsened', number>
  overall: string
  warnings: ConditionWarning[]
}

/** 指標キー → 関連する特徴（提案の優先づけに使う） */
export const METRIC_TO_TRAIT: Partial<Record<MetricKey, TraitKey>> = {
  front_body_lean: 'lateral_lean',
  front_shoulder_tilt: 'shoulder_asymmetry',
  front_pelvis_tilt: 'pelvis_asymmetry',
  front_head_tilt: 'head_tilt',
  front_trunk_shift: 'trunk_shift',
  front_lower_lean: 'lower_lean',
  front_neck_shift: 'neck_shift',
  front_knee_left: 'leg_alignment',
  front_knee_right: 'leg_alignment',
  front_load_shift: 'load_shift',
  side_head_forward: 'forward_head',
  side_trunk_lean: 'trunk_sagittal',
  side_arm_forward: 'rounded_shoulder_related',
  side_hip_forward: 'swayback_related',
  side_knee_extension: 'knee_hyperextension',
  composite_kyphosis: 'kyphosis_related',
  composite_swayback: 'swayback_related',
}

export function orderSessions(a: AssessmentSession, b: AssessmentSession): [AssessmentSession, AssessmentSession] {
  return a.createdAt <= b.createdAt ? [a, b] : [b, a]
}

function compareMetric(a: ComputedMetric, b: ComputedMetric): MetricChange | null {
  if (a.rawValue === null || b.rawValue === null) return null
  const sa = a.uncertainty ?? 0
  const sb = b.uncertainty ?? 0
  const threshold = Math.max(NOTICEABLE_K * Math.sqrt(sa * sa + sb * sb), 1e-6)
  const diff = b.rawValue - a.rawValue
  const unit = b.unit
  const v = (x: number) => fmtValue(x, unit)
  let change: ChangeLabel
  let significance: number
  let sentence: string

  if (prefersTowardZero(b.key)) {
    const dAbs = Math.abs(b.rawValue) - Math.abs(a.rawValue)
    if (Math.abs(dAbs) > threshold) {
      change = dAbs < 0 ? 'improved' : 'worsened'
      significance = Math.abs(dAbs) / threshold
      sentence =
        change === 'improved'
          ? `${b.label}は前回より小さくなっています（${fmtAbs(a.rawValue, unit)} → ${fmtAbs(b.rawValue, unit)}）。`
          : `${b.label}は前回より大きくなっています（${fmtAbs(a.rawValue, unit)} → ${fmtAbs(b.rawValue, unit)}）。`
    } else if (Math.abs(diff) > threshold) {
      change = 'flipped'
      significance = Math.abs(diff) / threshold
      sentence = `${b.label}は大きさは近いまま、向きが反対になりました（${a.direction} → ${b.direction}）。`
    } else {
      change = 'stable'
      significance = Math.abs(dAbs) / threshold
      sentence = `${b.label}は大きく変わっていません（${v(a.rawValue)} → ${v(b.rawValue)}）。`
    }
  } else {
    if (Math.abs(diff) > threshold) {
      change = 'changed'
      significance = Math.abs(diff) / threshold
      const toward = b.key === 'side_head_pitch' ? (diff >= 0 ? '下向き' : '上向き') : diff >= 0 ? '前' : '後ろ'
      sentence = `${b.label}は前回より${toward}の方向へ約${fmtAbs(diff, unit)}変わっています。`
    } else {
      change = 'stable'
      significance = Math.abs(diff) / threshold
      sentence = `${b.label}は大きく変わっていません。`
    }
  }
  return {
    key: b.key,
    label: b.label,
    plane: b.plane,
    unit,
    before: a.rawValue,
    after: b.rawValue,
    diff,
    change,
    significance: Math.round(significance * 100) / 100,
    threshold,
    confidence: Math.min(a.confidence, b.confidence),
    beforeDirection: a.direction,
    afterDirection: b.direction,
    sentence,
  }
}

export function compareSessions(x: AssessmentSession, y: AssessmentSession): Comparison {
  const [before, after] = orderSessions(x, y)
  const am = new Map(before.computedMetrics.map((m) => [m.key, m]))
  const changes: MetricChange[] = []
  const unavailable: Comparison['unavailable'] = []
  for (const bm of after.computedMetrics) {
    if (bm.status === 'unsupported') continue
    const a = am.get(bm.key)
    if (!a) {
      unavailable.push({ key: bm.key, label: bm.label, reason: '前回は測定していません' })
      continue
    }
    const c = compareMetric(a, bm)
    if (c) changes.push(c)
    else
      unavailable.push({
        key: bm.key,
        label: bm.label,
        reason: a.rawValue === null ? '前回は評価できませんでした' : '今回は評価できませんでした',
      })
  }
  for (const a of before.computedMetrics) {
    if (a.status === 'unsupported') continue
    if (!after.computedMetrics.some((m) => m.key === a.key)) {
      unavailable.push({ key: a.key, label: a.label, reason: '今回は測定していません' })
    }
  }

  const counts = {
    improved: changes.filter((c) => c.change === 'improved').length,
    stable: changes.filter((c) => c.change === 'stable').length,
    worsened: changes.filter((c) => c.change === 'worsened').length,
  }
  const top = [...changes]
    .filter((c) => c.change !== 'stable')
    .sort((p, q) => q.significance - p.significance)
    .slice(0, 5)

  return {
    before,
    after,
    days: Math.round((new Date(after.createdAt).getTime() - new Date(before.createdAt).getTime()) / 86400000),
    changes,
    unavailable,
    top,
    counts,
    overall: overallSentence(counts, top),
    warnings: conditionWarnings(before, after),
  }
}

function overallSentence(counts: Comparison['counts'], top: MetricChange[]): string {
  const total = counts.improved + counts.stable + counts.worsened
  if (total === 0) return '比べられる指標がありませんでした。'
  if (top.length === 0) return `比べられた ${total} 項目は、いずれも測定のばらつきの範囲内の変化でした。`
  const lead = top[0]
  const parts = [
    counts.improved ? `改善傾向 ${counts.improved} 項目` : '',
    counts.stable ? `横ばい ${counts.stable} 項目` : '',
    counts.worsened ? `悪化傾向 ${counts.worsened} 項目` : '',
  ].filter(Boolean)
  return `${parts.join('、')}でした。いちばん大きく変わったのは「${lead.label}」です。`
}

export function conditionWarnings(a: AssessmentSession, b: AssessmentSession): ConditionWarning[] {
  const w: ConditionWarning[] = []
  for (const plane of ['front', 'side'] as const) {
    const ra = a[plane]
    const rb = b[plane]
    const name = plane === 'front' ? '正面' : '側面'
    if (!ra || !rb) {
      if (ra || rb) w.push({ key: `${plane}_missing`, message: `${ra ? '今回' : '前回'}は${name}を撮っていないため、${name}の比較はできません。` })
      continue
    }
    const ca = correctedSet(ra).size > 0
    const cb = correctedSet(rb).size > 0
    if (ca !== cb) {
      w.push({
        key: `${plane}_correction`,
        message: `${name}: ${ca ? '前回' : '今回'}だけ手動補正があります。補正の有無で値が変わることがあります。`,
      })
    }
    const ya = ra.imageMetadata.yawDeg
    const yb = rb.imageMetadata.yawDeg
    if (plane === 'front' && ya !== undefined && yb !== undefined && Math.abs(ya - yb) >= COMPARE_WARN.yawDiffDeg) {
      w.push({ key: 'front_yaw', message: `正面写真の体の向きが前回と約 ${Math.abs(ya - yb).toFixed(0)}° 違います。` })
    }
    const ta = ra.imageMetadata.deviceTilt?.rollDeg
    const tb = rb.imageMetadata.deviceTilt?.rollDeg
    if (ta !== undefined && tb !== undefined && Math.abs(ta - tb) >= COMPARE_WARN.deviceTiltDiffDeg) {
      w.push({ key: `${plane}_tilt`, message: `${name}: 撮影時の端末の傾きが前回と約 ${Math.abs(ta - tb).toFixed(0)}° 違います。` })
    }
    if (plane === 'side' && ra.imageMetadata.facing && rb.imageMetadata.facing && ra.imageMetadata.facing !== rb.imageMetadata.facing) {
      w.push({ key: 'side_facing', message: '側面の向き（左向き / 右向き）が前回と逆です。左右の半身で値が違う可能性があります。' })
    }
  }
  if (a.captureMode && b.captureMode && a.captureMode !== b.captureMode) {
    const name = (m: string) => (m === 'precise' ? '高精度モード' : 'シンプルモード')
    w.push({
      key: 'mode',
      message: `前回は${name(a.captureMode)}、今回は${name(b.captureMode)}で測りました。高精度モードは ${PRECISE_SHOTS} 枚の平均なので、値の揺れが小さくなっています。`,
    })
  }
  if (a.imagesSaved !== b.imagesSaved) {
    w.push({ key: 'images', message: `${a.imagesSaved ? '今回' : '前回'}の写真は保存されていないため、写真の比較はできません（骨格で比べます）。` })
  }
  const da = a.confidenceScores.overall
  const db = b.confidenceScores.overall
  if (Math.abs(da - db) >= COMPARE_WARN.confidenceDiff) {
    w.push({ key: 'confidence', message: `測定の信頼度が前回と大きく違います（${Math.round(da * 100)} → ${Math.round(db * 100)}）。` })
  }
  if (a.modelVersion !== b.modelVersion) {
    w.push({ key: 'model', message: '前回と違う推定モデルを使っています。' })
  }
  return w
}

// ---------- 推移 ----------

export interface SeriesPoint {
  sessionId: string
  date: string
  value: number
  uncertainty: number | null
}

export function metricSeries(sessions: AssessmentSession[], key: MetricKey, sinceDays?: number, now = new Date()): SeriesPoint[] {
  const since = sinceDays ? now.getTime() - sinceDays * 86400000 : -Infinity
  return sessions
    .filter((s) => new Date(s.createdAt).getTime() >= since)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => {
      const m = s.computedMetrics.find((x) => x.key === key)
      return m && m.rawValue !== null
        ? { sessionId: s.id, date: s.createdAt, value: m.rawValue, uncertainty: m.uncertainty }
        : null
    })
    .filter((p): p is SeriesPoint => p !== null)
}

// ---------- 行動との関連 ----------

export interface BehaviorSummary {
  logCount: number
  activeDays: number
  topRoutines: { routineId: string; count: number }[]
  fatigue: { first?: number; last?: number }
  sleep: { first?: number; last?: number }
  checkinCount: number
}

export function behaviorBetween(fromIso: string, toIso: string, logs: RoutineLog[], checkins: CheckIn[]): BehaviorSummary {
  // 前回の測定日の朝に記録したコンディションも含めるため、開始は前回の測定日の 0 時にする
  const d = new Date(fromIso)
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
  const to = toIso
  const inRange = (d: string) => d >= from && d <= to
  const ls = logs.filter((l) => inRange(l.date))
  const counts = new Map<string, number>()
  for (const l of ls) counts.set(l.routineId, (counts.get(l.routineId) ?? 0) + 1)
  const days = new Set(ls.map((l) => l.date.slice(0, 10)))
  const cs = checkins.filter((c) => inRange(c.date)).sort((a, b) => a.date.localeCompare(b.date))
  const firstWith = (k: 'fatigueRating' | 'sleepRating') => cs.find((c) => c[k] !== undefined)?.[k]
  const lastWith = (k: 'fatigueRating' | 'sleepRating') => [...cs].reverse().find((c) => c[k] !== undefined)?.[k]
  return {
    logCount: ls.length,
    activeDays: days.size,
    topRoutines: [...counts.entries()]
      .map(([routineId, count]) => ({ routineId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
    fatigue: { first: firstWith('fatigueRating'), last: lastWith('fatigueRating') },
    sleep: { first: firstWith('sleepRating'), last: lastWith('sleepRating') },
    checkinCount: cs.length,
  }
}
