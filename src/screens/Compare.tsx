import { lazy, Suspense, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Box, Camera, ChevronRight } from 'lucide-react'
import type { AssessmentSession, MetricKey, Plane } from '../domain/types'
import { behaviorBetween, compareSessions, type Comparison } from '../domain/compare'
import { comparisonSuggestions, reviewTiming } from '../domain/recommend/engine'
import { routineById } from '../domain/recommend/routines'
import { confidenceLabel, fmtDate, fmtShortDate, fmtValue } from '../domain/format'
import { correctedSet } from '../domain/session'
import { gaugeRows } from '../domain/gauge'
import { useCheckins, useLogs, useProfile, useSessions } from '../data/hooks'
import { ChangeLabel } from '../components/ChangeLabel'
import { PhotoWithPose, PostureGrid, useStoredImageUrl } from '../components/PoseViews'
import { RoutineItem } from '../components/RoutineItem'
import { GaugeTable } from '../components/Gauge'
import { Badge, ButtonLink, EmptyState, Notice, Screen, SectionTitle, Segmented, cx } from '../components/ui'

const TrendChart = lazy(() => import('../components/TrendChart'))

type Mode = 'latest' | 'pick_one' | 'pick_two' | 'trend'

export function Compare() {
  const sessions = useSessions()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>(params.get('a') && params.get('b') ? 'pick_two' : 'latest')

  if (sessions === undefined) return <Screen title="比較">{null}</Screen>
  if (sessions.length < 2) {
    return (
      <Screen title="比較">
        <EmptyState
          title={sessions.length === 0 ? 'まだ測定がありません' : '2 回目の測定で比べられます'}
          action={
            <ButtonLink to="/measure" variant="primary" size="lg" block icon={<Camera aria-hidden className="size-5" />}>
              {sessions.length === 0 ? '最初の測定をする' : '測定する'}
            </ButtonLink>
          }
        >
          {sessions.length === 0
            ? '正面と横向きの写真を撮ると、姿勢の記録が始まります。'
            : '前回と同じ時間帯・服装・場所で測ると、変化を比べやすくなります。おすすめは前回から 2 週間後です。'}
        </EmptyState>
      </Screen>
    )
  }

  const latest = sessions[0]
  const byId = (id: string | null) => sessions.find((s) => s.id === id)
  let a: AssessmentSession | undefined
  let b: AssessmentSession | undefined
  if (mode === 'latest') {
    a = sessions[1]
    b = latest
  } else if (mode === 'pick_one') {
    a = byId(params.get('a')) ?? sessions[1]
    b = latest
  } else if (mode === 'pick_two') {
    a = byId(params.get('a')) ?? sessions[1]
    b = byId(params.get('b')) ?? latest
  }
  const setA = (id: string) => setParams((p) => (p.set('a', id), p), { replace: true })
  const setB = (id: string) => setParams((p) => (p.set('b', id), p), { replace: true })

  return (
    <Screen title="比較">
      <Segmented
        legend="比べ方"
        columns={2}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'latest', label: '最新と前回' },
          { value: 'pick_one', label: '最新と日付を選ぶ' },
          { value: 'pick_two', label: '2 つを選ぶ' },
          { value: 'trend', label: '推移を見る' },
        ]}
      />
      {(mode === 'pick_one' || mode === 'pick_two') && (
        <div className="mb-4 grid grid-cols-2 gap-2">
          <SessionSelect label="前" sessions={sessions} value={a?.id} onChange={setA} />
          {mode === 'pick_two' ? (
            <SessionSelect label="後" sessions={sessions} value={b?.id} onChange={setB} />
          ) : (
            <div>
              <p className="mb-1.5 text-sm font-medium">後</p>
              <p className="flex min-h-12 items-center rounded-[var(--radius-control)] bg-sunken px-3 num">{fmtDate(latest.createdAt)}（最新）</p>
            </div>
          )}
        </div>
      )}

      {mode === 'trend' ? (
        <Suspense fallback={<p className="text-ink-3">グラフを読み込み中…</p>}>
          <TrendChart sessions={sessions} />
        </Suspense>
      ) : a && b && a.id !== b.id ? (
        <CompareBody a={a} b={b} />
      ) : (
        <Notice tone="info">違う日の記録を 2 つ選んでください。</Notice>
      )}
    </Screen>
  )
}

function SessionSelect({ label, sessions, value, onChange }: { label: string; sessions: AssessmentSession[]; value?: string; onChange: (id: string) => void }) {
  const id = `sel-${label}`
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-12 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 text-[16px] num">
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {fmtDate(s.createdAt, true)}
          </option>
        ))}
      </select>
    </div>
  )
}

function CompareBody({ a, b }: { a: AssessmentSession; b: AssessmentSession }) {
  const c = useMemo(() => compareSessions(a, b), [a, b])
  const logs = useLogs()
  const checkins = useCheckins()
  const profile = useProfile()
  const planes = (['front', 'side'] as Plane[]).filter((p) => c.before[p] && c.after[p])
  const [plane, setPlane] = useState<Plane>(planes[0] ?? 'front')
  const behavior = useMemo(() => behaviorBetween(c.before.createdAt, c.after.createdAt, logs ?? [], checkins ?? []), [c, logs, checkins])
  const suggestions = useMemo(
    () => comparisonSuggestions(c, logs ?? [], { profile: profile ?? undefined, fatigue: checkins?.at(-1)?.fatigueRating }),
    [c, logs, profile, checkins],
  )
  const timing = reviewTiming(c.after.createdAt, new Date())

  return (
    <>
      {/* B. サマリー */}
      <section aria-labelledby="cmp-sum" className="rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
        <p className="text-sm text-ink-3 num">
          {fmtDate(c.before.createdAt)} → {fmtDate(c.after.createdAt)}（{c.days} 日間）
        </p>
        <h2 id="cmp-sum" className="mt-1 text-[19px] leading-snug font-bold">
          {c.overall}
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="flex items-center gap-1.5"><ChangeLabel change="improved" /><span className="num">{c.counts.improved}</span></span>
          <span className="flex items-center gap-1.5"><ChangeLabel change="stable" /><span className="num">{c.counts.stable}</span></span>
          <span className="flex items-center gap-1.5"><ChangeLabel change="worsened" /><span className="num">{c.counts.worsened}</span></span>
        </div>
        {c.top.length > 0 && (
          <ol className="mt-4 space-y-2">
            {c.top.map((ch) => (
              <li key={ch.key} className="flex items-start justify-between gap-2 border-t border-line pt-2">
                <span className="text-[15px]">{ch.label}</span>
                <ChangeLabel change={ch.change} />
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-sm text-ink-3">「改善傾向」は、左右差や前後差が小さくなる方向の変化を指します。測定のばらつき（2 回分）を超えた変化だけを判定しています。</p>
      </section>
      {c.warnings.length > 0 && (
        <div className="mt-3">
          <Notice tone="warn" title="撮影条件が前回と違います">
            <ul className="list-disc space-y-1 pl-4">
              {c.warnings.map((w) => (
                <li key={w.key}>{w.message}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {/* C. ビジュアル比較 */}
      <SectionTitle>見た目の比較</SectionTitle>
      {planes.length > 1 && (
        <Segmented legend="面" columns={2} value={plane} onChange={setPlane} options={[{ value: 'front', label: '正面' }, { value: 'side', label: '横向き' }]} />
      )}
      {planes.length ? <VisualCompare c={c} plane={plane} /> : <p className="text-ink-2">同じ面の写真がないため、見た目の比較はできません。</p>}
      <ButtonLink to={`/session/${c.after.id}/3d?vs=${c.before.id}`} variant="secondary" block className="mt-3" icon={<Box aria-hidden className="size-5" />}>
        3D で重ねて見る
      </ButtonLink>

      {/* ずれの向きと大きさの比較 */}
      {planes.length > 0 && (
        <>
          <SectionTitle sub="塗りつぶしが今回、点線の枠が前回。中央の帯は測定のばらつきの範囲です">
            ずれの比較（{plane === 'front' ? '正面' : '横向き'}）
          </SectionTitle>
          <GaugeTable rows={gaugeRows(c.after.computedMetrics, plane, c.before.computedMetrics)} heightCm={profile?.heightCm} pastLegend={`前回（${fmtShortDate(c.before.createdAt)}）`} />
        </>
      )}

      {/* E. 変化の言語化 */}
      <SectionTitle sub="測定された差を言葉にしたもの。診断ではありません">変化の読み取り</SectionTitle>
      <ul className="space-y-2">
        {(c.top.length ? c.top : c.changes.slice(0, 3)).map((ch) => (
          <li key={ch.key} className="rule-fact pl-3 text-[15px]">
            {ch.sentence}
          </li>
        ))}
        {c.top.length > 0 && c.counts.stable > 0 && (
          <li className="rule-fact pl-3 text-[15px] text-ink-2">ほかの {c.counts.stable} 項目は大きく変わっていません。</li>
        )}
      </ul>

      {/* D. 数値比較 */}
      <SectionTitle sub="前 → 後、差、変化の判定、信頼度（低い方）">数値の比較</SectionTitle>
      <NumberTable c={c} />

      {/* F. 行動との関連 */}
      <SectionTitle sub="2 回の測定のあいだの記録">この期間の行動</SectionTitle>
      {behavior.logCount === 0 && behavior.checkinCount === 0 ? (
        <p className="text-ink-2">この期間の運動やコンディションの記録はありません。メニューを行ったら「やった」で記録すると、次の比較で変化と並べて見られます。</p>
      ) : (
        <dl className="grid grid-cols-2 gap-3">
          <Stat label="運動の記録" value={`${behavior.logCount} 回`} sub={`${behavior.activeDays} 日`} />
          <Stat label="疲れ（自己評価）" value={ratingChange(behavior.fatigue, behavior.checkinCount)} sub="1 疲れていない〜5 とても疲れている" />
          <Stat label="睡眠（自己評価）" value={ratingChange(behavior.sleep, behavior.checkinCount)} sub="1 よく眠れた〜5 眠れなかった" />
          <div className="rounded-[var(--radius-control)] bg-surface p-3">
            <dt className="text-sm text-ink-3">よく行ったメニュー</dt>
            <dd className="mt-1 text-[15px]">
              {behavior.topRoutines.length
                ? behavior.topRoutines.map((t) => `${routineById(t.routineId)?.name ?? t.routineId}（${t.count}）`).join('、')
                : '—'}
            </dd>
          </div>
        </dl>
      )}

      {/* G. 次の提案 */}
      <SectionTitle sub="この変化に対して、次にやること">次の提案</SectionTitle>
      <div className="rule-action space-y-5 pl-3">
        {suggestions.continue.length > 0 && <SuggestionGroup title="続けたいメニュー" items={suggestions.continue} />}
        {suggestions.strengthen.length > 0 && <SuggestionGroup title="強化したいメニュー" items={suggestions.strengthen} />}
        {suggestions.recovery.length > 0 && <SuggestionGroup title="疲れている日は回復を優先" items={suggestions.recovery} />}
        <div>
          <p className="font-bold">再測定のタイミング</p>
          <p className="text-[15px] text-ink-2">{timing.text}</p>
        </div>
      </div>
      {suggestions.strengthen[0] && (
        <ButtonLink to={`/move/${suggestions.strengthen[0].routineId}`} variant="primary" size="lg" block className="mt-6">
          優先メニューを始める
        </ButtonLink>
      )}
    </>
  )
}

function ratingChange(r: { first?: number; last?: number }, count: number): string {
  if (r.first === undefined || r.last === undefined) return '—'
  return count >= 2 ? `${r.first} → ${r.last}` : `${r.last}（記録 1 回）`
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-surface p-3">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[22px] font-medium num">{value}</dd>
      {sub && <dd className="text-xs text-ink-3">{sub}</dd>}
    </div>
  )
}

function SuggestionGroup({ title, items }: { title: string; items: { routineId: string; reasons: string[] }[] }) {
  return (
    <div>
      <p className="font-bold">{title}</p>
      <ul className="divide-y divide-line">
        {items.map((r) => (
          <RoutineItem key={r.routineId} plan={r} />
        ))}
      </ul>
    </div>
  )
}

function NumberTable({ c }: { c: Comparison }) {
  const groups: { plane: Plane; title: string }[] = [
    { plane: 'front', title: '正面' },
    { plane: 'side', title: '横向き' },
  ]
  return (
    <div className="space-y-5">
      {groups.map(({ plane, title }) => {
        const rows = c.changes.filter((x) => x.plane === plane)
        if (!rows.length) return null
        return (
          <div key={plane}>
            <h3 className="mb-1 text-sm font-bold text-ink-3">{title}</h3>
            <ul className="divide-y divide-line border-y border-line">
              {rows.map((ch) => (
                <li key={ch.key} className="py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[15px] font-medium">{ch.label}</span>
                    <ChangeLabel change={ch.change} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-[15px] num">
                    <span className="text-ink-3">{fmtValue(ch.before, ch.unit)}</span>
                    <ChevronRight aria-label="から" className="size-4 self-center text-ink-3" />
                    <span className="text-[18px] font-medium">{fmtValue(ch.after, ch.unit)}</span>
                    <span className="text-ink-2">
                      差 {ch.diff >= 0 ? '+' : ''}
                      {fmtValue(ch.diff, ch.unit)}
                    </span>
                    <span className="text-sm text-ink-3">信頼度 {confidenceLabel(ch.confidence)}</span>
                  </div>
                  {ch.beforeDirection !== ch.afterDirection && (
                    <p className="mt-0.5 text-sm text-ink-3">
                      向き: {ch.beforeDirection} → {ch.afterDirection}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {c.unavailable.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-[15px] text-measure">比べられなかった項目（{c.unavailable.length}）</summary>
          <ul className="space-y-1 pl-2 text-[15px] text-ink-2">
            {dedupe(c.unavailable).map((u) => (
              <li key={u.key}>
                {u.label}: {u.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function dedupe<T extends { key: MetricKey }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
}

function VisualCompare({ c, plane }: { c: Comparison; plane: Plane }) {
  const ra = c.before[plane]!
  const rb = c.after[plane]!
  const ua = useStoredImageUrl(ra.imageMetadata.imageId)
  const ub = useStoredImageUrl(rb.imageMetadata.imageId)
  const bothPhotos = !!ua && !!ub
  const [view, setView] = useState<'overlay' | 'side' | 'slider'>('overlay')
  const [skeleton, setSkeleton] = useState(true)
  const [corrected, setCorrected] = useState(true)
  const [pos, setPos] = useState(50)
  const anyCorrected = correctedSet(ra).size > 0 || correctedSet(rb).size > 0

  return (
    <div>
      <Segmented
        legend="表示"
        columns={3}
        value={view}
        onChange={setView}
        options={[
          { value: 'overlay', label: '骨格を重ねる' },
          { value: 'side', label: '並べる' },
          { value: 'slider', label: 'スライダー' },
        ]}
      />
      {view === 'overlay' && (
        <>
          <PostureGrid current={rb} past={ra} useCorrected={corrected} label={`前回（破線）と今回（実線）の骨格を、足首の位置と体の高さでそろえて重ねた図`} />
          <p className="mt-2 flex items-center gap-4 text-sm text-ink-2">
            <span className="flex items-center gap-1.5"><svg aria-hidden width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="var(--color-past)" strokeWidth="2" strokeDasharray="5 4" /></svg>前 {fmtShortDate(c.before.createdAt)}</span>
            <span className="flex items-center gap-1.5"><svg aria-hidden width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" stroke="var(--color-ink)" strokeWidth="2.5" /></svg>後 {fmtShortDate(c.after.createdAt)}</span>
          </p>
        </>
      )}
      {view === 'side' && (
        <div className="grid grid-cols-2 gap-2">
          <figure>
            <PhotoWithPose record={ra} imageUrl={ua} useCorrected={corrected} showSkeleton={skeleton} alt={`前回（${fmtShortDate(c.before.createdAt)}）`} />
            <figcaption className="mt-1 text-center text-sm text-ink-3 num">前 {fmtShortDate(c.before.createdAt)}</figcaption>
          </figure>
          <figure>
            <PhotoWithPose record={rb} imageUrl={ub} useCorrected={corrected} showSkeleton={skeleton} alt={`今回（${fmtShortDate(c.after.createdAt)}）`} />
            <figcaption className="mt-1 text-center text-sm text-ink-3 num">後 {fmtShortDate(c.after.createdAt)}</figcaption>
          </figure>
        </div>
      )}
      {view === 'slider' &&
        (bothPhotos ? (
          <div>
            <div className="relative">
              <PhotoWithPose record={ra} imageUrl={ua} useCorrected={corrected} showSkeleton={skeleton} alt="前回の写真" />
              <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
                <PhotoWithPose record={rb} imageUrl={ub} useCorrected={corrected} showSkeleton={skeleton} alt="今回の写真" className="h-full" />
              </div>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-level" style={{ left: `${pos}%` }} />
            </div>
            <label className="mt-2 block text-sm text-ink-2">
              <span className="flex justify-between num">
                <span>前 {fmtShortDate(c.before.createdAt)}</span>
                <span>後 {fmtShortDate(c.after.createdAt)}</span>
              </span>
              <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} className="mt-1 w-full accent-[var(--color-ink)]" aria-label="前と後の境目の位置" />
            </label>
            <p className="text-sm text-ink-3">撮影ごとに立ち位置が少し違うため、写真がずれて見えることがあります。</p>
          </div>
        ) : (
          <Notice tone="info">どちらかの写真が保存されていないため、スライダー比較はできません。「骨格を重ねる」で比べられます。</Notice>
        ))}
      <div className={cx('mt-2 flex flex-wrap gap-x-4')}>
        {view !== 'overlay' && (
          <label className="flex min-h-11 items-center gap-2 text-[15px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={skeleton} onChange={(e) => setSkeleton(e.target.checked)} />
            骨格を表示
          </label>
        )}
        {anyCorrected && (
          <label className="flex min-h-11 items-center gap-2 text-[15px]">
            <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={!corrected} onChange={(e) => setCorrected(!e.target.checked)} />
            補正前で比べる
          </label>
        )}
      </div>
      <p className="mt-1">
        <Link to={`/session/${c.after.id}`} className="text-[15px] text-measure underline">
          今回の結果を開く
        </Link>
        <Badge>{c.after.imagesSaved ? '写真あり' : '写真なし'}</Badge>
      </p>
    </div>
  )
}
