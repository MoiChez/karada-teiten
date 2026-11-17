import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Camera, ChevronRight, Video } from 'lucide-react'
import type { AssessmentSession } from '../domain/types'
import { SESSION_TAG_LABELS, fmtDate } from '../domain/format'
import { correctedSet } from '../domain/session'
import { PROFILES, type MotionRecord } from '../domain/motion'
import { routineById } from '../domain/recommend/routines'
import { useLogs, useMotions, useSessions } from '../data/hooks'
import { PostureGrid } from '../components/PoseViews'
import { Badge, Button, ButtonLink, EmptyState, Screen, SectionTitle, Segmented, cx } from '../components/ui'

export function History() {
  const sessions = useSessions()
  const motions = useMotions()
  const logs = useLogs()
  const navigate = useNavigate()
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [view, setView] = useState<'posture' | 'motion'>('posture')

  if (sessions === undefined || motions === undefined) return <Screen title="履歴">{null}</Screen>
  if (view === 'motion' || (sessions.length === 0 && motions.length > 0)) {
    return (
      <Screen title="履歴">
        {sessions.length > 0 && <ViewSwitch value="motion" onChange={setView} />}
        <MotionHistory motions={motions} />
      </Screen>
    )
  }
  if (sessions.length === 0) {
    return (
      <Screen title="履歴">
        <EmptyState title="まだ記録がありません" action={<ButtonLink to="/measure" variant="primary" size="lg" block icon={<Camera aria-hidden className="size-5" />}>最初の測定をする</ButtonLink>}>
          測定すると、ここに日付ごとの記録が並びます。
        </EmptyState>
      </Screen>
    )
  }

  const byMonth = new Map<string, AssessmentSession[]>()
  for (const s of sessions) {
    const d = new Date(s.createdAt)
    const k = `${d.getFullYear()}年${d.getMonth() + 1}月`
    byMonth.set(k, [...(byMonth.get(k) ?? []), s])
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1], id] : [...p, id]))

  return (
    <Screen
      title="履歴"
      action={
        sessions.length >= 2 ? (
          <Button size="sm" variant="quiet" onClick={() => { setSelecting(!selecting); setPicked([]) }}>
            {selecting ? 'やめる' : '2 つ選んで比較'}
          </Button>
        ) : undefined
      }
      footer={
        selecting ? (
          <Button
            variant="primary"
            size="lg"
            block
            disabled={picked.length !== 2}
            onClick={() => {
              const [x, y] = picked.map((id) => sessions.find((s) => s.id === id)!).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              navigate(`/compare?a=${x.id}&b=${y.id}`)
            }}
          >
            {picked.length === 2 ? 'この 2 つを比較する' : `比較する記録を選んでください（${picked.length} / 2）`}
          </Button>
        ) : undefined
      }
    >
      {motions.length > 0 && <ViewSwitch value="posture" onChange={setView} />}
      {[...byMonth.entries()].map(([month, list]) => (
        <section key={month}>
          <SectionTitle>{month}</SectionTitle>
          <ul className="space-y-2">
            {list.map((s) => {
              const notice = s.postureTraits.filter((t) => t.status === 'noticeable').sort((a, b) => b.magnitude - a.magnitude)
              const corrected = (s.front && correctedSet(s.front).size > 0) || (s.side && correctedSet(s.side).size > 0)
              const inner = (
                <>
                  <div className="w-14 shrink-0">
                    <PostureGrid current={s.side ?? s.front} label="骨格の縮小図" compact hideCaption className="pointer-events-none" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium num">{fmtDate(s.createdAt, true)}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.front && <Badge>正面</Badge>}
                      {s.side && <Badge>横向き</Badge>}
                      {corrected && <Badge tone="level">補正あり</Badge>}
                      {s.tags?.map((t) => (
                        <Badge key={t} tone="measure">
                          {SESSION_TAG_LABELS[t]}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-1 truncate text-sm text-ink-2">
                      {s.note ? `メモ: ${s.note}` : notice.length ? notice.slice(0, 2).map((t) => t.label).join('、') : s.front ? '左右のはっきりした差なし' : '横向きの位置を記録'}
                    </p>
                  </div>
                </>
              )
              return (
                <li key={s.id}>
                  {selecting ? (
                    <label className={cx('flex items-center gap-3 rounded-[var(--radius-control)] border border-line bg-surface p-3', picked.includes(s.id) && 'ring-2 ring-ink')}>
                      <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
                      {inner}
                    </label>
                  ) : (
                    <Link to={`/session/${s.id}`} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-line bg-surface p-3 hover:bg-sunken">
                      {inner}
                      <ChevronRight aria-hidden className="size-5 text-ink-3" />
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {logs && logs.length > 0 && (
        <>
          <SectionTitle sub="新しい順に 20 件">運動の記録</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {logs
              .slice(-20)
              .reverse()
              .map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 py-2.5 text-[15px]">
                  <span>{routineById(l.routineId)?.name ?? l.routineId}</span>
                  <span className="text-sm text-ink-3 num">{fmtDate(l.date)}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </Screen>
  )
}

function ViewSwitch({ value, onChange }: { value: 'posture' | 'motion'; onChange: (v: 'posture' | 'motion') => void }) {
  return (
    <Segmented
      legend="表示する記録"
      columns={2}
      value={value}
      onChange={onChange}
      options={[
        { value: 'posture', label: '姿勢' },
        { value: 'motion', label: '動き' },
      ]}
    />
  )
}

function MotionHistory({ motions }: { motions: MotionRecord[] }) {
  if (!motions.length) {
    return (
      <EmptyState title="まだ動きの記録がありません" action={<ButtonLink to="/motion" variant="primary" size="lg" block icon={<Video aria-hidden className="size-5" />}>動きを撮る</ButtonLink>}>
        スクワット・ローイングエルゴ・固定式の自転車を動画で撮ると、ここに並びます。
      </EmptyState>
    )
  }
  return (
    <ul className="space-y-2">
      {motions.map((m) => {
        const profile = PROFILES[m.kind]
        return (
          <li key={m.id}>
            <Link to={`/motion/${m.id}`} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-line bg-surface p-3 hover:bg-sunken">
              <Video aria-hidden className="size-6 shrink-0 text-measure" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{profile.label}</p>
                <p className="flex flex-wrap gap-x-2 text-sm text-ink-2 num">
                  <span className="whitespace-nowrap">{fmtDate(m.createdAt, true)}</span>
                  <span className="whitespace-nowrap">
                    {m.analysis.cycles.length} {profile.unitLabel}
                    {m.videoSaved ? '・動画あり' : ''}
                  </span>
                </p>
              </div>
              <ChevronRight aria-hidden className="size-5 shrink-0 text-ink-3" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
