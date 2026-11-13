// 動きの再生: 撮った動画と 3D の体を並べ、1 つの時計で動かす。下に角度のグラフと、今の時刻の値
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pause, Play, StepBack, StepForward } from 'lucide-react'
import { MUSCLE_LABELS, PROFILES, eventOf, type MotionCycle, type MotionRecord, type MuscleKey, type PreparedMotion } from '../domain/motion'
import { MUSCLE_JOINT, PHASE_LABELS } from '../domain/motionLoad'
import { pxToNorm } from '../domain/motionConstraints'
import { sidePoints } from '../domain/landmarks'
import type { Pose3D } from '../domain/fusion3d'
import { motionEquipment } from '../domain/motionPose'
import type { UserProfile } from '../domain/types'
import { fmtNum } from '../domain/format'
import type { MotionVideoData } from '../state/motionMedia'
import { indexAt, useClockValue, type Clock } from './motionClock'
import { FrameVideo } from './FrameVideo'
import { AngleChart } from './AngleChart'
import { MotionVideoExport } from './MotionVideoExport'
import type { OverlayInput } from './FrameVideo'
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
  autoplay = true,
  exportName,
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
  /** 開いたときに再生を始めるか（点を直している間は、計算し直すたびに動き出さないように止めておく） */
  autoplay?: boolean
  /** あれば、この名前で動画に書き出せるようにする */
  exportName?: string
}) {
  const profile = PROFILES[rec.kind]
  const ts = useMemo(() => prep.frames.map((f) => f.t), [prep])
  const [series, setSeries] = useState<string>(profile.defaultSeries)
  const [overlayOn, setOverlayOn] = useState(true)
  const overlay = useMemo(() => prep.frames.map((f) => ({ t: f.t, lm: f.lm })), [prep])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const def = profile.series.find((d) => d.key === series) ?? profile.series[0]
  const equipment = useMemo(() => motionEquipment(rec.kind, poses, prep.nearSide), [rec.kind, poses, prep.nearSide])
  // 重心の線（スクワット。画像に対する比）
  const com = useMemo(() => {
    // 真横から撮っていなければ、重心は出さない（横から見た位置として求めているため）
    if (!prep.load || rec.analysis.sideView === false) return undefined
    const size = { width: rec.video.width, height: rec.video.height, rollDeg: rec.video.rollDeg }
    const sp = sidePoints(prep.nearSide)
    return prep.frames.map((fr, k) => ({ c: pxToNorm(prep.load!.com[k], size), heel: fr.lm[sp.heel], toe: fr.lm[sp.foot] }))
  }, [prep, rec.video, rec.analysis.sideView])
  // バーの軌道（スクワットで持つ重さを入れたとき。手首の点。その回の始めから今のコマまで）
  const bar = useMemo(() => {
    if (!prep.bar) return undefined
    const sp = sidePoints(prep.nearSide)
    const from = prep.frames.map((_, k) => cycles.find((c) => k >= c.startIndex && k <= c.endIndex)?.startIndex ?? -1)
    return { points: prep.frames.map((fr) => fr.lm[sp.wrist]), from }
  }, [prep, cycles])
  // 動画の書き出しで、コマ k に重ねるもの（画面の重ね表示と同じ）
  const three = useRef<HTMLCanvasElement | null>(null)
  const overlayAt = (k: number): OverlayInput | null =>
    overlayOn && !videoOverlay && prep.frames[k]
      ? { lm: prep.frames[k].lm, nearSide: prep.nearSide, com: com?.[k], trail: bar && bar.from[k] >= 0 ? bar.points.slice(bar.from[k], k + 1) : undefined }
      : null
  // 筋肉の濃さ（スクワットで筋肉を示すとき。推定の要求度）
  const levels = useMemo(() => {
    if (!muscles || !prep.load || rec.analysis.sideView === false) return undefined
    const values: Partial<Record<MuscleKey, number[]>> = {}
    for (const [m, j] of Object.entries(MUSCLE_JOINT) as [MuscleKey, keyof typeof prep.load.demand][]) values[m] = prep.load.demand[j]
    return { ts, values }
  }, [muscles, prep, ts, rec.analysis.sideView])

  // 最初だけ、1 回目の出来事（底・キャッチなど）から、ゆっくり再生する
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const first = cycles[0] && eventOf(cycles[0], profile.mainEvent)
    if (first) clock.set(first.t)
    if (!reduced && autoplay) {
      clock.setSpeed(0.5)
      clock.play()
    }
  }, [clock, cycles, profile.mainEvent, reduced, autoplay])

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
              com={com}
              bar={bar}
            />
            {videoOverlay}
          </div>
        )}
        {/* 並べるときは、動画の枠と同じ高さにする（3D の側は高さを持たない） */}
        <div className={cx('relative', sideBySide ? 'min-h-[240px]' : 'h-[min(46dvh,380px)]')}>
          <div className="absolute inset-0">
            <Suspense fallback={<div className="size-full rounded-[var(--radius-panel)] bg-surface" />}>
              <MotionBody3D poses={poses} clock={clock} sex={sex} facing={rec.analysis.facing} kind={rec.kind} muscles={muscles}
                levels={levels}
                equipment={equipment}
                nearSide={prep.nearSide}
                className="h-full"
                onCanvas={(c) => (three.current = c)}
              />
            </Suspense>
          </div>
        </div>
      </div>
      {!video && <p className="mt-2 text-sm text-ink-3">動画は保存していないため、3D の体だけを再生します。</p>}
      {levels && prep.load && <DemandNow clock={clock} ts={ts} load={prep.load} />}

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
        band={def.band ? { lo: prep.series[def.band[0]], hi: prep.series[def.band[1]] } : undefined}
        reference={profile.chartRefs?.[def.key]}
      />
      <NowTable clock={clock} ts={ts} prep={prep} />
      {exportName && <MotionVideoExport rec={rec} prep={prep} cycles={cycles} video={video} clock={clock} three={three} series={def} overlayAt={overlayAt} fileStem={exportName} />}
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
/** 今の時刻の、筋肉ごとの推定の要求度と、伸びながら / 縮みながら */
function DemandNow({ clock, ts, load }: { clock: Clock; ts: number[]; load: NonNullable<PreparedMotion['load']> }) {
  const t = useClockValue(clock, (c) => c.get())
  const k = indexAt(ts, t)
  return (
    <div className="mt-2 rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <p className="text-sm font-medium text-ink-2">推定の要求度（今の時刻）</p>
      <ul className="mt-1.5 space-y-1.5">
        {(Object.entries(MUSCLE_JOINT) as [MuscleKey, keyof typeof load.demand][]).map(([m, j]) => {
          const v = load.demand[j][k] ?? 0
          return (
            <li key={m} className="text-sm">
              <span className="flex items-baseline justify-between gap-2">
                <span>{MUSCLE_LABELS[m]}</span>
                <span className="shrink-0 font-bold num">{fmtNum(v, 2)}</span>
              </span>
              <span className="mt-0.5 flex items-center gap-2">
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
                  <span className="block h-full rounded-full" style={{ width: `${Math.round(v * 100)}%`, background: '#E9B85E' }} />
                </span>
                <span className="shrink-0 text-xs text-ink-3">{PHASE_LABELS[load.phase[j][k] ?? 'isometric']}</span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-xs text-ink-3">運動の動きと、条件付きのモデル（体の部分の重さ・床からの力の仮定）から求めた、筋肉にかかる力の要求の目安（0〜1）です。筋電図などで測った値ではありません。太ももの裏とお尻は、どちらも股関節を伸ばす筋肉として同じ値にしています。</p>
    </div>
  )
}

function NowTable({ clock, ts, prep }: { clock: Clock; ts: number[]; prep: PreparedMotion }) {
  const t = useClockValue(clock, (c) => c.get())
  const k = indexAt(ts, t)
  const defs = PROFILES[prep.kind].series
  return (
    <dl className="mt-2 grid gap-1 rounded-[var(--radius-panel)] bg-surface p-2 text-center shadow-lift" style={{ gridTemplateColumns: `repeat(${Math.min(defs.length, 4)}, minmax(0, 1fr))` }}>
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
