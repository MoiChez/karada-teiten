// 動きの記録を 2 つ並べて比べる。1 回の始めから終わりまでを 0〜100% にそろえて、同じところを並べて再生する
// （長さの違う動きを、時刻のままそろえることはしない）。良くなった・悪くなったとは判定しない
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { Pause, Play } from 'lucide-react'
import {
  PROFILES,
  compareConditions,
  compareMotion,
  meanCurve,
  motionMetric,
  prepareRecord,
  type MotionCycle,
  type MotionRecord,
  type PreparedMotion,
} from '../domain/motion'
import { motionEquipment, motionPoses } from '../domain/motionPose'
import type { UserProfile } from '../domain/types'
import { fmtDate, fmtNum } from '../domain/format'
import { useMotions, useProfile } from '../data/hooks'
import type { MotionVideoData } from '../state/motionMedia'
import { useClock, useClockValue, type Clock } from '../components/motionClock'
import { FrameVideo } from '../components/FrameVideo'
import { Badge, Button, Notice, Screen, SectionTitle, Segmented, cx, inputClass } from '../components/ui'
import { fmtMotionMetric, motionDiffText, useMotionVideo } from './MotionResult'

const MotionBody3D = lazy(() => import('../three/MotionBody3D'))

interface Built {
  rec: MotionRecord
  prep: PreparedMotion
  cycles: MotionCycle[]
}

export function MotionCompare() {
  const [params, setParams] = useSearchParams()
  const motions = useMotions()
  const profile = useProfile()
  const aId = params.get('a') ?? undefined
  const bId = params.get('b') ?? undefined
  const videoA = useMotionVideo(aId)
  const videoB = useMotionVideo(bId)
  if (motions === undefined || profile === undefined || videoA === undefined || videoB === undefined) return <Screen title="動きを比べる" back="/motion">{null}</Screen>
  const b = motions.find((m) => m.id === bId)
  if (!b) return <Navigate to="/motion" replace />
  const same = motions.filter((m) => m.kind === b.kind && m.id !== b.id)
  const a = same.find((m) => m.id === aId)
  return (
    <Screen title="動きを比べる" back={`/motion/${b.id}`}>
      <p className="text-[15px] text-ink-2">{PROFILES[b.kind].label}の記録を 2 つ並べます。良くなった・悪くなったとは判定しません。条件（撮る位置・服・重さ）が違えば、値も変わります。</p>
      <label className="mt-3 block text-sm font-medium" htmlFor="cmp-a">
        比べる相手（今回: <span className="num">{fmtDate(b.createdAt, true)}</span>）
      </label>
      <select id="cmp-a" className={cx(inputClass, 'mt-1')} value={a?.id ?? ''} onChange={(e) => setParams({ a: e.target.value, b: b.id }, { replace: true })}>
        {!a && <option value="">選んでください</option>}
        {same.map((m) => (
          <option key={m.id} value={m.id}>
            {fmtDate(m.createdAt, true)}（{m.analysis.cycles.length} {PROFILES[m.kind].unitLabel}）
          </option>
        ))}
      </select>
      {!same.length && (
        <div className="mt-3">
          <Notice tone="info">同じ種目の記録がほかにありません。もう一度撮ると比べられます。</Notice>
        </div>
      )}
      {a && <CompareBody key={`${a.id}-${b.id}`} a={a} b={b} videoA={videoA} videoB={videoB} sex={profile?.sex} />}
    </Screen>
  )
}

function CompareBody({ a, b, videoA, videoB, sex }: { a: MotionRecord; b: MotionRecord; videoA: MotionVideoData | null; videoB: MotionVideoData | null; sex?: UserProfile['sex'] }) {
  const profile = PROFILES[b.kind]
  const A = useMemo<Built | null>(() => {
    const r = prepareRecord(a)
    return r ? { rec: a, ...r } : null
  }, [a])
  const B = useMemo<Built | null>(() => {
    const r = prepareRecord(b)
    return r ? { rec: b, ...r } : null
  }, [b])
  const [series, setSeries] = useState(profile.defaultSeries)
  const changes = useMemo(() => compareMotion(a.analysis, b.analysis), [a, b])
  const conditions = useMemo(() => compareConditions(a, b), [a, b])
  const def = profile.series.find((d) => d.key === series) ?? profile.series[0]
  const curveA = useMemo(() => (A ? meanCurve(A.prep, A.cycles, def.key) : null), [A, def.key])
  const curveB = useMemo(() => (B ? meanCurve(B.prep, B.cycles, def.key) : null), [B, def.key])

  return (
    <>
      {conditions.length > 0 && (
        <div className="mt-3">
          <Notice tone="info" title="条件の違い">
            <ul className="list-disc space-y-1 pl-4">
              {conditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {A && B && A.cycles.length > 0 && B.cycles.length > 0 ? (
        <SyncedPair A={A} B={B} videoA={videoA} videoB={videoB} sex={sex} curveA={curveA} curveB={curveB} def={def} series={series} setSeries={setSeries} />
      ) : (
        <div className="mt-3">
          <Notice tone="info">どちらかの記録に、区切れた{profile.unitLabel}がないため、並べて再生できません。</Notice>
        </div>
      )}

      <SectionTitle sub={`${profile.unitLabel}ごとの揺れから見て、差が測定のばらつきを超えるかを示します。`}>平均の差</SectionTitle>
      <div className="overflow-x-auto rounded-[var(--radius-panel)] bg-surface shadow-lift">
        <table className="w-full min-w-[420px] text-right text-[15px] num">
          <thead className="text-sm text-ink-3">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">値</th>
              <th className="px-2 py-2 font-medium">前（{fmtDate(a.createdAt)}）</th>
              <th className="px-2 py-2 font-medium">今回（{fmtDate(b.createdAt)}）</th>
              <th className="px-2 py-2 font-medium">差</th>
            </tr>
          </thead>
          <tbody>
            {profile.metrics.map((d) => {
              const ch = changes.find((c) => c.key === d.key)
              return (
                <tr key={d.key} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 text-left">{d.label}</td>
                  <td className="px-2 py-2">{fmtMotionMetric(d, motionMetric(a.analysis, d.key))}</td>
                  <td className="px-2 py-2">{fmtMotionMetric(d, motionMetric(b.analysis, d.key))}</td>
                  <td className="px-2 py-2">
                    {ch ? (
                      <>
                        {motionDiffText(d, ch.diff)} <Badge tone={ch.noticeable ? 'attention' : 'neutral'}>{ch.noticeable ? '差が見られる' : '範囲内'}</Badge>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-ink-3">
        「差が見られる」は、1 回の撮影の中の{profile.unitLabel}ごとの揺れから見た判断です。日をまたいだ体調・服・撮影位置・重さの違いは含みません。医療診断ではありません。
      </p>
    </>
  )
}

/** 0〜100% の時計から、記録の時刻（ミリ秒）へ直した時計（動画と 3D はこの時計で動かす） */
function mappedClock(phase: Clock, c: MotionCycle): Clock {
  const span = Math.max(1, phase.end - phase.start)
  const at = () => c.start + ((phase.get() - phase.start) / span) * (c.end - c.start)
  return { ...phase, start: c.start, end: c.end, get: at, set: () => undefined }
}

function SyncedPair({
  A,
  B,
  videoA,
  videoB,
  sex,
  curveA,
  curveB,
  def,
  series,
  setSeries,
}: {
  A: Built
  B: Built
  videoA: MotionVideoData | null
  videoB: MotionVideoData | null
  sex?: UserProfile['sex']
  curveA: number[] | null
  curveB: number[] | null
  def: { key: string; label: string; unit: string; digits: number }
  series: string
  setSeries: (s: string) => void
}) {
  const profile = PROFILES[B.rec.kind]
  const [ia, setIa] = useState(Math.floor((A.cycles.length - 1) / 2))
  const [ib, setIb] = useState(Math.floor((B.cycles.length - 1) / 2))
  const ca = A.cycles[ia]
  const cb = B.cycles[ib]
  // 今回の 1 回の長さで 0〜100% を進める
  const phase = useClock(0, Math.max(200, cb.end - cb.start))
  const clockA = useMemo(() => mappedClock(phase, ca), [phase, ca])
  const clockB = useMemo(() => mappedClock(phase, cb), [phase, cb])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (!reduced) {
      phase.setSpeed(0.5)
      phase.play()
    }
  }, [phase, reduced])

  return (
    <div className="mt-4">
      <div className="grid grid-cols-2 gap-2">
        <Side built={A} cycle={ca} clock={clockA} video={videoA} sex={sex} label={`前（${fmtDate(A.rec.createdAt)}）`} />
        <Side built={B} cycle={cb} clock={clockB} video={videoB} sex={sex} label={`今回（${fmtDate(B.rec.createdAt)}）`} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <CyclePicker label={`前の何${profile.unitLabel}目`} n={A.cycles.length} value={ia} onChange={setIa} />
        <CyclePicker label={`今回の何${profile.unitLabel}目`} n={B.cycles.length} value={ib} onChange={setIb} />
      </div>
      <PhaseTransport clock={phase} />
      <p className="mt-2 text-sm text-ink-3">
        それぞれの 1 {profile.unitLabel}の始めから終わりまでを 0〜100% にそろえて、同じ % のところを並べています（長さが違っても、同じ進み具合で比べるため）。
      </p>
      <div className="mt-3">
        <Segmented legend="グラフの値" value={series} onChange={setSeries} columns={Math.min(profile.series.length, 6)} options={profile.series.map((d) => ({ value: d.key, label: d.short }))} />
      </div>
      {curveA && curveB && <PhaseChart a={curveA} b={curveB} label={def.label} unit={def.unit} digits={def.digits} clock={phase} />}
    </div>
  )
}

function Side({ built, cycle, clock, video, sex, label }: { built: Built; cycle: MotionCycle; clock: Clock; video: MotionVideoData | null; sex?: UserProfile['sex']; label: string }) {
  const poses = useMemo(() => motionPoses(built.prep, built.cycles), [built])
  const equipment = useMemo(() => motionEquipment(built.rec.kind, poses, built.prep.nearSide), [built, poses])
  const overlay = useMemo(() => built.prep.frames.filter((f) => f.t >= cycle.start - 100 && f.t <= cycle.end + 100).map((f) => ({ t: f.t, lm: f.lm })), [built, cycle])
  return (
    <figure>
      <figcaption className="mb-1 text-sm font-medium text-ink-2 num">{label}</figcaption>
      {video ? (
        <div className="overflow-hidden rounded-[var(--radius-panel)] bg-ink" style={{ aspectRatio: `${video.width} / ${video.height}` }}>
          <FrameVideo images={video.images} width={video.width} height={video.height} clock={clock} overlay={overlay} nearSide={built.prep.nearSide} />
        </div>
      ) : (
        <div className="relative h-[min(40dvh,320px)]">
          <div className="absolute inset-0">
            <Suspense fallback={<div className="size-full rounded-[var(--radius-panel)] bg-surface" />}>
              <MotionBody3D poses={poses} clock={clock} sex={sex} facing={built.rec.analysis.facing} kind={built.rec.kind} muscles={false} equipment={equipment} nearSide={built.prep.nearSide} className="h-full" />
            </Suspense>
          </div>
        </div>
      )}
      {!video && <p className="mt-1 text-xs text-ink-3">動画を残していないので、3D の体を表示しています。</p>}
    </figure>
  )
}

function CyclePicker({ label, n, value, onChange }: { label: string; n: number; value: number; onChange: (i: number) => void }) {
  return (
    <label className="block text-sm">
      <span className="text-ink-2">{label}</span>
      <select className={cx(inputClass, 'mt-1')} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: n }, (_, i) => (
          <option key={i} value={i}>
            {i + 1}
          </option>
        ))}
      </select>
    </label>
  )
}

function PhaseTransport({ clock }: { clock: Clock }) {
  const playing = useClockValue(clock, (c) => c.isPlaying())
  const t = useClockValue(clock, (c) => c.get())
  const speed = useClockValue(clock, (c) => c.getSpeed())
  const pct = ((t - clock.start) / Math.max(1, clock.end - clock.start)) * 100
  return (
    <div className="mt-3 rounded-[var(--radius-panel)] bg-surface p-2 shadow-lift">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          aria-label={playing ? '一時停止' : '再生'}
          onClick={() => (playing ? clock.pause() : clock.play())}
          icon={playing ? <Pause aria-hidden className="size-5" /> : <Play aria-hidden className="size-5" />}
        >
          {playing ? '止める' : '再生'}
        </Button>
        <span className="ml-auto text-sm text-ink-2 num">{fmtNum(pct, 0)}%</span>
      </div>
      <input
        type="range"
        min={clock.start}
        max={clock.end}
        step={1}
        value={t}
        aria-label="1 回の中の位置（%）"
        onChange={(e) => {
          clock.pause()
          clock.set(Number(e.target.value))
        }}
        className="mt-1 w-full accent-[var(--color-measure)]"
      />
      <div className="mt-1 grid grid-cols-4 gap-1" role="group" aria-label="再生の速さ">
        {[1, 0.5, 0.25, 0.1].map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={speed === v}
            onClick={() => clock.setSpeed(v)}
            className={cx('min-h-10 rounded-[var(--radius-control)] border text-sm num', speed === v ? 'border-ink bg-ink text-paper' : 'border-line bg-surface hover:bg-sunken')}
          >
            {v === 1 ? '等速' : `${v}倍`}
          </button>
        ))}
      </div>
    </div>
  )
}

const CW = 340
const CH = 150
const PAD = { l: 34, r: 8, t: 10, b: 22 }

/** 平均の曲線（0〜100%）を 2 本重ねる。前 = 破線、今回 = 実線 */
function PhaseChart({ a, b, label, unit, digits, clock }: { a: number[]; b: number[]; label: string; unit: string; digits: number; clock: Clock }) {
  const lo0 = Math.min(...a, ...b)
  const hi0 = Math.max(...a, ...b)
  const pad = Math.max(1, (hi0 - lo0) * 0.08)
  const lo = lo0 - pad
  const hi = hi0 + pad
  const x = (k: number, n: number) => PAD.l + (k / (n - 1)) * (CW - PAD.l - PAD.r)
  const y = (v: number) => CH - PAD.b - ((v - lo) / Math.max(1e-6, hi - lo)) * (CH - PAD.t - PAD.b)
  const path = (v: number[]) => v.map((p, k) => `${k ? 'L' : 'M'}${x(k, v.length).toFixed(1)},${y(p).toFixed(1)}`).join('')
  return (
    <figure className="rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-2">
        <span className="font-medium">
          {label}（全部の回の平均、{unit}）
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <svg aria-hidden width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-past)" strokeWidth="2" strokeDasharray="4 3" />
            </svg>
            前
          </span>
          <span className="flex items-center gap-1">
            <svg aria-hidden width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" stroke="var(--color-measure)" strokeWidth="2" />
            </svg>
            今回
          </span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${CW} ${CH}`} className="mt-1 w-full" role="img" aria-label={`${label}の、前と今回の平均の曲線`}>
        {[lo0, (lo0 + hi0) / 2, hi0].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={CW - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-grid)" />
            <text x={PAD.l - 4} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--color-ink-3)">
              {fmtNum(v, digits)}
            </text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((p) => (
          <text key={p} x={x(p, 101)} y={CH - 6} textAnchor="middle" fontSize="10" fill="var(--color-ink-3)">
            {p}%
          </text>
        ))}
        <path d={path(a)} fill="none" stroke="var(--color-past)" strokeWidth="1.8" strokeDasharray="5 3" />
        <path d={path(b)} fill="none" stroke="var(--color-measure)" strokeWidth="1.8" />
        <PhaseCursor clock={clock} />
      </svg>
    </figure>
  )
}

function PhaseCursor({ clock }: { clock: Clock }) {
  const t = useClockValue(clock, (c) => c.get())
  const cx = PAD.l + ((t - clock.start) / Math.max(1, clock.end - clock.start)) * (CW - PAD.l - PAD.r)
  return <line x1={cx} x2={cx} y1={PAD.t - 4} y2={CH - PAD.b + 2} stroke="var(--color-ink)" strokeWidth="1.2" strokeDasharray="3 2" />
}
