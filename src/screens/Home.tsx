import { useMemo } from 'react'
import { Link } from 'react-router'
import { Camera, ChevronRight, Footprints, HeartPulse, Settings as SettingsIcon } from 'lucide-react'
import { compareSessions } from '../domain/compare'
import { buildPlan, reviewTiming } from '../domain/recommend/engine'
import { routineById } from '../domain/recommend/routines'
import { fmtDate, localDateKey } from '../domain/format'
import { useCheckins, useLogs, useProfile, useSessions } from '../data/hooks'
import { PostureGrid } from '../components/PoseViews'
import { ChangeLabel } from '../components/ChangeLabel'
import { ButtonLink, EmptyState, Notice, Screen, SectionTitle, cx } from '../components/ui'
import { useSettings } from '../state/stores'

const WEEK = ['月', '火', '水', '木', '金', '土', '日']

export function Home() {
  const sessions = useSessions()
  const logs = useLogs()
  const checkins = useCheckins()
  const profile = useProfile()
  const storageError = useSettings((s) => s.storageError)
  const latest = sessions?.[0]
  const prev = sessions?.[1]
  const comparison = useMemo(() => (latest && prev ? compareSessions(prev, latest) : undefined), [latest, prev])
  const todayCheckin = checkins?.filter((c) => c.date.slice(0, 10) === localDateKey()).at(-1)
  const plan = useMemo(
    () =>
      buildPlan({
        traits: latest?.postureTraits ?? [],
        profile: profile ?? undefined,
        comparison,
        recentLogs: logs?.slice(-30),
        fatigue: todayCheckin?.fatigueRating,
        lastAssessmentAt: latest?.createdAt,
      }),
    [latest, profile, comparison, logs, todayCheckin],
  )
  const today = plan.routines.find((r) => r.slot === 'today')
  const todayRoutine = today ? routineById(today.routineId) : undefined

  // 今週（月曜はじまり）に動いた日
  const now = new Date()
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
  const week = WEEK.map((label, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    const key = localDateKey(d)
    return { label, key, done: !!logs?.some((l) => localDateKey(new Date(l.date)) === key), isToday: key === localDateKey(now), future: d > now }
  })
  const activeDays = week.filter((d) => d.done).length

  const settingsLink = (
    <Link to="/settings" aria-label="設定" className="inline-flex size-11 items-center justify-center rounded-full hover:bg-sunken">
      <SettingsIcon aria-hidden className="size-5" />
    </Link>
  )

  if (sessions === undefined) return <Screen title="からだ定点" action={settingsLink}>{null}</Screen>

  return (
    <Screen title="からだ定点" action={settingsLink}>
      {storageError && (
        <Notice tone="danger" title="データを保存できません">
          このブラウザでは端末への保存が使えないようです（プライベートブラウズなど）。通常のモードで開いてください。
        </Notice>
      )}

      {!latest ? (
        <EmptyState
          title="最初の測定で、今の姿勢を記録します"
          action={
            <ButtonLink to="/measure" variant="primary" size="lg" block icon={<Camera aria-hidden className="size-5" />}>
              最初の測定をする
            </ButtonLink>
          }
        >
          正面と横向きの写真 2 枚で、肩の高さの左右差や頭の位置などを数値にします。写真は端末の中だけで処理します。
        </EmptyState>
      ) : (
        <section aria-labelledby="latest" className="rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
          <div className="flex items-baseline justify-between">
            <h2 id="latest" className="font-bold">
              最新の姿勢
            </h2>
            <span className="text-sm text-ink-3 num">{fmtDate(latest.createdAt)}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {latest.front && <PostureGrid current={latest.front} past={prev?.front} label="正面の骨格。前回は破線" compact />}
            {latest.side && <PostureGrid current={latest.side} past={prev?.side} label="横向きの骨格。前回は破線" compact />}
          </div>
          {prev && <p className="mt-2 text-xs text-ink-3">実線が今回、破線が前回（{fmtDate(prev.createdAt)}）です。</p>}
          {comparison ? (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[15px]">{comparison.overall}</p>
              {comparison.top.slice(0, 3).map((c) => (
                <div key={c.key} className="mt-1.5 flex items-center justify-between gap-2 text-[15px]">
                  <span className="text-ink-2">{c.label}</span>
                  <ChangeLabel change={c.change} />
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 border-t border-line pt-3 text-[15px] text-ink-2">
              {latest.postureTraits.find((t) => t.status === 'noticeable')?.summary ?? '測定のばらつきを超える目立った差は見られませんでした。'}
            </p>
          )}
          <div className="mt-2 flex gap-4">
            <Link to={`/session/${latest.id}`} className="inline-flex min-h-11 items-center gap-0.5 text-[15px] font-medium text-measure">
              結果を見る
              <ChevronRight aria-hidden className="size-4" />
            </Link>
            {comparison && (
              <Link to="/compare" className="inline-flex min-h-11 items-center gap-0.5 text-[15px] font-medium text-measure">
                前回と比べる
                <ChevronRight aria-hidden className="size-4" />
              </Link>
            )}
          </div>
        </section>
      )}

      {todayRoutine && today && (
        <>
          <SectionTitle>今日のおすすめ</SectionTitle>
          <div className="rule-action pl-3">
            <p className="text-[19px] font-bold">{todayRoutine.name}</p>
            <p className="text-[15px] text-ink-2">
              {todayRoutine.durationMin} 分・{today.reasons[0]}
            </p>
          </div>
          <ButtonLink to={`/move/${todayRoutine.id}`} variant={latest ? 'primary' : 'secondary'} size="lg" block className="mt-4">
            今日のメニューを始める
          </ButtonLink>
        </>
      )}

      <SectionTitle sub={activeDays ? `今週は ${activeDays} 日、体を動かしました` : '1 分のメニューからでも大丈夫です'}>今週の記録</SectionTitle>
      <ol className="grid grid-cols-7 gap-1.5" aria-label="今週、運動を記録した日">
        {week.map((d) => (
          <li key={d.key} className="flex flex-col items-center gap-1">
            <span
              className={cx(
                'flex size-9 items-center justify-center rounded-full border text-sm',
                d.done ? 'border-ink bg-level font-bold' : d.future ? 'border-dashed border-line text-ink-3' : 'border-line bg-surface text-ink-3',
                d.isToday && 'ring-2 ring-ink ring-offset-2 ring-offset-paper',
              )}
              aria-label={`${d.label}曜日 ${d.done ? '記録あり' : '記録なし'}${d.isToday ? '（今日）' : ''}`}
            >
              {d.label}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--radius-control)] bg-surface px-3.5 py-3">
        <div className="flex items-center gap-2">
          <HeartPulse aria-hidden className="size-5 text-measure" />
          <span className="text-[15px]">{todayCheckin ? '今日の調子は記録済みです' : '今日の調子はどうですか'}</span>
        </div>
        <ButtonLink to="/checkin" size="sm" variant="secondary">
          {todayCheckin ? '記録し直す' : '記録する'}
        </ButtonLink>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 rounded-[var(--radius-control)] bg-surface px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Footprints aria-hidden className="size-5 text-measure" />
          <span className="text-[15px]">歩き方を測る（試作）</span>
        </div>
        <ButtonLink to="/gait" size="sm" variant="secondary">
          開く
        </ButtonLink>
      </div>

      {latest && (
        <>
          <SectionTitle>次の測定</SectionTitle>
          <p className="text-[15px] text-ink-2">{reviewTiming(latest.createdAt, now).text}</p>
        </>
      )}
    </Screen>
  )
}
