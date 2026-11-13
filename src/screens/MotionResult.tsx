// 動きの一覧と結果。撮った動画と 3D の体を並べ、同じ時刻で再生する。下に角度のグラフ（今の時刻に縦線）を置く
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ChevronRight, Pause, Play, StepBack, StepForward, Trash2, Video } from 'lucide-react'
import {
  MOTION_KINDS,
  MOTION_METRICS,
  MOTION_METRIC_KEYS,
  SERIES,
  SERIES_KEYS,
  compareMotion,
  findReps,
  motionInputOf,
  motionMetric,
  prepareMotion,
  type MotionMetric,
  type MotionMetricKey,
  type MotionRecord,
  type SeriesKey,
} from '../domain/motion'
import { motionPoses } from '../domain/motionPose'
import type { UserProfile } from '../domain/types'
import { fmtDate, fmtNum } from '../domain/format'
import { data } from '../data/repo'
import { useMotions, useProfile } from '../data/hooks'
import { forgetMotionVideo, memoryMotionVideo, type MotionVideoData } from '../state/motionMedia'
import { useToast } from '../state/stores'
import { indexAt, useClock, useClockValue, type Clock } from '../components/motionClock'
import { FrameVideo } from '../components/FrameVideo'
import { AngleChart } from '../components/AngleChart'
import { Badge, Button, ButtonLink, Details, Dialog, EmptyState, IconButton, Notice, Screen, SectionTitle, Segmented, cx } from '../components/ui'

// 3D（three.js）は重いので、結果を開いたときに読み込む
const MotionBody3D = lazy(() => import('../three/MotionBody3D'))

function fmtMetric(key: MotionMetricKey, m: MotionMetric | undefined) {
  if (!m || m.status !== 'ok' || m.value === null) return '測定不可'
  const { unit, digits } = MOTION_METRICS[key]
  return `${fmtNum(m.value, digits)}${unit === '秒' ? ' 秒' : unit}`
}

/** 表の数字（単位は見出しに出す） */
function fmtValue(key: MotionMetricKey, v: number) {
  return fmtNum(v, MOTION_METRICS[key].digits)
}

function diffText(key: MotionMetricKey, d: number) {
  const { unit, digits } = MOTION_METRICS[key]
  const u = unit === '%' ? ' ポイント' : unit === '秒' ? ' 秒' : unit
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmtNum(Math.abs(d), digits)}${u}`
}

// ---------- 一覧 ----------

export function MotionList() {
  const motions = useMotions()
  if (motions === undefined) return <Screen title="動きを撮る" back="/">{null}</Screen>
  return (
    <Screen title="動きを撮る" back="/">
      {!motions.length ? (
        <EmptyState
          title="横からスクワットを撮って、関節の角度の動きを記録します"
          action={
            <ButtonLink to="/motion/capture" variant="primary" size="lg" block icon={<Video aria-hidden className="size-5" />}>
              スクワットを撮る
            </ButtonLink>
          }
        >
          撮った動画と 3D の体を並べて、スロー再生やコマ送りで見られます。しゃがむ深さや膝・股関節の曲がりを、1 回ごとに測ります。
        </EmptyState>
      ) : (
        <>
          <ButtonLink to="/motion/capture" variant="primary" size="lg" block className="mt-2" icon={<Video aria-hidden className="size-5" />}>
            スクワットを撮る
          </ButtonLink>
          <SectionTitle>記録</SectionTitle>
          <ul className="divide-y divide-line rounded-[var(--radius-panel)] bg-surface shadow-lift">
            {motions.map((m) => (
              <li key={m.id}>
                <Link to={`/motion/${m.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-sunken">
                  <Video aria-hidden className="size-5 shrink-0 text-measure" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium num">
                      {fmtDate(m.createdAt, true)}・{MOTION_KINDS[m.kind].label}
                    </p>
                    <p className="text-sm text-ink-3 num">
                      {m.analysis.reps.length} 回・深さ {fmtMetric('depth', motionMetric(m.analysis, 'depth'))}・膝 {fmtMetric('knee', motionMetric(m.analysis, 'knee'))}
                    </p>
                  </div>
                  <ChevronRight aria-hidden className="size-5 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  )
}

// ---------- 結果 ----------

export function MotionResult() {
  const { id } = useParams()
  const motions = useMotions()
  const profile = useProfile()
  const [video, setVideo] = useState<MotionVideoData | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    if (!id) return
    const mem = memoryMotionVideo(id)
    if (mem) {
      setVideo(mem)
      return
    }
    data
      .getMotionVideo(id)
      .then((v) => alive && setVideo(v ? { width: v.width, height: v.height, images: v.images } : null))
      .catch(() => alive && setVideo(null))
    return () => {
      alive = false
    }
  }, [id])
  if (motions === undefined || profile === undefined || video === undefined) return <Screen title="動きの記録" back="/motion">{null}</Screen>
  const idx = motions.findIndex((m) => m.id === id)
  if (idx < 0) return <Navigate to="/motion" replace />
  const rec = motions[idx]
  const prev = motions.slice(idx + 1).find((m) => m.kind === rec.kind)
  return <MotionResultBody key={rec.id} rec={rec} prev={prev} video={video} sex={profile?.sex} />
}

function MotionResultBody({ rec, prev, video, sex }: { rec: MotionRecord; prev?: MotionRecord; video: MotionVideoData | null; sex?: UserProfile['sex'] }) {
  const navigate = useNavigate()
  const toast = useToast((t) => t.show)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const prep = useMemo(() => prepareMotion(motionInputOf(rec)), [rec])
  const reps = useMemo(() => (prep ? findReps(prep).reps : []), [prep])
  const poses = useMemo(() => (prep ? motionPoses(prep) : []), [prep])
  const changes = useMemo(() => (prev ? compareMotion(prev.analysis, rec.analysis) : []), [prev, rec])
  const a = rec.analysis
  const label = MOTION_KINDS[rec.kind].label

  const del = async () => {
    await data.deleteMotion(rec.id)
    forgetMotionVideo(rec.id)
    toast('記録を削除しました')
    navigate('/motion', { replace: true })
  }

  return (
    <Screen
      title={label}
      back="/motion"
      action={
        <IconButton label="この記録を削除" onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden className="size-5" />
        </IconButton>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-3 num">{fmtDate(rec.createdAt, true)}</span>
        <Badge tone="measure">{a.reps.length} 回</Badge>
        <Badge>{rec.source === 'camera' ? 'アプリで撮影' : '選んだ動画'}</Badge>
        <Badge>{rec.videoSaved ? '動画を保存' : '動画は未保存'}</Badge>
      </div>

      {a.warnings.length > 0 && (
        <div className="mt-3">
          <Notice tone="warn" title="撮影の注意">
            <ul className="list-disc space-y-1 pl-4">
              {a.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {prep && poses.length > 1 ? (
        <Player rec={rec} prep={prep} reps={reps} poses={poses} video={video} sex={sex} />
      ) : (
        <div className="mt-3">
          <Notice tone="info">再生に使える体の点がありません。</Notice>
        </div>
      )}

      <SectionTitle sub="横から見た見かけの角度です。正常範囲とは比べていません。自分の過去の記録と比べるための値です。">1 回ごとの値</SectionTitle>
      <div className="overflow-x-auto rounded-[var(--radius-panel)] bg-surface shadow-lift">
        <table className="w-full min-w-[520px] text-right text-[15px] num">
          <thead className="text-sm text-ink-3">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">回</th>
              {MOTION_METRIC_KEYS.map((k) => (
                <th key={k} className="px-2 py-2 font-medium">
                  {k === 'descent' ? 'しゃがむ' : k === 'ascent' ? '立つ' : SERIES[k as SeriesKey].short}
                  <span className="block text-xs font-normal">{MOTION_METRICS[k].unit}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.reps.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-left">{i + 1}</td>
                {MOTION_METRIC_KEYS.map((k) => (
                  <td key={k} className="px-2 py-2">
                    {fmtValue(k, r.values[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle sub={prev ? `前回（${fmtDate(prev.createdAt)}）との差。回ごとの揺れから見て、差が測定のばらつきを超えるかを示します。` : '2 回目の記録から、前回との差を表示します。'}>
        平均
      </SectionTitle>
      <ul className="space-y-3">
        {MOTION_METRIC_KEYS.map((key) => {
          const m = motionMetric(a, key)
          const doc = MOTION_METRICS[key]
          const ch = changes.find((c) => c.key === key)
          const pm = prev ? motionMetric(prev.analysis, key) : undefined
          return (
            <li key={key} className="rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-bold">{doc.label}</h3>
                <span className="text-[22px] font-bold num">{fmtMetric(key, m)}</span>
              </div>
              {m?.status === 'ok' && m.sd !== null && (
                <p className="mt-0.5 text-right text-sm text-ink-3 num">
                  回ごとの揺れ ±{fmtNum(m.sd, doc.digits + (doc.unit === '秒' ? 0 : 1))}
                  {doc.unit === '秒' ? ' 秒' : doc.unit}・{m.reps} 回
                </p>
              )}
              {prev && pm && (
                <p className="mt-2 text-[15px] text-ink-2 num">
                  前回 {fmtMetric(key, pm)}
                  {ch && (
                    <>
                      {' '}→ 差 {diffText(key, ch.diff)} <Badge tone={ch.noticeable ? 'attention' : 'neutral'}>{ch.noticeable ? '差が見られる' : 'ばらつきの範囲内'}</Badge>
                    </>
                  )}
                </p>
              )}
              <Details summary="この値について">{doc.doc}</Details>
            </li>
          )
        })}
      </ul>

      <div className="mt-6">
        <Details summary="撮影の情報">
          <ul className="space-y-1 text-sm num">
            <li>
              推定したコマ {rec.video.frameCount}（1 秒あたり {fmtNum(rec.video.fps, 1)}）・計算に使えたコマ {a.validFrames}
            </li>
            <li>
              顔の向き: 画面の{a.facing === 'left' ? '左' : '右'}・カメラ側の半身: {a.nearSide === 'left' ? '左' : '右'}
            </li>
            <li>{rec.video.rollDeg !== undefined ? `端末の傾き ${fmtNum(rec.video.rollDeg, 1)}° を戻して計算` : '端末の傾きは分からないため、戻していません'}</li>
            <li>
              映像 {rec.video.width}×{rec.video.height}
              {rec.video.quarterTurns ? `（${rec.video.quarterTurns * 90}° 回して使用）` : ''}・{rec.modelVersion}
            </li>
          </ul>
        </Details>
      </div>

      <p className="mt-4 text-sm text-ink-3">
        医療診断ではありません。動きの良し悪しは判定していません。角度はスマホの中で、1 台のカメラの映像から推定した目印の位置から求めた見かけの値で、骨の角度ではありません。
        {rec.videoSaved ? '動画はこの端末にだけ保存しています。' : '動画は保存していません（体の点の動きだけを保存）。'}
      </p>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="この記録を削除しますか"
        actions={
          <>
            <Button variant="danger" block onClick={del}>
              削除する
            </Button>
            <Button variant="quiet" block onClick={() => setConfirmDelete(false)}>
              やめる
            </Button>
          </>
        }
      />
    </Screen>
  )
}

// ---------- 再生 ----------

function Player({
  rec,
  prep,
  reps,
  poses,
  video,
  sex,
}: {
  rec: MotionRecord
  prep: NonNullable<ReturnType<typeof prepareMotion>>
  reps: ReturnType<typeof findReps>['reps']
  poses: ReturnType<typeof motionPoses>
  video: MotionVideoData | null
  sex?: UserProfile['sex']
}) {
  const ts = useMemo(() => prep.frames.map((f) => f.t), [prep])
  const start = video?.images.length ? Math.min(video.images[0].t, ts[0]) : ts[0]
  const end = video?.images.length ? Math.max(video.images[video.images.length - 1].t, ts[ts.length - 1]) : ts[ts.length - 1]
  const clock = useClock(start, end)
  const [series, setSeries] = useState<SeriesKey>('knee')
  const [overlayOn, setOverlayOn] = useState(true)
  const overlay = useMemo(() => prep.frames.map((f) => ({ t: f.t, lm: f.lm })), [prep])
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // 最初は 1 回目のいちばん深いところで止めておく（動きの形がひと目で分かるように）
  useEffect(() => {
    if (reps[0]) clock.set(reps[0].bottom)
    if (!reduced) {
      clock.setSpeed(0.5)
      clock.play()
    }
  }, [clock, reps, reduced])

  // 縦長の動画は 3D と左右に並べ、横長の動画は上下に並べる（枠は動画の縦横比に合わせる）
  const sideBySide = !!video && video.height >= video.width
  return (
    <div className="mt-4">
      <div className={cx('grid gap-2', sideBySide ? 'grid-cols-2' : 'grid-cols-1')}>
        {video && (
          <div className="overflow-hidden rounded-[var(--radius-panel)] bg-ink" style={{ aspectRatio: `${video.width} / ${video.height}` }}>
            <FrameVideo images={video.images} width={video.width} height={video.height} clock={clock} overlay={overlayOn ? overlay : undefined} nearSide={prep.nearSide} />
          </div>
        )}
        {/* 並べるときは、動画の枠と同じ高さにする（3D の側は高さを持たない） */}
        <div className={cx('relative', sideBySide ? 'min-h-[240px]' : 'h-[min(46dvh,380px)]')}>
          <div className="absolute inset-0">
            <Suspense fallback={<div className="size-full rounded-[var(--radius-panel)] bg-surface" />}>
              <MotionBody3D poses={poses} clock={clock} sex={sex} facing={rec.analysis.facing} className="h-full" />
            </Suspense>
          </div>
        </div>
      </div>
      {!video && <p className="mt-2 text-sm text-ink-3">動画は保存していないため、3D の体だけを再生します。</p>}

      <Transport clock={clock} ts={ts} />

      {reps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="いちばん深いところへ移る">
          {reps.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                clock.pause()
                clock.set(r.bottom)
              }}
              className="min-h-10 rounded-full border border-line bg-surface px-3 text-sm hover:bg-sunken"
            >
              {i + 1} 回目の底
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        <Segmented legend="グラフの値" value={series} onChange={setSeries} columns={5} options={SERIES_KEYS.map((k) => ({ value: k, label: SERIES[k].short }))} />
      </div>
      <AngleChart ts={ts} values={prep.series[series]} unit={SERIES[series].unit} digits={SERIES[series].digits} reps={reps} clock={clock} label={SERIES[series].label} />
      <NowTable clock={clock} ts={ts} prep={prep} />
      {video && (
        <label className="mt-2 flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={overlayOn} onChange={(e) => setOverlayOn(e.target.checked)} />
          動画に骨格の線を重ねる（明るい線がカメラ側の半身）
        </label>
      )}
      <p className="mt-2 text-sm text-ink-3">
        3D の体は全員に共通の標準の体で、横から撮った関節の前後・上下の動きを反映しています。左右の位置は推定モデルの奥行きの推定で、横からの映像では外れやすいため参考です。帯は 1 回ごとの区間、黄色の点はいちばん深いところです。
      </p>
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
          {fmtNum((t - clock.start) / 1000, 1)} / {fmtNum((clock.end - clock.start) / 1000, 1)} 秒
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

/** 今の時刻の 5 つの値 */
function NowTable({ clock, ts, prep }: { clock: Clock; ts: number[]; prep: NonNullable<ReturnType<typeof prepareMotion>> }) {
  const t = useClockValue(clock, (c) => c.get())
  const k = indexAt(ts, t)
  return (
    <dl className="mt-2 grid grid-cols-5 gap-1 rounded-[var(--radius-panel)] bg-surface p-2 text-center shadow-lift">
      {SERIES_KEYS.map((key) => (
        <div key={key}>
          <dt className="text-xs text-ink-3">{SERIES[key].short}</dt>
          <dd className="text-[15px] font-bold num">
            {fmtNum(prep.series[key][k], SERIES[key].digits)}
            {SERIES[key].unit}
          </dd>
        </div>
      ))}
    </dl>
  )
}

