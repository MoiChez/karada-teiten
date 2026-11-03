// 向きつきゲージ（7 マス）の位置を決める。
// 中央のマスは「測定のばらつきの範囲（|値| ≤ 2σ）」。外側へ 1 マス進むごとに、ばらつき 2 つ分（2σ）大きい差。
// 医学的な基準値ではなく、その差が測定のばらつきに比べてどれだけはっきりしているかを表す
import type { ComputedMetric, MetricKey, Plane } from './types'
import { NOTICEABLE_K } from './constants'

export type GaugeAxisId = 'lateral' | 'leg' | 'sagittal' | 'plumb' | 'pitch'

export interface GaugeAxis {
  id: GaugeAxisId
  left: string
  center: string
  right: string
}

export const GAUGE_AXES: Record<GaugeAxisId, GaugeAxis> = {
  // 正面の写真と同じ並び（写っている人の右が画面の左）
  lateral: { id: 'lateral', left: '右', center: '差なし', right: '左' },
  leg: { id: 'leg', left: '内側', center: '線上', right: '外側' },
  sagittal: { id: 'sagittal', left: '前', center: '差なし', right: '後ろ' },
  plumb: { id: 'plumb', left: '前', center: '足首の真上', right: '後ろ' },
  pitch: { id: 'pitch', left: '上向き', center: '水平', right: '下向き' },
}

interface Spec {
  axis: GaugeAxisId
  /** + の値を左側に置く */
  flip?: boolean
  /** 向きの短い説明（なければ軸の端の名前） */
  tag?: (v: number) => string
  /** ゲージの行に出す短い名前（なければ指標名） */
  short?: string
}

const higher = (v: number) => (v >= 0 ? '右が上' : '左が上')

const SPECS: Partial<Record<MetricKey, Spec>> = {
  front_body_lean: { axis: 'lateral' },
  front_trunk_shift: { axis: 'lateral' },
  front_lower_lean: { axis: 'lateral' },
  front_head_tilt: { axis: 'lateral' },
  front_neck_shift: { axis: 'lateral' },
  // + は左が低い = 右が上。上がっている側にマスを置く
  front_shoulder_tilt: { axis: 'lateral', flip: true, tag: higher, short: '肩の高さ' },
  front_pelvis_tilt: { axis: 'lateral', flip: true, tag: higher, short: '骨盤付近の高さ' },
  front_load_shift: { axis: 'lateral', short: '左右荷重の傾向（参考）' },
  front_knee_left: { axis: 'leg', short: '左膝（O脚・X脚に関連）' },
  front_knee_right: { axis: 'leg', short: '右膝（O脚・X脚に関連）' },
  side_head_forward: { axis: 'sagittal', flip: true, short: '頭の前後位置' },
  side_trunk_lean: { axis: 'sagittal', flip: true },
  side_arm_forward: { axis: 'sagittal', flip: true, short: '腕の前後位置' },
  side_hip_forward: { axis: 'sagittal', flip: true, short: '骨盤帯の前後位置' },
  side_knee_extension: { axis: 'sagittal', tag: (v) => (v >= 0 ? '伸びすぎの方向' : '曲がる方向'), short: '膝の伸び' },
  side_plumb_shoulder: { axis: 'plumb', flip: true },
  side_plumb_hip: { axis: 'plumb', flip: true },
  side_plumb_ear: { axis: 'plumb', flip: true, short: '耳の位置' },
  side_plumb_knee: { axis: 'plumb', flip: true, short: '膝の位置' },
  side_head_pitch: { axis: 'pitch', short: '頭の前後傾き（顔の向き）' },
}

/** ばらつき（1σ）に対する差の段階。0 = ばらつきの範囲内、1〜3 = 外側のマス */
export function gaugeLevel(value: number, sigma: number | null): number {
  if (!sigma || sigma <= 0) return 0
  const z = Math.abs(value) / sigma
  if (z <= NOTICEABLE_K) return 0
  return Math.min(3, Math.ceil((z - NOTICEABLE_K) / NOTICEABLE_K))
}

/** マスの位置 −3..3（負 = 左側）。評価できなければ null */
export function gaugeCell(m: ComputedMetric | undefined): number | null {
  if (!m || m.rawValue === null) return null
  const spec = SPECS[m.key]
  if (!spec) return null
  const level = gaugeLevel(m.rawValue, m.uncertainty)
  if (level === 0) return 0
  return level * Math.sign(m.rawValue) * (spec.flip ? -1 : 1)
}

export interface GaugeRow {
  key: MetricKey
  label: string
  axis: GaugeAxis
  /** 判定する指標か（false は位置の記録のみ） */
  judged: boolean
  metric: ComputedMetric
  cell: number | null
  pastCell: number | null
  past?: ComputedMetric
  /** 向きの短い説明。ばらつきの範囲内なら空 */
  tag: string
}

/** 面ごとのゲージの行。並びは指標の定義順、判定する指標を先に */
export function gaugeRows(metrics: ComputedMetric[], plane: Plane, past?: ComputedMetric[]): GaugeRow[] {
  const pastMap = new Map((past ?? []).map((m) => [m.key, m]))
  const rows: GaugeRow[] = []
  for (const m of metrics) {
    if (m.plane !== plane) continue
    const spec = SPECS[m.key]
    if (!spec || m.status === 'unsupported') continue
    const cell = gaugeCell(m)
    const axis = GAUGE_AXES[spec.axis]
    const p = pastMap.get(m.key)
    let tag = ''
    if (cell !== null && cell !== 0) tag = spec.tag ? spec.tag(m.rawValue!) : cell < 0 ? axis.left : axis.right
    rows.push({
      key: m.key,
      label: spec.short ?? m.label,
      axis,
      judged: m.status !== 'descriptive',
      metric: m,
      cell,
      pastCell: gaugeCell(p),
      past: p,
      tag,
    })
  }
  return [...rows.filter((r) => r.judged), ...rows.filter((r) => !r.judged)]
}

/** 読み上げ用の説明 */
export function gaugeDescription(r: GaugeRow, value: string, pastName = '前回'): string {
  if (r.cell === null) return `${r.label}: 評価できませんでした`
  const where =
    r.cell === 0
      ? `${value}、測定のばらつきの範囲内`
      : `${r.tag}へ${value}、ばらつきを超える差（外側へ 3 段階のうち ${Math.abs(r.cell)}）`
  const past = r.pastCell === null ? '' : `。${pastName}は${r.pastCell === 0 ? 'ばらつきの範囲内' : `${r.pastCell < 0 ? r.axis.left : r.axis.right}側の ${Math.abs(r.pastCell)} 段階目`}`
  return `${r.label}: ${where}${past}`
}
