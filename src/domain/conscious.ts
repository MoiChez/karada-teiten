// 「いつもの姿勢」と「意識した姿勢」（自分が良いと思う姿勢）の比較。
// 差が意識で変わるか（意識づけで変えられる差か）、意識しても残るか（体を動かすメニューを組み合わせたい差か）を分ける。
// 変化の判定は前回との比較と同じ: |差| > K × √(σa² + σb²)
// 横向きの前後の位置（位置の記録だけにする指標）は、差が残るかどうかは言わず、意識で小さくなったか・大きくなったかだけを伝える
import type { AssessmentSession, ComputedMetric, MetricKey, Plane, TraitKey } from './types'
import { NOTICEABLE_K } from './constants'
import { METRIC_TO_TRAIT } from './compare'
import { fmtAbs } from './format'
import { isTracked, towardPhrase } from './metrics'

export type ConsciousEffect = 'resolved' | 'reduced' | 'smaller' | 'remains' | 'increased' | 'overshoot'

export const CONSCIOUS_EFFECT_LABELS: Record<ConsciousEffect, string> = {
  resolved: 'ばらつきの範囲まで小さく',
  reduced: '小さくなるが残る',
  smaller: '小さくなる',
  remains: '変わりにくい',
  increased: '大きくなる',
  overshoot: '反対の向きへ',
}

/** 意識すると小さくなる差（その立ち方の意識づけを提案する） */
export const isHabitEffect = (e: ConsciousEffect) => e === 'resolved' || e === 'reduced' || e === 'smaller'
/** 意識すると大きくなる・反対へ行く差（意識の向け方の見直しを提案する） */
export const isAdjustEffect = (e: ConsciousEffect) => e === 'increased' || e === 'overshoot'
/** 意識しても残る差（体を動かすメニューの提案につなげる） */
export const isBodyEffect = (e: ConsciousEffect) => e === 'remains' || e === 'reduced'

export interface ConsciousItem {
  key: MetricKey
  label: string
  plane: Plane
  unit: ComputedMetric['unit']
  habitual: number
  conscious: number
  effect: ConsciousEffect
  sentence: string
  trait?: TraitKey
  /** 変化の大きさ（判定の閾値の何倍か） */
  significance: number
}

export interface ConsciousShift {
  key: MetricKey
  label: string
  plane: Plane
  sentence: string
}

export interface ConsciousComparison {
  /** 判定する指標のうちどちらかに差が見られたものと、横向きの位置のうち意識で変わったもの */
  items: ConsciousItem[]
  /** 位置の記録（良し悪しを判定しない指標）で、ばらつきを超えて変わったもの */
  shifts: ConsciousShift[]
  /** どちらの姿勢でもばらつきの範囲内だった判定指標の数 */
  quietCount: number
  /** 比べられた面 */
  planes: Plane[]
}

function sentenceOf(e: ConsciousEffect, a: ComputedMetric, b: ComputedMetric): string {
  const v = `いつも ${fmtAbs(a.rawValue!, a.unit)} → 意識すると ${fmtAbs(b.rawValue!, b.unit)}`
  switch (e) {
    case 'resolved':
      return `${v}。意識すると、ばらつきの範囲まで小さくなりました。`
    case 'reduced':
      return `${v}。意識すると小さくなりましたが、差は残っています。`
    case 'smaller':
      return `${v}。意識すると小さくなりました。`
    case 'remains':
      return `${v}。意識しても、ばらつきを超える変化はありませんでした。`
    case 'increased':
      return a.status === 'noticeable' ? `${v}。意識すると、差が大きくなりました。` : `${v}。意識すると、ばらつきを超える差が出ました。`
    case 'overshoot':
      return `${v}。意識すると、反対の向きの差になりました（${b.direction}）。`
  }
}

/** 1 つの指標の比較。どちらの姿勢でも差がなければ null */
export function classifyConscious(a: ComputedMetric, b: ComputedMetric): { effect: ConsciousEffect; significance: number } | null {
  if (a.rawValue === null || b.rawValue === null) return null
  if (a.status !== 'noticeable' && b.status !== 'noticeable') return null
  const thr = Math.max(NOTICEABLE_K * Math.hypot(a.uncertainty ?? 0, b.uncertainty ?? 0), 1e-6)
  const diff = b.rawValue - a.rawValue
  const dAbs = Math.abs(b.rawValue) - Math.abs(a.rawValue)
  const flipped = Math.sign(a.rawValue) !== Math.sign(b.rawValue)
  if (a.status !== 'noticeable') {
    // いつもは差がないが、意識すると差が出た
    return Math.abs(diff) > thr ? { effect: 'increased', significance: Math.abs(diff) / thr } : null
  }
  if (flipped && b.status === 'noticeable' && Math.abs(diff) > thr) return { effect: 'overshoot', significance: Math.abs(diff) / thr }
  if (dAbs < -thr) return { effect: b.status === 'noticeable' ? 'reduced' : 'resolved', significance: -dAbs / thr }
  if (dAbs > thr) return { effect: 'increased', significance: dAbs / thr }
  return { effect: 'remains', significance: Math.abs(dAbs) / thr }
}

/** 位置の記録だけにする指標の比較。意識で変わらなければ null（差が残るとは言わない） */
export function classifyTracked(a: ComputedMetric, b: ComputedMetric): { effect: ConsciousEffect; significance: number; sentence: string } | null {
  if (a.rawValue === null || b.rawValue === null) return null
  const thr = Math.max(NOTICEABLE_K * Math.hypot(a.uncertainty ?? 0, b.uncertainty ?? 0), 1e-6)
  const diff = b.rawValue - a.rawValue
  const dAbs = Math.abs(b.rawValue) - Math.abs(a.rawValue)
  const flipped = Math.sign(a.rawValue) !== Math.sign(b.rawValue)
  const v = `いつも ${fmtAbs(a.rawValue, a.unit)} → 意識すると ${fmtAbs(b.rawValue, b.unit)}`
  if (dAbs < -thr) return { effect: 'smaller', significance: -dAbs / thr, sentence: `${v}。意識すると小さくなりました。` }
  if (dAbs > thr) {
    const sentence = flipped ? `${v}。意識すると、反対の向きに大きくなりました（${b.direction}）。` : `${v}。意識すると大きくなりました。`
    return { effect: 'increased', significance: dAbs / thr, sentence }
  }
  if (flipped && Math.abs(diff) > thr) {
    return { effect: 'overshoot', significance: Math.abs(diff) / thr, sentence: `${v}。意識すると、反対の向きになりました（${b.direction}）。` }
  }
  return null
}

export function compareConscious(s: AssessmentSession): ConsciousComparison | null {
  const c = s.conscious
  if (!c) return null
  const habitual = new Map(s.computedMetrics.map((m) => [m.key, m]))
  const items: ConsciousItem[] = []
  const shifts: ConsciousShift[] = []
  let quietCount = 0
  const planes = new Set<Plane>()
  for (const b of c.computedMetrics) {
    const a = habitual.get(b.key)
    if (!a || a.rawValue === null || b.rawValue === null) continue
    planes.add(b.plane)
    if (b.group === 'composite') continue
    if (isTracked(b.key)) {
      const r = classifyTracked(a, b)
      if (r) {
        items.push({
          key: b.key,
          label: b.label,
          plane: b.plane,
          unit: b.unit,
          habitual: a.rawValue,
          conscious: b.rawValue,
          effect: r.effect,
          sentence: r.sentence,
          trait: METRIC_TO_TRAIT[b.key],
          significance: Math.round(r.significance * 100) / 100,
        })
      }
      continue
    }
    if (b.status === 'descriptive') {
      const thr = Math.max(NOTICEABLE_K * Math.hypot(a.uncertainty ?? 0, b.uncertainty ?? 0), 1e-6)
      const diff = b.rawValue - a.rawValue
      if (Math.abs(diff) > thr) {
        shifts.push({ key: b.key, label: b.label, plane: b.plane, sentence: `${b.label}は、意識すると${towardPhrase(b.key, diff)}へ約${fmtAbs(diff, b.unit)}変わりました。` })
      }
      continue
    }
    const r = classifyConscious(a, b)
    if (!r) {
      quietCount++
      continue
    }
    items.push({
      key: b.key,
      label: b.label,
      plane: b.plane,
      unit: b.unit,
      habitual: a.rawValue,
      conscious: b.rawValue,
      effect: r.effect,
      sentence: sentenceOf(r.effect, a, b),
      trait: METRIC_TO_TRAIT[b.key],
      significance: Math.round(r.significance * 100) / 100,
    })
  }
  const planeOrder = (p: Plane) => (p === 'front' ? 0 : 1)
  items.sort((x, y) => planeOrder(x.plane) - planeOrder(y.plane) || y.significance - x.significance)
  return { items, shifts, quietCount, planes: [...planes].sort((x, y) => planeOrder(x) - planeOrder(y)) }
}

/** 特徴ごとに、意識で変わるか・意識しても残るかをまとめる（提案の重みづけ用） */
export interface TraitEffect {
  habit: string[]
  adjust: string[]
  body: string[]
}

export function consciousTraitEffects(c: ConsciousComparison | null | undefined): Map<TraitKey, TraitEffect> {
  const out = new Map<TraitKey, TraitEffect>()
  for (const it of c?.items ?? []) {
    if (!it.trait) continue
    const e = out.get(it.trait) ?? { habit: [], adjust: [], body: [] }
    if (isHabitEffect(it.effect)) e.habit.push(it.label)
    if (isAdjustEffect(it.effect)) e.adjust.push(it.label)
    if (isBodyEffect(it.effect)) e.body.push(it.label)
    out.set(it.trait, e)
  }
  return out
}
