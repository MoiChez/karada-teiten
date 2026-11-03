// 結果画面の「いつもの姿勢と意識した姿勢」。事実（比較）→ 仮説 → 提案（意識づけ / 体を動かす）の順に分けて示す
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { Camera, PencilRuler, PersonStanding } from 'lucide-react'
import type { AssessmentSession, Plane, RoutineLog, TraitKey, UserProfile } from '../domain/types'
import { CONSCIOUS_EFFECT_LABELS, compareConscious, isAdjustEffect, isBodyEffect, isHabitEffect, type ConsciousEffect, type ConsciousItem } from '../domain/conscious'
import { gaugeRows } from '../domain/gauge'
import { fmtDate } from '../domain/format'
import { habitSuggestions, scoreRoutines } from '../domain/recommend/engine'
import { correctedSet } from '../domain/session'
import { useDraft } from '../state/stores'
import { GaugeTable } from './Gauge'
import { BurstNote } from './BurstNote'
import { PhotoWithPose, PostureGrid, useStoredImageUrl } from './PoseViews'
import { RoutineItem } from './RoutineItem'
import { Badge, Button, ButtonLink, SectionTitle, cx } from './ui'

const TONE: Record<ConsciousEffect, 'good' | 'measure' | 'neutral' | 'attention'> = {
  resolved: 'good',
  reduced: 'measure',
  remains: 'neutral',
  increased: 'attention',
  overshoot: 'attention',
}

const PLANE_NAME: Record<Plane, string> = { front: '正面', side: '横向き' }

export function ConsciousSection({
  s,
  plane,
  heightCm,
  profile,
  logs,
}: {
  s: AssessmentSession
  plane: Plane
  heightCm?: number
  profile?: UserProfile
  logs?: RoutineLog[]
}) {
  const navigate = useNavigate()
  const startConscious = useDraft((d) => d.startConscious)
  const draft = useDraft((d) => d.conscious)
  const cmp = useMemo(() => compareConscious(s), [s])
  const c = s.conscious
  const cRec = c?.[plane]
  const hRec = s[plane]
  const storedUrl = useStoredImageUrl(cRec?.imageMetadata.imageId)
  const imageUrl = storedUrl ?? (draft.sessionId === s.id ? draft[plane]?.imageUrl : undefined) ?? null
  const firstPlane: Plane = s.front ? 'front' : 'side'

  const start = () => {
    startConscious(s.id)
    navigate(`/measure/conscious/capture/${firstPlane}`)
  }

  const suggestions = useMemo(() => {
    if (!cmp) return null
    const habitTraits = new Set<TraitKey>()
    const bodyTraits = new Set<TraitKey>()
    for (const it of cmp.items) {
      if (!it.trait) continue
      if (isHabitEffect(it.effect) || isAdjustEffect(it.effect)) habitTraits.add(it.trait)
      if (isBodyEffect(it.effect)) bodyTraits.add(it.trait)
    }
    const scored = scoreRoutines({ traits: s.postureTraits, profile, recentLogs: logs?.slice(-30), conscious: cmp })
    const pick = (cats: string[], traits: Set<TraitKey>, n: number) =>
      scored
        .filter((x) => cats.includes(x.routine.category) && x.routine.targetTags.some((t) => traits.has(t as TraitKey)))
        .slice(0, n)
        .map((x) => ({ routineId: x.routine.id, reasons: [...x.reasons.filter((r) => r.includes('意識')), ...x.reasons.filter((r) => !r.includes('意識'))] }))
    return {
      awareness: pick(['posture_tip'], habitTraits, 2),
      body: pick(['stretch', 'mobility', 'light_exercise'], bodyTraits, 3),
      habits: habitSuggestions({ traits: s.postureTraits, conscious: cmp }).filter((h) => h.id.startsWith('conscious_')),
      hasHabit: habitTraits.size > 0,
      hasBody: bodyTraits.size > 0,
    }
  }, [cmp, s, profile, logs])

  if (!s.front?.landmarksRaw.length && !s.side?.landmarksRaw.length) return null

  if (!c || !cmp) {
    return (
      <section id="conscious" aria-labelledby="conscious-h" className="mt-8 rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
        <h2 id="conscious-h" className="flex items-center gap-2 text-[17px] font-bold">
          <PersonStanding aria-hidden className="size-5 text-measure" />
          意識した姿勢でも撮って比べる
        </h2>
        <p className="mt-2 text-[15px] text-ink-2">
          自分が良いと思う姿勢でも撮ると、今回の差が「意識すれば変えられる差」か「意識しても残る差」かが分かります。提案も、ふだんの意識づけと、体を動かすメニューに分けて出します。
        </p>
        <p className="mt-1 text-sm text-ink-3">いつもの姿勢を撮った直後に、同じ場所・同じ端末の置き方で撮ってください。</p>
        <Button className="mt-3" variant="secondary" block icon={<Camera aria-hidden className="size-5" />} onClick={start}>
          意識した姿勢を撮る
        </Button>
      </section>
    )
  }

  const rows = gaugeRows(c.computedMetrics, plane, s.computedMetrics)
  const habit = cmp.items.filter((i) => isHabitEffect(i.effect))
  const body = cmp.items.filter((i) => i.effect === 'remains')
  const adjust = cmp.items.filter((i) => isAdjustEffect(i.effect))
  const names = (list: ConsciousItem[]) => `「${[...new Set(list.map((i) => i.label))].slice(0, 2).join('」「')}」${list.length > 2 ? 'など' : ''}`
  const canEdit = !!imageUrl && !!cRec?.landmarksRaw.length

  return (
    <section id="conscious" aria-labelledby="conscious-h">
      <SectionTitle id="conscious-h" sub={`自分が良いと思う姿勢（${fmtDate(c.capturedAt, true)}に撮影）と、いつもの姿勢の違いです`}>
        いつもの姿勢と意識した姿勢
      </SectionTitle>

      {/* 図 */}
      {cRec && cRec.landmarksRaw.length > 0 ? (
        <>
          <div className={cx('grid gap-3', imageUrl ? 'grid-cols-2' : 'mx-auto max-w-[300px] grid-cols-1')}>
            {imageUrl && <PhotoWithPose record={cRec} imageUrl={imageUrl} alt={`意識した姿勢（${PLANE_NAME[plane]}）の写真と骨格`} />}
            <PostureGrid current={cRec} past={hRec} label={`意識した姿勢（実線）と、いつもの姿勢（破線）を体の高さでそろえて重ねた図（${PLANE_NAME[plane]}）`} />
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-3">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0 w-5 border-t-[2.5px] border-ink" />
              意識した姿勢
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-dashed border-past" />
              いつもの姿勢
            </span>
          </p>
          <BurstNote rec={cRec} heightCm={heightCm} />
          <div className="mt-4">
            <GaugeTable rows={rows} heightCm={heightCm} pastLegend="いつもの姿勢" currentLegend="意識した姿勢" />
          </div>
        </>
      ) : (
        <p className="text-ink-2">意識した姿勢は{PLANE_NAME[plane]}を撮っていません。</p>
      )}

      {/* 事実 */}
      <h3 className="mt-6 text-[15px] font-bold">比べて分かったこと</h3>
      {cmp.items.length ? (
        <ul className="mt-2 space-y-2">
          {cmp.items.map((it) => (
            <li key={it.key} className="rule-fact pl-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="font-medium">{it.label}</p>
                <Badge tone={TONE[it.effect]}>{CONSCIOUS_EFFECT_LABELS[it.effect]}</Badge>
                {cmp.planes.length > 1 && <span className="text-xs text-ink-3">{PLANE_NAME[it.plane]}</span>}
              </div>
              <p className="mt-0.5 text-[15px] text-ink-2 num">{it.sentence}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-ink-2">どちらの姿勢でも、ばらつきを超える差のある項目はありませんでした。</p>
      )}
      {cmp.items.length > 0 && cmp.quietCount > 0 && (
        <p className="mt-2 text-sm text-ink-3">ほかの {cmp.quietCount} 項目は、どちらの姿勢でも測定のばらつきの範囲内でした。</p>
      )}
      {cmp.shifts.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-ink-3">位置の記録（良し悪しは判定しません）</p>
          <ul className="mt-1 space-y-1 text-[15px] text-ink-2 num">
            {cmp.shifts.map((x) => (
              <li key={x.key}>{x.sentence}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 仮説 */}
      {(habit.length > 0 || body.length > 0 || adjust.length > 0) && (
        <>
          <h3 className="mt-6 text-[15px] font-bold">考えられること（仮説）</h3>
          <ul className="mt-2 space-y-2">
            {habit.length > 0 && (
              <li className="rule-hypothesis pl-3 text-[15px]">
                {names(habit)}は、意識すると小さくなりました。ふだんの立ち方のくせが関係している可能性があります。意識すれば変えられる差です。
              </li>
            )}
            {body.length > 0 && (
              <li className="rule-hypothesis pl-3 text-[15px]">
                {names(body)}は、意識しても変わりにくい差でした。体の動かしやすさ（柔軟性や筋力）、骨格の個人差、意識の向け方など、いくつかの可能性があり、この結果だけでは理由は分かりません。
              </li>
            )}
            {adjust.length > 0 && (
              <li className="rule-hypothesis pl-3 text-[15px]">
                {names(adjust)}は、意識すると差が大きくなるか、反対の向きになりました。良い姿勢をつくるときに、その部分を動かしすぎている可能性があります。
              </li>
            )}
          </ul>
        </>
      )}

      {/* 提案 */}
      {suggestions && (suggestions.hasHabit || suggestions.hasBody) && (
        <>
          <h3 className="mt-6 text-[15px] font-bold">試してみるとよいこと</h3>
          <div className="rule-action mt-2 space-y-4 pl-3">
            {suggestions.hasHabit && (
              <div>
                <p className="text-sm font-medium text-ink-3">ふだんの意識づけ（意識で変わった差）</p>
                {suggestions.habits.map((h) => (
                  <p key={h.id} className="mt-1 text-[15px]">
                    {h.text}
                    <span className="block text-sm text-ink-3">{h.reason}</span>
                  </p>
                ))}
                {suggestions.awareness.length > 0 && (
                  <ul className="divide-y divide-line">
                    {suggestions.awareness.map((r) => (
                      <RoutineItem key={r.routineId} plan={r} />
                    ))}
                  </ul>
                )}
              </div>
            )}
            {suggestions.hasBody && (
              <div>
                <p className="text-sm font-medium text-ink-3">体を動かすメニュー（意識しても残った差）</p>
                {suggestions.body.length > 0 ? (
                  <ul className="divide-y divide-line">
                    {suggestions.body.map((r) => (
                      <RoutineItem key={r.routineId} plan={r} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[15px] text-ink-2">この差に関係するメニューは、今のメニュー集にはありません。</p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <div className="mt-6 grid grid-cols-1 gap-2">
        <Button variant="secondary" block icon={<Camera aria-hidden className="size-5" />} onClick={start}>
          意識した姿勢を撮り直す
        </Button>
        {cRec && canEdit && (
          <ButtonLink to={`/session/${s.id}/edit/${plane}?pose=conscious`} variant="quiet" block icon={<PencilRuler aria-hidden className="size-5" />}>
            意識した姿勢（{PLANE_NAME[plane]}）の点を補正する{correctedSet(cRec).size > 0 ? '（補正あり）' : ''}
          </ButtonLink>
        )}
      </div>
    </section>
  )
}
