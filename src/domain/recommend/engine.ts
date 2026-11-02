// ルールベースの運動・習慣の提案。すべての提案に「なぜおすすめか」を付ける
import type {
  HabitSuggestion,
  PlannedRoutine,
  PostureTrait,
  Rating,
  RecommendationPlan,
  Routine,
  RoutineLog,
  Slot,
  TraitKey,
  UserProfile,
} from '../types'
import type { Comparison } from '../compare'
import { METRIC_TO_TRAIT } from '../compare'
import { AREA_LABELS, GOAL_LABELS } from '../format'
import { TRAIT_LABELS } from '../traits'
import { newId } from '../session'
import { ROUTINES } from './routines'

export interface RecommendInput {
  traits: PostureTrait[]
  profile?: UserProfile
  comparison?: Comparison
  recentLogs?: RoutineLog[]
  /** 直近のコンディション記録の疲労感（なければプロフィールの値） */
  fatigue?: Rating
  basedOnAssessmentId?: string
  lastAssessmentAt?: string
  now?: Date
  routines?: Routine[]
}

export interface ScoredRoutine {
  routine: Routine
  score: number
  traitScore: number
  reasons: string[]
}

function isTired(input: RecommendInput): boolean {
  const f = input.fatigue ?? input.profile?.fatigueRating
  return (f ?? 0) >= 4
}

/** 比較で差が広がった / 残っている特徴 */
function comparisonTraitWeights(c: Comparison | undefined): Map<TraitKey, { weight: number; reason: string }> {
  const out = new Map<TraitKey, { weight: number; reason: string }>()
  if (!c) return out
  const afterTraits = new Map(c.after.postureTraits.map((t) => [t.key, t]))
  for (const ch of c.changes) {
    const trait = METRIC_TO_TRAIT[ch.key]
    if (!trait) continue
    if (ch.change === 'worsened') {
      out.set(trait, { weight: 1.5, reason: `前回より「${ch.label}」の差が大きくなっています` })
    } else if (ch.change === 'stable' && afterTraits.get(trait)?.status === 'noticeable' && !out.has(trait)) {
      out.set(trait, { weight: 0.75, reason: `「${ch.label}」は前回から大きく変わっていません` })
    }
  }
  return out
}

export function scoreRoutines(input: RecommendInput): ScoredRoutine[] {
  const routines = input.routines ?? ROUTINES
  const profile = input.profile
  const noticeable = input.traits.filter((t) => t.status === 'noticeable')
  const cmp = comparisonTraitWeights(input.comparison)
  const tired = isTired(input)
  const experience = profile?.exerciseExperience
  const recentCounts = new Map<string, number>()
  for (const l of input.recentLogs ?? []) recentCounts.set(l.routineId, (recentCounts.get(l.routineId) ?? 0) + 1)

  return routines
    .map((r) => {
      let score = 0
      let traitScore = 0
      const reasons: string[] = []

      for (const t of noticeable) {
        if (r.targetTags.includes(t.key)) {
          const s = 1 + t.magnitude
          score += s
          traitScore += s
          reasons.push(`測定で「${t.label}」が見られました`)
        }
      }
      for (const [trait, w] of cmp) {
        if (r.targetTags.includes(trait)) {
          score += w.weight
          traitScore += w.weight
          reasons.push(w.reason)
        }
      }
      for (const area of profile?.concernAreas ?? []) {
        if (r.targetTags.includes(area) || (area === 'whole_body' && r.targetTags.includes('general'))) {
          score += 1
          reasons.push(`気になる部位「${AREA_LABELS[area]}」に関係します`)
        }
      }
      for (const g of profile?.goals ?? []) {
        if ((g === 'diet' || g === 'body_make' || g === 'health') && r.targetTags.includes('activity')) {
          score += g === 'health' ? 0.5 : 1
          reasons.push(`目的「${GOAL_LABELS[g]}」に向けて体を動かす量を増やします`)
        }
        if ((g === 'posture' || g === 'appearance') && (r.category === 'posture_tip' || r.category === 'mobility')) {
          score += 0.5
          reasons.push(`目的「${GOAL_LABELS[g]}」に関係します`)
        }
        if (g === 'relieve_discomfort' && (r.category === 'stretch' || r.category === 'mobility')) {
          score += 0.5
          reasons.push(`目的「${GOAL_LABELS[g]}」に向けて、こわばりをゆるめます`)
        }
        if (g === 'fatigue' && (r.category === 'breathing' || r.targetTags.includes('recovery'))) {
          score += 1
          reasons.push(`目的「${GOAL_LABELS[g]}」に向けて、体を休める時間をつくります`)
        }
      }
      if (r.targetTags.includes('general')) score += 0.3
      if (experience === 'none' || experience === undefined) {
        if (r.difficulty === 3) score -= 3
        if (r.difficulty === 2) score -= 0.5
      }
      if (tired) {
        if (r.category === 'breathing' || r.targetTags.includes('recovery')) {
          score += 1
          reasons.push('疲れている日にも負担の少ないメニューです')
        }
        if (r.category === 'light_exercise' && r.difficulty >= 2) score -= 1
      }
      // 同じメニューばかりにならないよう、最近よく行ったものは少し下げる
      score -= Math.min(0.6, (recentCounts.get(r.id) ?? 0) * 0.15)
      return { routine: r, score: Math.round(score * 100) / 100, traitScore, reasons: [...new Set(reasons)] }
    })
    .sort((a, b) => b.score - a.score || a.routine.durationMin - b.routine.durationMin || a.routine.id.localeCompare(b.routine.id))
}

/** 合計時間が target 分以下になるように、同じカテゴリが偏らないよう選ぶ */
export function packSet(scored: ScoredRoutine[], targetMin: number): ScoredRoutine[] {
  const picked: ScoredRoutine[] = []
  let total = 0
  const perCategory = new Map<string, number>()
  for (const s of scored) {
    if (total + s.routine.durationMin > targetMin) continue
    const n = perCategory.get(s.routine.category) ?? 0
    if (n >= 2) continue
    picked.push(s)
    total += s.routine.durationMin
    perCategory.set(s.routine.category, n + 1)
    if (total >= targetMin) break
  }
  return picked
}

function plan(s: ScoredRoutine, slot: Slot, extraReason?: string): PlannedRoutine {
  const reasons = (extraReason ? [extraReason, ...s.reasons] : s.reasons).slice(0, 3)
  return {
    routineId: s.routine.id,
    slot,
    score: s.score,
    reasons: reasons.length ? reasons : ['どなたでも取り入れやすい基本のメニューです'],
  }
}

export function buildPlan(input: RecommendInput): RecommendationPlan {
  const now = input.now ?? new Date()
  const scored = scoreRoutines(input)
  const routines: PlannedRoutine[] = []

  if (scored[0]) routines.push(plan(scored[0], 'today'))
  for (const [slot, min] of [
    ['set3', 3],
    ['set5', 5],
    ['set10', 10],
  ] as const) {
    for (const s of packSet(scored, min)) routines.push(plan(s, slot))
  }
  // 疲れている日: 呼吸・回復向けを先に、次に軽いストレッチ
  const restful = (x: ScoredRoutine) => x.routine.category === 'breathing' || x.routine.targetTags.includes('recovery')
  const gentle = scored
    .filter((x) => x.routine.difficulty === 1 && (restful(x) || x.routine.category === 'stretch'))
    .sort((a, b) => Number(restful(b)) - Number(restful(a)) || b.score - a.score)
  for (const s of packSet(gentle, 5)) routines.push(plan(s, 'tired', '疲れている日でも負担の少ないメニューです'))
  const minimal = scored.find((s) => s.routine.durationMin <= 1) ?? [...scored].sort((a, b) => a.routine.durationMin - b.routine.durationMin)[0]
  if (minimal) routines.push(plan(minimal, 'minimal', '1 分ほどでできる、続けやすい最小メニューです'))
  for (const s of scored.filter((x) => x.traitScore > 0).slice(0, 3)) routines.push(plan(s, 'priority'))

  return {
    id: newId('p'),
    generatedAt: now.toISOString(),
    basedOnAssessmentId: input.basedOnAssessmentId,
    basedOnComparison: input.comparison ? { a: input.comparison.before.id, b: input.comparison.after.id } : undefined,
    goalTags: input.profile?.goals ?? [],
    routines,
    habitSuggestions: habitSuggestions(input),
    reviewTiming: reviewTiming(input.lastAssessmentAt, now),
  }
}

/** 比較画面の「次の提案」: 継続推奨 / 強化したい / 回復優先 */
export function comparisonSuggestions(
  comparison: Comparison,
  logs: RoutineLog[],
  input: Omit<RecommendInput, 'comparison' | 'traits'>,
): { continue: PlannedRoutine[]; strengthen: PlannedRoutine[]; recovery: PlannedRoutine[] } {
  const routines = input.routines ?? ROUTINES
  const from = comparison.before.createdAt
  const to = comparison.after.createdAt
  const counts = new Map<string, number>()
  for (const l of logs) if (l.date >= from && l.date <= to) counts.set(l.routineId, (counts.get(l.routineId) ?? 0) + 1)

  const improvedOrStable = new Set<TraitKey>()
  const needsWork = new Set<TraitKey>()
  for (const ch of comparison.changes) {
    const t = METRIC_TO_TRAIT[ch.key]
    if (!t) continue
    if (ch.change === 'improved' || ch.change === 'stable') improvedOrStable.add(t)
    if (ch.change === 'worsened') needsWork.add(t)
  }
  for (const t of comparison.after.postureTraits) if (t.status === 'noticeable') needsWork.add(t.key)

  const cont: PlannedRoutine[] = []
  for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const r = routines.find((x) => x.id === id)
    if (!r) continue
    const related = r.targetTags.filter((t): t is TraitKey => improvedOrStable.has(t as TraitKey))
    cont.push({
      routineId: id,
      slot: 'continue',
      score: n,
      reasons: [
        `この期間に ${n} 回行いました`,
        ...(related.length ? [`関連する「${TRAIT_LABELS[related[0]]}」は改善傾向か横ばいです`] : []),
      ],
    })
    if (cont.length >= 3) break
  }

  const scored = scoreRoutines({ ...input, traits: comparison.after.postureTraits, comparison })
  const strengthen = scored
    .filter((s) => s.routine.targetTags.some((t) => needsWork.has(t as TraitKey)) && !counts.has(s.routine.id))
    .slice(0, 3)
    .map((s) => plan(s, 'strengthen'))

  const recovery = scored
    .filter((s) => s.routine.category === 'breathing' || s.routine.targetTags.includes('recovery'))
    .slice(0, 2)
    .map((s) => plan(s, 'recovery', isTired({ ...input, traits: [] }) ? '疲れが強い時期は、回復を優先しましょう' : '疲れを感じた日のための選択肢です'))

  return { continue: cont, strengthen, recovery }
}

export function habitSuggestions(input: RecommendInput): HabitSuggestion[] {
  const p = input.profile
  const out: HabitSuggestion[] = []
  const add = (id: string, text: string, reason: string) => out.push({ id, text, reason })
  if (p?.lifestyle.includes('desk_work')) add('desk_break', '30〜60 分に一度は立ち上がり、肩を回したり少し歩いたりする', 'デスクワークが中心とのことなので')
  if (p?.lifestyle.includes('smartphone_long')) add('phone_height', 'スマホを見るときは、画面を目の高さに近づけて持つ', 'スマホを見る時間が長いとのことなので')
  if (p?.lifestyle.includes('bag_one_side')) add('bag_switch', 'かばんを持つ側をときどき入れ替える', 'かばんを片側で持つことが多いとのことなので')
  if (p?.lifestyle.includes('crossed_legs')) add('legs_switch', '脚を組んだら反対側でも組む、両足を床につける時間をつくる', '脚を組むことが多いとのことなので')
  if (p?.lifestyle.includes('standing_work')) add('stand_soft', '立っているときは膝を軽くゆるめ、両足に体重をのせる', '立ち仕事が多いとのことなので')
  if (p?.lifestyle.includes('driving')) add('car_seat', '運転前に背もたれを起こし、頭がヘッドレストに近づく位置に座る', '車の運転が多いとのことなので')
  if ((p?.sleepRating ?? 0) >= 4) add('sleep', '寝る前の画面時間を少し減らし、起きる時間をそろえる（眠れない状態が続くときは医療機関に相談を）', '睡眠の自己評価から')
  if (p?.activityLevel === 'low') add('walk_more', '階段を使う・ひと駅分歩くなど、歩く時間を少し足す', '日常の活動量が少なめとのことなので')
  if (isTired(input)) add('rest_day', '疲れている日は、呼吸と軽いストレッチだけでも十分です', '疲れやすさの記録から')
  add('same_conditions', '再測定は前回と同じ時間帯・服装・場所で行う', '比較の精度を上げるため')
  return out
}

export function reviewTiming(lastAt: string | undefined, now: Date): RecommendationPlan['reviewTiming'] {
  const days = 14
  if (!lastAt) return { days, text: '最初の測定から 2 週間後に再測定すると、変化を比べやすくなります。' }
  const next = new Date(new Date(lastAt).getTime() + days * 86400000)
  const remain = Math.ceil((next.getTime() - now.getTime()) / 86400000)
  const date = `${next.getMonth() + 1}月${next.getDate()}日`
  if (remain <= 0) return { days, text: `前回の測定から 2 週間たちました。同じ条件で再測定してみましょう。` }
  return { days, text: `${date}ごろ（あと ${remain} 日）に、前回と同じ時間帯・服装・場所で再測定すると変化を比べやすくなります。` }
}
