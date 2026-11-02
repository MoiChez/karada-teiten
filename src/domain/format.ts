// 表示用の文言・数値の整形
import type { BodyArea, ComputedMetric, GoalTag, LifestyleTag, MetricUnit } from './types'
import { H_TO_STATURE } from './constants'

export const GOAL_LABELS: Record<GoalTag, string> = {
  posture: '姿勢改善',
  diet: 'ダイエット',
  body_make: 'ボディメイク',
  relieve_discomfort: '肩や腰のつらさ軽減',
  fatigue: '疲れやすさ改善',
  appearance: '見た目改善',
  health: '健康維持',
  other: 'その他',
}

export const LIFESTYLE_LABELS: Record<LifestyleTag, string> = {
  desk_work: 'デスクワークが中心',
  standing_work: '立ち仕事が多い',
  physical_work: '体を使う仕事・作業が多い',
  driving: '車の運転が多い',
  smartphone_long: 'スマホを見る時間が長い',
  bag_one_side: 'かばんを片側で持つことが多い',
  crossed_legs: '脚を組むことが多い',
  housework_childcare: '家事・育児で動くことが多い',
}

export const AREA_LABELS: Record<BodyArea, string> = {
  neck: '首',
  shoulders: '肩',
  upper_back: '背中の上部',
  lower_back: '腰',
  hips: '股関節・お尻',
  knees: '膝',
  feet: '足首・足',
  whole_body: '全身',
}

export function fmtNum(v: number, digits = 1): string {
  const s = Math.abs(v) < 10 ** -digits / 2 ? 0 : v
  return s.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtValue(v: number | null, unit: MetricUnit | string, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return '—'
  if (unit === 'score') return fmtNum(v, 2)
  return `${fmtNum(v, digits)}${unit}`
}

export function fmtAbs(v: number, unit: MetricUnit | string, digits = 1): string {
  return fmtValue(Math.abs(v), unit, digits)
}

export function confidenceLabel(c: number): '高' | '中' | '低' {
  return c >= 0.75 ? '高' : c >= 0.5 ? '中' : '低'
}

export function metricStatusLabel(m: ComputedMetric): string {
  switch (m.status) {
    case 'noticeable':
      return '差が見られる'
    case 'within_noise':
      return 'ばらつきの範囲内'
    case 'descriptive':
      return '位置の記録'
    case 'unassessable':
      return '評価不可'
    case 'unsupported':
      return '推定できない'
  }
}

export function fmtDate(iso: string, withTime = false): string {
  const d = new Date(iso)
  const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  if (!withTime) return date
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtShortDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)
}

export function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- cm の目安 ----------

/** 体の高さ比の長さを、身長から cm の目安に換算する。身長が分からなければ null */
export function fracToCm(frac: number, heightCm: number | undefined): number | null {
  if (!heightCm || !Number.isFinite(heightCm) || heightCm <= 0) return null
  return frac * heightCm * H_TO_STATURE
}

/** 指標の長さ（位置のずれ・高さの差）を cm の目安で返す。換算できなければ null */
export function offsetCm(m: ComputedMetric, heightCm: number | undefined): { cm: number; sigmaCm: number | null; label: string } | null {
  if (!m.offset || m.rawValue === null) return null
  const cm = fracToCm(m.offset.frac, heightCm)
  if (cm === null) return null
  return { cm, sigmaCm: m.offset.sigma === null ? null : fracToCm(m.offset.sigma, heightCm), label: m.offset.label }
}

/** cm を主に見せる指標（位置のずれ・高さの差）。それ以外は角度などを主に見せる */
const CM_PRIMARY = new Set<ComputedMetric['key']>(['front_shoulder_tilt', 'front_pelvis_tilt', 'side_head_forward'])

/**
 * ゲージ・一覧の主な値（向きは別に示すので絶対値）。
 * % の指標と肩・骨盤の高さの差は、身長があれば cm の目安で示す
 */
export function primaryValue(m: ComputedMetric, heightCm: number | undefined): string {
  if (m.rawValue === null) return '—'
  const off = offsetCm(m, heightCm)
  if (off && (m.unit === '%' || CM_PRIMARY.has(m.key))) return `${fmtNum(Math.abs(off.cm))}cm`
  return fmtAbs(m.rawValue, m.unit)
}
