import { useMemo, useState } from 'react'
import type { PlannedRoutine, Slot } from '../domain/types'
import { buildPlan } from '../domain/recommend/engine'
import { compareSessions } from '../domain/compare'
import { ROUTINES, routineById } from '../domain/recommend/routines'
import { localDateKey } from '../domain/format'
import { useCheckins, useLogs, useProfile, useSessions } from '../data/hooks'
import { RoutineItem, categoryLabel } from '../components/RoutineItem'
import { ButtonLink, Notice, Screen, SectionTitle, Segmented } from '../components/ui'

const SETS: { slot: Slot; label: string }[] = [
  { slot: 'set3', label: '3 分' },
  { slot: 'set5', label: '5 分' },
  { slot: 'set10', label: '10 分' },
]

export function Move() {
  const sessions = useSessions()
  const profile = useProfile()
  const logs = useLogs()
  const checkins = useCheckins()
  const [set, setSet] = useState<Slot>('set5')
  const [showAll, setShowAll] = useState(false)

  const latest = sessions?.[0]
  const comparison = useMemo(() => (sessions && sessions.length >= 2 ? compareSessions(sessions[1], sessions[0]) : undefined), [sessions])
  const todayCheckin = checkins?.filter((c) => localDateKey(new Date(c.date)) === localDateKey()).at(-1)
  const plan = useMemo(
    () =>
      buildPlan({
        traits: latest?.postureTraits ?? [],
        profile: profile ?? undefined,
        comparison,
        recentLogs: logs?.slice(-30),
        fatigue: todayCheckin?.fatigueRating ?? checkins?.at(-1)?.fatigueRating,
        basedOnAssessmentId: latest?.id,
        lastAssessmentAt: latest?.createdAt,
      }),
    [latest, profile, comparison, logs, todayCheckin, checkins],
  )
  const bySlot = (slot: Slot) => plan.routines.filter((r) => r.slot === slot)
  const today = bySlot('today')[0]
  const total = (list: PlannedRoutine[]) => list.reduce((t, r) => t + (routineById(r.routineId)?.durationMin ?? 0), 0)
  const doneToday = new Set(logs?.filter((l) => localDateKey(new Date(l.date)) === localDateKey()).map((l) => l.routineId))

  return (
    <Screen title="運動・ストレッチ">
      {!latest && (
        <Notice tone="info" title="測定前の提案です">
          まだ測定がないため、目的と気になる部位から選んでいます。測定すると、姿勢の特徴に合わせた提案に変わります。
        </Notice>
      )}

      {today && (
        <section aria-labelledby="today" className="mt-4 rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
          <h2 id="today" className="text-sm font-medium text-ink-3">
            今日のおすすめ
          </h2>
          <p className="mt-1 text-[21px] leading-snug font-bold">{routineById(today.routineId)?.name}</p>
          <p className="mt-1 text-[15px] text-ink-2">{today.reasons[0]}</p>
          <ButtonLink to={`/move/${today.routineId}`} variant="primary" size="lg" block className="mt-4">
            {doneToday.has(today.routineId) ? 'もう一度やる' : '始める'}（{routineById(today.routineId)?.durationMin} 分）
          </ButtonLink>
        </section>
      )}

      <SectionTitle sub="時間に合わせて、組み合わせを選べます">時間で選ぶ</SectionTitle>
      <Segmented legend="時間" value={set} onChange={setSet} options={SETS.map((s) => ({ value: s.slot, label: s.label }))} />
      <p className="-mt-2 mb-1 text-sm text-ink-3 num">合計 {total(bySlot(set))} 分</p>
      <ul className="divide-y divide-line border-y border-line">
        {bySlot(set).map((r) => (
          <RoutineItem key={r.routineId} plan={r} />
        ))}
      </ul>

      {bySlot('priority').length > 0 && (
        <>
          <SectionTitle sub={comparison ? '最新の測定と、前回からの変化から選んでいます' : '最新の測定結果から選んでいます'}>測定結果からの優先メニュー</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {bySlot('priority').map((r) => (
              <RoutineItem key={r.routineId} plan={r} />
            ))}
          </ul>
        </>
      )}

      <SectionTitle sub="呼吸やゆるいストレッチなど、負担の少ないもの">疲れている日に</SectionTitle>
      <ul className="divide-y divide-line border-y border-line">
        {bySlot('tired').map((r) => (
          <RoutineItem key={r.routineId} plan={r} />
        ))}
      </ul>

      <SectionTitle sub="何もできない日でも、これだけ">続けやすい最小メニュー</SectionTitle>
      <ul className="divide-y divide-line border-y border-line">
        {bySlot('minimal').map((r) => (
          <RoutineItem key={r.routineId} plan={r} />
        ))}
      </ul>

      {plan.habitSuggestions.length > 0 && (
        <>
          <SectionTitle>日常の習慣</SectionTitle>
          <ul className="space-y-2">
            {plan.habitSuggestions.map((h) => (
              <li key={h.id} className="rule-action pl-3">
                <p>{h.text}</p>
                <p className="text-sm text-ink-3">{h.reason}</p>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionTitle>すべてのメニュー</SectionTitle>
      {showAll ? (
        <ul className="divide-y divide-line border-y border-line">
          {ROUTINES.map((r) => (
            <RoutineItem key={r.id} plan={{ routineId: r.id, reasons: [r.summary] }} />
          ))}
        </ul>
      ) : (
        <button type="button" onClick={() => setShowAll(true)} className="min-h-11 text-[15px] text-measure underline">
          {ROUTINES.length} 種類のメニューをすべて表示（{[...new Set(ROUTINES.map((r) => categoryLabel(r.category)))].join('・')}）
        </button>
      )}
      <p className="mt-6 text-sm text-ink-3">
        メニューは一般的な低負荷のものです。痛み・しびれ・めまいが出たら中止し、続く場合は医療機関に相談してください。メニューの内容は専門家の監修を受けていません。
      </p>
    </Screen>
  )
}
