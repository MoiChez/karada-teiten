// 動きの再生: 撮った動画と 3D の体を並べ、1 つの時計で動かす。下に角度のグラフと、今の時刻の値
import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pause, Play, StepBack, StepForward } from 'lucide-react'
import { PROFILES, eventOf, type MotionCycle, type MotionRecord, type PreparedMotion } from '../domain/motion'
import type { Pose3D } from '../domain/fusion3d'
import { motionEquipment } from '../domain/motionPose'
import type { UserProfile } from '../domain/types'
import { fmtNum } from '../domain/format'
import type { MotionVideoData } from '../state/motionMedia'
import { indexAt, useClockValue, type Clock } from './motionClock'
import { FrameVideo } from './FrameVideo'
import { AngleChart } from './AngleChart'
import { Button, IconButton, Segmented, cx } from './ui'

// 3D（three.js）は重いので、開いたときに読み込む
const MotionBody3D = lazy(() => import('../three/MotionBody3D'))

export function MotionPlayer({
  rec,
  prep,
  cycles,
  poses,
  video,
  sex,
  clock,
  muscles,
  videoOverlay,
}: {
  rec: MotionRecord
  prep: PreparedMotion
  cycles: MotionCycle[]
  poses: { t: number; pose: Pose3D }[]
  video: MotionVideoData | null
  sex?: UserProfile['sex']
  clock: Clock
  /** 3D の体に、種目で一般に使われる筋肉の場所を色で示す */
  muscles: boolean
  /** 動画の上に重ねるもの（点の補正など）。なければ骨格の線を重ねる */
  videoOverlay?: ReactNode
}) {
  const profile = PROFILES[rec.kind]
  const ts = useMemo(() => prep.frames.map((f) => f.t), [prep])
  const [series, setSeries] = useState<string>(profile.defaultSeries)
  const [overlayOn, setOverlayOn] = useState(true)
  const overlay = useMemo(() => prep.frames.map((f) => ({ t: f.t, lm: f.lm })), [prep])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const def = profile.series.find((d) => d.key === series) ?? profile.series[0]
  const equipment = useMemo(() => motionEquipment(rec.kind, poses, prep.nearSide), [rec.kind, poses, prep.nearSide])

  // 最初は 1 回目の出来事（底・キャッチなど）から、ゆっくり再生する
  useEffect(() => {
    const first = cycles[0] && eventOf(cycles[0], profile.mainEvent)
    if (first) clock.set(first.t)
    if (!reduced) {
      clock.setSpeed(0.5)
      clock.play()
    }
  }, [clock, cycles, profile.mainEvent, reduced])

  // 縦長の動画は 3D と左右に並べ、横長の動画は上下に並べる（枠は動画の縦横比に合わせる）
  const sideBySide = !!video && video.height >= video.width
  return (
    <div className="mt-4">
      <div className={cx('grid gap-2', sideBySide ? 'grid-cols-2' : 'grid-cols-1')}>
        {video && (
          <div className="relative overflow-hidden rounded-[var(--radius-panel)] bg-ink" style={{ aspectRatio: `${video.width} / ${video.height}` }}>
            <FrameVideo
              images={video.images}
              width={video.width}
              height={video.height}
              clock={clock}
              overlay={overlayOn && !videoOverlay ? overlay : undefined}
              nearSide={prep.nearSide}
            />
            {videoOverlay}
          </div>
        )}
        {/* 並べるときは、動画の枠と同じ高さにする（3D の側は高さを持たない） */}
        <div className={cx('relative', sideBySide ? 'min-h-[240px]' : 'h-[min(46dvh,380px)]')}>
          <div className="absolute inset-0">
            <Suspense fallback={<div className="size-full rounded-[var(--radius-panel)] bg-surface" />}>
              <MotionBody3D poses={poses} clock={clock} sex={sex} facing={rec.analysis.facing} kind={rec.kind} muscles={muscles} equipment={equipment} nearSide={prep.nearSide} className="h-full" />
            </Suspense>
          </div>
        </div>
      </div>
      {!video && <p className="mt-2 text-sm text-ink-3">動画は保存していないため、3D の体だけを再生します。</p>}

      <Transport clock={clock} ts={ts} />

      {cycles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`${profile.unitLabel}ごとの出来事へ移る`}>
          {cycles.map((c, i) => {
            const ev = eventOf(c, profile.mainEvent)
            if (!ev) return null
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  clock.pause()
                  clock.set(ev.t)
                }}
                className="min-h-10 rounded-full border border-line bg-surface px-3 text-sm hover:bg-sunken"
              >
                {profile.jumpLabel(i + 1)}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-3">
        <Segmented
          legend="グラフの値"
          value={def.key}
          onChange={setSeries}
          columns={Math.min(profile.series.length, 6)}
          options={profile.series.map((d) => ({ value: d.key, label: d.short }))}
        />
      </div>
      <AngleChart
        ts={ts}
        values={prep.series[def.key]}
        unit={def.unit}
        digits={def.digits}
        cycles={cycles.map((c) => ({ start: c.start, end: c.end, mark: eventOf(c, profile.mainEvent)?.t }))}
        clock={clock}
        label={def.label}
      />
      <NowTable clock={clock} ts={ts} prep={prep} />
      {video && !videoOverlay && (
        <label className="mt-2 flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={overlayOn} onChange={(e) => setOverlayOn(e.target.checked)} />
          動画に骨格の線を重ねる（明るい線がカメラ側の半身）
        </label>
      )}
    </div>
  )
}

function Transport({ clock, ts }: { clock: Clock; ts: number[] }) {
  const playing = useClockValue(clock, (c) => c.isPlaying())
  const t = useClockValue(clock, (c) => c.get())
  const speed = useClockValue(clock, (c) => c.getSpeed())
  const step = (dir: 1 | -1) => {
    clock.pause()
    const k = indexAt(ts, clock.get())
    const next = ts[Math.min(ts.length - 1, Math.max(0, k + dir))]
    // 同じコマにいるときは次のコマへ
    clock.set(next === clock.get() && ts[k + dir] !== undefined ? ts[k + dir] : next)
  }
  return (
    <div className="mt-3 rounded-[var(--radius-panel)] bg-surface p-2 shadow-lift">
      <div className="flex items-center gap-1.5">
        <IconButton label="1 コマ戻る" onClick={() => step(-1)}>
          <StepBack aria-hidden className="size-5" />
        </IconButton>
        <Button
          variant="secondary"
          aria-label={playing ? '一時停止' : '再生'}
          onClick={() => (playing ? clock.pause() : clock.play())}
          icon={playing ? <Pause aria-hidden className="size-5" /> : <Play aria-hidden className="size-5" />}
        >
          {playing ? '止める' : '再生'}
        </Button>
        <IconButton label="1 コマ進む" onClick={() => step(1)}>
          <StepForward aria-hidden className="size-5" />
        </IconButton>
        <span className="ml-auto text-sm text-ink-2 num">
          {fmtNum((t - clock.start) / 1000, 2)} / {fmtNum((clock.end - clock.start) / 1000, 1)} 秒
        </span>
      </div>
      <input
        type="range"
        min={clock.start}
        max={clock.end}
        step={1}
        value={t}
        aria-label="再生する位置"
        onChange={(e) => {
          clock.pause()
          clock.set(Number(e.target.value))
        }}
        className="mt-1 w-full accent-[var(--color-measure)]"
      />
      <div className="mt-1 grid grid-cols-5 gap-1" role="group" aria-label="再生の速さ">
        {[2, 1, 0.5, 0.25, 0.1].map((v) => (
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

/** 今の時刻の値 */
function NowTable({ clock, ts, prep }: { clock: Clock; ts: number[]; prep: PreparedMotion }) {
  const t = useClockValue(clock, (c) => c.get())
  const k = indexAt(ts, t)
  const defs = PROFILES[prep.kind].series
  return (
    <dl className="mt-2 grid gap-1 rounded-[var(--radius-panel)] bg-surface p-2 text-center shadow-lift" style={{ gridTemplateColumns: `repeat(${defs.length}, minmax(0, 1fr))` }}>
      {defs.map((d) => (
        <div key={d.key}>
          <dt className="text-xs text-ink-3">{d.short}</dt>
          <dd className="text-[15px] font-bold num">
            {fmtNum(prep.series[d.key][k], d.digits)}
            {d.unit}
          </dd>
        </div>
      ))}
    </dl>
  )
}
