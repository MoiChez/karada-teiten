// 動きの一覧と結果。撮った動画と 3D の体を並べ、同じ時刻で再生する。下に角度のグラフ、1 回ごとの値、平均、書き出し
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ChevronRight, Columns2, Download, PencilRuler, Redo2, Trash2, Undo2, Video } from 'lucide-react'
import {
  MOTION_KIND_LIST,
  MUSCLE_LABELS,
  PROFILES,
  analyzeMotion,
  compareMotion,
  motionInputOf,
  motionMetric,
  prepareRecord,
  type MetricDef,
  type MotionCycleSummary,
  type MotionEdit,
  type MotionMetric,
  type MotionRecord,
} from '../domain/motion'
import { motionPoses } from '../domain/motionPose'
import { motionCyclesCsv, motionFramesCsv, motionJson } from '../domain/motionExport'
import type { UserProfile } from '../domain/types'
import { fmtDate, fmtNum } from '../domain/format'
import { data } from '../data/repo'
import { useMotions, useProfile } from '../data/hooks'
import { forgetMotionVideo, memoryMotionVideo, type MotionVideoData } from '../state/motionMedia'
import { useToast } from '../state/stores'
import { useClock } from '../components/motionClock'
import { MotionPlayer } from '../components/MotionPlayer'
import { MotionPointEditor } from '../components/MotionPointEditor'
import { CrankChart, SequenceChart } from '../components/MotionProfiles'
import type { ConstraintNote } from '../domain/motionConstraints'
import { BODY_PRIOR, type BodyParams, type ResolvedBody } from '../domain/motionLoad'
import { download } from '../components/download'
import { Badge, Button, ButtonLink, Details, Dialog, EmptyState, IconButton, Notice, Screen, SectionTitle, Segmented, cx } from '../components/ui'

export function fmtMotionValue(def: Pick<MetricDef, 'unit' | 'digits'>, v: number | null | undefined, withUnit = true) {
  if (v === null || v === undefined) return '—'
  const n = fmtNum(v, def.digits)
  if (!withUnit) return n
  return def.unit === '%' || def.unit === '°' ? `${n}${def.unit}` : `${n} ${def.unit}`
}

export function fmtMotionMetric(def: MetricDef, m: MotionMetric | undefined) {
  if (!m || m.status !== 'ok' || m.value === null) return '測定不可'
  return fmtMotionValue(def, m.value)
}

/** 仮定を動かした幅（下限〜上限）。なければ null */
export function motionBandText(def: MetricDef, lo: number | null | undefined, hi: number | null | undefined) {
  if (!def.band || lo === null || lo === undefined || hi === null || hi === undefined) return null
  return `${fmtMotionValue(def, lo, false)}〜${fmtMotionValue(def, hi)}`
}

export function motionDiffText(def: MetricDef, d: number) {
  const u = def.unit === '%' ? ' ポイント' : def.unit === '°' ? '°' : ` ${def.unit}`
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmtNum(Math.abs(d), def.digits)}${u}`
}

// ---------- 一覧 ----------

export function MotionList() {
  const motions = useMotions()
  if (motions === undefined) return <Screen title="動きを撮る" back="/">{null}</Screen>
  const buttons = (
    <div className="grid gap-2">
      {MOTION_KIND_LIST.map((k) => (
        <ButtonLink key={k} to={`/motion/capture?kind=${k}`} variant={k === 'squat' ? 'primary' : 'secondary'} size="lg" block icon={<Video aria-hidden className="size-5" />}>
          {PROFILES[k].label}を撮る
        </ButtonLink>
      ))}
    </div>
  )
  return (
    <Screen title="動きを撮る" back="/">
      {!motions.length ? (
        <EmptyState title="横から動きを撮って、関節の角度の動きを記録します" action={buttons}>
          撮った動画と 3D の体を並べて、スロー再生やコマ送りで見られます。スクワット・ローイングエルゴ・固定式の自転車で、1 回ごとに角度や時間を測ります。
        </EmptyState>
      ) : (
        <>
          <div className="mt-2">{buttons}</div>
          <SectionTitle>記録</SectionTitle>
          <ul className="divide-y divide-line rounded-[var(--radius-panel)] bg-surface shadow-lift">
            {motions.map((m) => {
              const p = PROFILES[m.kind]
              return (
                <li key={m.id}>
                  <Link to={`/motion/${m.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-sunken">
                    <Video aria-hidden className="size-5 shrink-0 text-measure" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium num">
                        {fmtDate(m.createdAt, true)}・{p.label}
                      </p>
                      <p className="text-sm text-ink-3 num">
                        {m.analysis.cycles.length} {p.unitLabel}
                        {p.metrics.slice(0, 2).map((d) => `・${d.short} ${fmtMotionMetric(d, motionMetric(m.analysis, d.key))}`)}
                      </p>
                    </div>
                    <ChevronRight aria-hidden className="size-5 text-ink-3" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Screen>
  )
}

// ---------- 結果 ----------

/** 記録の動画（このページで撮ったばかりならメモリから、残していれば端末から）。なければ null */
export function useMotionVideo(id: string | undefined): MotionVideoData | null | undefined {
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
  return video
}

export function MotionResult() {
  const { id } = useParams()
  const motions = useMotions()
  const profile = useProfile()
  const video = useMotionVideo(id)
  if (motions === undefined || profile === undefined || video === undefined) return <Screen title="動きの記録" back="/motion">{null}</Screen>
  const idx = motions.findIndex((m) => m.id === id)
  if (idx < 0) return <Navigate to="/motion" replace />
  const rec = motions[idx]
  const prev = motions.slice(idx + 1).find((m) => m.kind === rec.kind)
  return <MotionResultBody key={rec.id} rec={rec} prev={prev} video={video} sex={profile?.sex} />
}

/** 器具の前提の説明（使ったとき、使わなかったとき） */
const CONSTRAINT_TEXT: Record<ConstraintNote['key'], [string, string]> = {
  footplate: ['足首はフットプレートに留まっている前提で、中央の位置に置きました。', '足首の点が大きく動いていたため、フットプレートに留める前提は使っていません（スマホを固定して撮ると使えます）。'],
  rail: ['腰はレールに沿って一直線に動く前提で、線の上に乗せました。', '腰の点が一直線に動いていなかったため、レールの前提は使っていません。'],
  knee: [
    '膝は、脚がよく伸びたコマで測った太もも・すねの長さから置き直しました（体が縮んだところで、推定した膝の点がずれやすいため）。',
    '膝の位置は置き直していません。',
  ],
}

function fileStem(rec: MotionRecord) {
  const d = new Date(rec.createdAt)
  const p = (n: number) => String(n).padStart(2, '0')
  return `karada-${rec.kind}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 同じ点・同じコマの前の補正を、新しい補正で置き換える */
function mergeEdits(base: MotionEdit[], added: MotionEdit[]): MotionEdit[] {
  const key = (e: MotionEdit) => `${e.t}:${e.i}`
  const fresh = new Set(added.map(key))
  return [...base.filter((e) => !fresh.has(key(e))), ...added]
}

function MotionResultBody({ rec: saved, prev, video, sex }: { rec: MotionRecord; prev?: MotionRecord; video: MotionVideoData | null; sex?: UserProfile['sex'] }) {
  const navigate = useNavigate()
  const toast = useToast((t) => t.show)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [muscles, setMuscles] = useState(false)
  // 点の補正（この画面を開いている間の取り消し・やり直しを持つ。直すたびに保存する）
  const [work, setWork] = useState(() => ({ edits: saved.edits ?? [], body: saved.body, analysis: saved.analysis }))
  const [past, setPast] = useState<MotionEdit[][]>([])
  const [future, setFuture] = useState<MotionEdit[][]>([])
  const [editing, setEditing] = useState(false)
  const [spread, setSpread] = useState<0 | 5>(5)
  const edits = work.edits
  const profile = PROFILES[saved.kind]
  // 3D の胴の前後の厚みと位置を、動画の人の輪郭に合わせる（横から撮った記録で、まだ測っておらず、動画の画像があるとき）。
  // 測った値は記録に保存し、3D の表示だけに使う（画面に数値は出さない）
  const [torso, setTorso] = useState(saved.torsoDepth)
  useEffect(() => {
    if (torso !== undefined || !video?.images.length || saved.kind === 'squat_front' || saved.analysis.sideView === false) return
    let alive = true
    void import('../pose/torsoMeasure')
      .then((m) => m.measureTorso(video.images))
      .then((t) => {
        if (!alive) return
        setTorso(t)
        void data.saveMotionTorso(saved.id, t)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [torso, video, saved.id, saved.kind, saved.analysis.sideView])
  const rec = useMemo<MotionRecord>(() => ({ ...saved, edits: work.edits, body: work.body, analysis: work.analysis, torsoDepth: torso }), [saved, work, torso])
  // 条件がそろったときだけ出す値（バーの値など）は、値があるときだけ
  const shown = profile.metrics.filter((d) => !d.hidden && !(d.optional && motionMetric(rec.analysis, d.key)?.status !== 'ok'))
  const built = useMemo(() => prepareRecord(rec), [rec])
  const poses = useMemo(() => (built ? motionPoses(built.prep, built.cycles) : []), [built])
  const changes = useMemo(() => (prev ? compareMotion(prev.analysis, rec.analysis) : []), [prev, rec])
  const a = rec.analysis
  // 真横から撮っていない記録で、横から見た値（角度・位置など）か
  const offView = (d: MetricDef) => a.sideView === false && !d.anyView
  // 直した点で計算し直して、すぐ保存する
  const change = (next: MotionEdit[]) => {
    const analysis = analyzeMotion(motionInputOf({ ...saved, edits: next, body: work.body }), saved.kind)
    setWork({ edits: next, body: work.body, analysis })
    void data.saveMotionEdits(saved.id, next, analysis)
  }
  // 体の値を変えて計算し直し、保存する
  const changeBody = (body: BodyParams | undefined) => {
    const analysis = analyzeMotion(motionInputOf({ ...saved, edits: work.edits, body }), saved.kind)
    setWork({ edits: work.edits, body, analysis })
    void data.saveMotionBody(saved.id, body, analysis)
    toast('この値で計算し直しました')
  }
  const apply = (next: MotionEdit[]) => {
    setPast((p) => [...p, edits])
    setFuture([])
    change(next)
  }
  const undo = () => {
    const last = past[past.length - 1]
    if (!last) return
    setPast(past.slice(0, -1))
    setFuture((f) => [edits, ...f])
    change(last)
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setFuture(future.slice(1))
    setPast((p) => [...p, edits])
    change(next)
  }

  const del = async () => {
    await data.deleteMotion(rec.id)
    forgetMotionVideo(rec.id)
    toast('記録を削除しました')
    navigate('/motion', { replace: true })
  }

  return (
    <Screen
      title={profile.label}
      back="/motion"
      action={
        <IconButton label="この記録を削除" onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden className="size-5" />
        </IconButton>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-3 num">{fmtDate(rec.createdAt, true)}</span>
        <Badge tone="measure">
          {a.cycles.length} {profile.unitLabel}
        </Badge>
        <Badge>{rec.source === 'camera' ? 'アプリで撮影' : '選んだ動画'}</Badge>
        <Badge>{rec.videoSaved ? '動画を保存' : '動画は未保存'}</Badge>
        {rec.edits?.length ? <Badge tone="level">点を直した記録</Badge> : null}
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

      {built && poses.length > 1 ? (
        <PlayerWithClock rec={rec} built={built} poses={poses} video={video} sex={sex} muscles={muscles} editor={editing && video ? { spread, onEdit: (added) => apply(mergeEdits(edits, added)) } : undefined} />
      ) : (
        <div className="mt-3">
          <Notice tone="info">再生に使える体の点がありません。</Notice>
        </div>
      )}
      <div className="mt-3 rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={editing ? 'primary' : 'secondary'} disabled={!video} aria-pressed={editing} onClick={() => setEditing(!editing)} icon={<PencilRuler aria-hidden className="size-5" />}>
            {editing ? '点を直すのを終える' : '点を直す'}
          </Button>
          <IconButton label="取り消す" disabled={!past.length} onClick={undo}>
            <Undo2 aria-hidden className="size-5" />
          </IconButton>
          <IconButton label="やり直す" disabled={!future.length} onClick={redo}>
            <Redo2 aria-hidden className="size-5" />
          </IconButton>
          {edits.length > 0 && (
            <Button variant="quiet" onClick={() => apply([])}>
              直した点をすべて戻す
            </Button>
          )}
        </div>
        {!video ? (
          <p className="mt-2 text-sm text-ink-3">点を直すには動画が必要です。動画を残した記録か、撮った直後の画面で使えます。</p>
        ) : editing ? (
          <>
            <p className="mt-2 text-sm text-ink-2">
              動画を止めて、ずれている点をドラッグします（矢印キーでも動かせます）。コマ送りで前後のコマも直せます。直すたびに角度と区切りを計算し直して保存します。推定した点は書き換えずに残します。
            </p>
            <div className="mt-2">
              <Segmented
                legend="直す範囲"
                value={spread}
                onChange={setSpread}
                columns={2}
                options={[
                  { value: 5, label: '前後 5 コマにもなじませる' },
                  { value: 0, label: 'このコマだけ' },
                ]}
              />
            </div>
            <p className="text-sm text-ink-3">直せるのは画面の上の位置だけで、奥行きは直せません。黄色い点が直した点です（{edits.length} か所）。</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-ink-3">直さなくても使えます。点が体から大きくずれているコマがあるときだけ、直してください。</p>
        )}
      </div>
      <label className="mt-1 flex min-h-11 items-center gap-2 text-[15px]">
        <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={muscles} onChange={(e) => setMuscles(e.target.checked)} />
        {profile.load && a.sideView !== false ? '3D の体に、推定した筋肉の要求度を色の濃さで示す' : `3D の体に、${profile.label}で一般に主に使われる筋肉の場所を色で示す`}
      </label>
      {muscles && profile.load && a.sideView !== false && (
        <p className="text-sm text-ink-3">
          色が濃いほど、その時刻にその筋肉に求められる力が大きいという推定です。体の部分の重さ（Winter 2009）と床からの力の仮定から求めた関節の負担と、関節の曲がりから出した目安で、筋電図などで測った値ではありません。
        </p>
      )}
      {muscles && !(profile.load && a.sideView !== false) && (
        <p className="text-sm text-ink-3">
          色を付けた場所: {profile.muscles.map((k) => MUSCLE_LABELS[k]).join('・')}。この種目で一般に主に使われる筋肉のある場所の例で、あなたの筋肉の働きや負担を測ったものではありません。{profile.load ? '真横から撮っていないため、' : 'この種目はハンドルやペダルにかかる力が分からないため、'}濃さ（要求度）は付けていません。
        </p>
      )}
      <p className="mt-2 text-sm text-ink-3">
        {profile.frontal
          ? `3D の体は全員に共通の標準の体で、${a.view?.view === 'front' ? '正面' : '後ろ'}から撮った関節の左右・上下の動きを反映しています。前後の位置は推定モデルの奥行きの推定で、正面・後ろからの映像では外れやすいため参考です。体の左右は、${a.view?.view === 'front' ? '画面の右を体の左' : '画面の左を体の左'}としています。`
          : '3D の体は標準の体をもとに、横から撮った関節の前後・上下の動きを反映しています（手足と胴の長さと、測れたときは胴の前後の厚みと位置を、動画の人に合わせています）。左右の位置は推定モデルの奥行きの推定で、横からの映像では外れやすいため参考です。'}
        {a.sideView === false && '真横から撮っていないため、3D の体の形も正しくありません。'}
        {rec.kind === 'erg' && 'シートとレールは、腰と足首の点の動きから置いた目安の形です。膝・足首・腰は、器具の前提で置き直した位置です（「撮影の情報」に説明があります）。'}
        {rec.kind === 'bike' && 'クランクの円・サドル・ハンドルは、足首・腰・手首の点の動きから置いた目安の形です。奥側の脚は、カメラ側の脚の半回転ずれた動きにしています。膝は、太もも・すねの長さから置き直した位置です。'}
        グラフの帯は 1 {profile.unitLabel}ごとの区間です。
      </p>
      {rec.kind === 'erg' && built && built.cycles.length > 0 && (
        <>
          <SectionTitle sub="ドライブで、脚・上体・腕のそれぞれが、いちばん速く動いた時刻です。">脚・上体・腕が動く順番</SectionTitle>
          <SequenceChart prep={built.prep} cycles={built.cycles} />
        </>
      )}
      {rec.kind === 'bike' && built && built.cycles.length > 0 && (
        <>
          <SectionTitle sub="1 回転の中のクランクの角度ごとに、関節の角度を平均しました。">クランクの角度ごとの曲線</SectionTitle>
          <CrankChart prep={built.prep} cycles={built.cycles} />
        </>
      )}

      {profile.load && <BodyPanel body={work.body} used={a.body} onApply={changeBody} />}

      <SectionTitle sub={`${profile.frontal ? '正面から見た見かけの位置・傾き' : '横から見た見かけの角度・位置'}です。正常範囲とは比べていません。自分の過去の記録と比べるための値です。`}>1 {profile.unitLabel}ごとの値</SectionTitle>
      <div className="overflow-x-auto rounded-[var(--radius-panel)] bg-surface shadow-lift">
        <table className="w-full text-right text-[15px] num" style={{ minWidth: `${80 + shown.length * 64}px` }}>
          <thead className="text-sm text-ink-3">
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-left font-medium">{profile.unitLabel}</th>
              {shown.map((d) => (
                <th key={d.key} className="px-2 py-2 font-medium">
                  {d.short}
                  <span className="block text-xs font-normal">{d.unit}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.cycles.map((c, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-left">{i + 1}</td>
                {shown.map((d) => (
                  <td key={d.key} className={cx('px-2 py-2', offView(d) && 'text-ink-3')}>
                    {fmtMotionValue(d, c.values[d.key], false)}
                    <CycleBand def={d} c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {a.sideView === false && <p className="mt-1 text-sm text-ink-3">灰色の値は、真横から撮っていないため参考になりません。</p>}

      <SectionTitle sub={prev ? `前回（${fmtDate(prev.createdAt)}）との差。${profile.unitLabel}ごとの揺れから見て、差が測定のばらつきを超えるかを示します。` : '2 回目の記録から、前回との差を表示します。'}>
        平均
      </SectionTitle>
      {prev && (
        <ButtonLink to={`/motion/compare?a=${prev.id}&b=${rec.id}`} variant="secondary" block className="mb-3" icon={<Columns2 aria-hidden className="size-5" />}>
          前回と並べて比べる
        </ButtonLink>
      )}
      <ul className="space-y-3">
        {shown.map((def) => {
          const m = motionMetric(a, def.key)
          const band = def.band ? motionBandText(def, motionMetric(a, def.band[0])?.value, motionMetric(a, def.band[1])?.value) : null
          const ch = changes.find((c) => c.key === def.key)
          const pm = prev ? motionMetric(prev.analysis, def.key) : undefined
          return (
            <li key={def.key} className="rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-bold">{def.label}</h3>
                <span className={cx('shrink-0 text-[22px] font-bold num', offView(def) && 'text-ink-3')}>{fmtMotionMetric(def, m)}</span>
              </div>
              {offView(def) && (
                <div className="mt-1 text-right">
                  <Badge tone="attention">真横でないため参考になりません</Badge>
                </div>
              )}
              {band && (
                <p className="mt-0.5 text-right text-sm text-ink-2 num">
                  <Badge tone="level">条件付きの推定</Badge> 仮定を動かした幅 {band}
                </p>
              )}
              {m?.status === 'ok' && m.sd !== null && (
                <p className="mt-0.5 text-right text-sm text-ink-3 num">
                  {profile.unitLabel}ごとの揺れ ±{fmtMotionValue({ unit: def.unit, digits: def.digits + 1 }, m.sd)}・{m.reps} {profile.unitLabel}
                </p>
              )}
              {prev && pm && (
                <p className="mt-2 text-[15px] text-ink-2 num">
                  前回 {fmtMotionMetric(def, pm)}
                  {ch && (
                    <>
                      {' '}→ 差 {motionDiffText(def, ch.diff)} <Badge tone={ch.noticeable ? 'attention' : 'neutral'}>{ch.noticeable ? '差が見られる' : 'ばらつきの範囲内'}</Badge>
                    </>
                  )}
                </p>
              )}
              {def.reference && <p className="mt-2 rounded-[var(--radius-control)] bg-sunken p-2.5 text-sm text-ink-2">{def.reference}</p>}
              <Details summary="この値について">{def.doc}</Details>
            </li>
          )
        })}
      </ul>

      <SectionTitle sub="この端末の中でファイルを作ります。どこにも送りません。">書き出す</SectionTitle>
      <div className="grid gap-2">
        <Button
          variant="secondary"
          block
          icon={<Download aria-hidden className="size-5" />}
          disabled={!built}
          onClick={() => built && download(`${fileStem(rec)}-frames.csv`, new Blob([motionFramesCsv(rec, built.prep, built.cycles)], { type: 'text/csv' }))}
        >
          コマごとの値（CSV）
        </Button>
        <Button variant="secondary" block icon={<Download aria-hidden className="size-5" />} onClick={() => download(`${fileStem(rec)}-cycles.csv`, new Blob([motionCyclesCsv(rec)], { type: 'text/csv' }))}>
          1 {profile.unitLabel}ごとの値（CSV）
        </Button>
        <Button variant="secondary" block icon={<Download aria-hidden className="size-5" />} onClick={() => download(`${fileStem(rec)}.json`, new Blob([motionJson(rec)], { type: 'application/json' }))}>
          記録そのもの（JSON。動画は含めない）
        </Button>
      </div>

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
            {rec.edits?.length ? <li>手で直した点 {rec.edits.length} か所（推定した点は書き換えずに残しています）</li> : null}
            {a.constraints?.map((c) => (
              <li key={c.key}>{CONSTRAINT_TEXT[c.key][c.applied ? 0 : 1]}</li>
            ))}
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

/** 表の 1 回の値の下に、仮定を動かした幅を小さく出す */
function CycleBand({ def, c }: { def: MetricDef; c: MotionCycleSummary }) {
  const text = def.band ? motionBandText(def, c.values[def.band[0]], c.values[def.band[1]]) : null
  return text ? <span className="block text-xs text-ink-3">{text}</span> : null
}

const numOr = (s: string) => {
  const v = Number(s.replace(',', '.'))
  return s.trim() && Number.isFinite(v) ? v : undefined
}

/** 重心と負担の推定に使う、身長・体重・持つ重さ。入れなければ仮定の値を使い、「仮定」と出す */
function BodyPanel({ body, used, onApply }: { body: BodyParams | undefined; used: ResolvedBody | undefined; onApply: (b: BodyParams | undefined) => void }) {
  const [h, setH] = useState(body?.heightCm ? String(body.heightCm) : '')
  const [w, setW] = useState(body?.weightKg ? String(body.weightKg) : '')
  const [l, setL] = useState(body?.loadKg ? String(body.loadKg) : '')
  const next: BodyParams = { heightCm: numOr(h), weightKg: numOr(w), loadKg: numOr(l) }
  const changed = next.heightCm !== body?.heightCm || next.weightKg !== body?.weightKg || next.loadKg !== body?.loadKg
  const field = (label: string, unit: string, value: string, set: (v: string) => void, assumed: boolean | undefined, prior: number) => (
    <label className="block">
      <span className="flex items-center gap-1.5 text-sm text-ink-2">
        {label}
        {assumed ? <Badge tone="attention">仮定 {prior}</Badge> : <Badge tone="measure">入力</Badge>}
      </span>
      <span className="mt-1 flex items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          className="min-h-11 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-[16px] num"
          value={value}
          placeholder={String(prior)}
          onChange={(e) => set(e.target.value)}
        />
        <span className="text-sm text-ink-3">{unit}</span>
      </span>
    </label>
  )
  return (
    <section className="mt-4 rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift" aria-labelledby="body-panel-title">
      <h2 id="body-panel-title" className="font-bold">
        重心と負担の推定に使う値
      </h2>
      <p className="mt-1 text-sm text-ink-3">
        入れなければ、身長 {BODY_PRIOR.heightCm} cm・体重 {BODY_PRIOR.weightKg} kg・持つ重さ {BODY_PRIOR.loadKg} kg と仮定します。体重と重さは、重心と「股関節と膝の負担の比」を求めるのに使うだけで、力の大きさ（Nm）は出しません。持つ重さを入れると、手首の点をバーの位置とみなして、バーの軌道（動画の白い線）と、前後のぶれ・上がる速さも出します。
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {field('身長', 'cm', h, setH, used?.assumed.height, BODY_PRIOR.heightCm)}
        {field('体重', 'kg', w, setW, used?.assumed.weight, BODY_PRIOR.weightKg)}
        {field('持つ重さ', 'kg', l, setL, used?.assumed.load, BODY_PRIOR.loadKg)}
      </div>
      <Button className="mt-3" variant="secondary" block disabled={!changed} onClick={() => onApply(next.heightCm || next.weightKg || next.loadKg ? next : undefined)}>
        この値で計算し直す
      </Button>
      <div className="mt-3" />
      <Notice tone="info" title="重心と負担は推定です">
        床からの力や筋肉の働きは測っていません。体の部分ごとの重さの割合（Winter 2009）と画面の上の点から重心を求め、ゆっくりした動きでは体がほぼつり合うので、床からの力が重心の真下に左右半分ずつかかると仮定して、股関節と膝の負担（力のモーメント）の比を求めています。帯と「幅」は、その位置を足の長さの ±25%、左右を 4:6〜6:4 に動かしたときの範囲です。奥側の手足はカメラ側と同じ位置とみなしています。持つ重さは手首の位置にあるとしています。
      </Notice>
    </section>
  )
}

function PlayerWithClock({
  rec,
  built,
  poses,
  video,
  sex,
  muscles,
  editor,
}: {
  rec: MotionRecord
  built: NonNullable<ReturnType<typeof prepareRecord>>
  poses: ReturnType<typeof motionPoses>
  video: MotionVideoData | null
  sex?: UserProfile['sex']
  muscles: boolean
  editor?: { spread: number; onEdit: (edits: MotionEdit[]) => void }
}) {
  const ts = built.prep.frames.map((f) => f.t)
  const start = video?.images.length ? Math.min(video.images[0].t, ts[0]) : ts[0]
  const end = video?.images.length ? Math.max(video.images[video.images.length - 1].t, ts[ts.length - 1]) : ts[ts.length - 1]
  const clock = useClock(start, end)
  return (
    <MotionPlayer
      rec={rec}
      prep={built.prep}
      cycles={built.cycles}
      poses={poses}
      video={video}
      sex={sex}
      clock={clock}
      muscles={muscles}
      autoplay={!editor}
      exportName={editor ? undefined : fileStem(rec)}
      videoOverlay={editor ? <MotionPointEditor prep={built.prep} clock={clock} spread={editor.spread} onEdit={editor.onEdit} /> : undefined}
    />
  )
}
