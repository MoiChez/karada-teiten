// 動きの一覧と結果。結果は、上に動画・3D・再生の操作（画面の上に留まる）、下に開いたり閉じたりする項目（数値・グラフ・書き出しなど）
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ChevronRight, Columns2, Download, PencilRuler, Redo2, Trash2, Undo2, Video } from 'lucide-react'
import {
  MOTION_KIND_LIST,
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
import { metricDoc } from '../domain/motionSports'
import { TORSO_PROFILE_VERSION } from '../domain/torsoDepth'
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
import { Button, ButtonLink, Details, Dialog, EmptyState, Fold, IconButton, Notice, Screen, SectionTitle, cx } from '../components/ui'

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

/** 要点の帯に出す値（種目ごとに 3〜4 個。なければ表の先頭から） */
const STRIP_KEYS: Partial<Record<MotionRecord['kind'], string[]>> = {
  squat: ['knee', 'trunk', 'thigh_bottom', 'ascent'],
  erg: ['rate', 'ratio', 'trunk_catch', 'trunk_finish'],
  bike: ['cadence', 'knee_bdc', 'trunk'],
}

/** 標準偏差を出す桁（時間は 0.01 秒まで。コマの間隔より細かくしない） */
const sdDigits = (def: MetricDef) => (def.unit === '秒' ? 2 : def.digits)

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
        <ButtonLink key={k} to={`/motion/capture?kind=${k}`} variant="secondary" size="lg" block icon={<Video aria-hidden className="size-5" />}>
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
          <ul className="divide-y divide-line border-y border-line">
            {motions.map((m) => {
              const p = PROFILES[m.kind]
              return (
                <li key={m.id}>
                  <Link to={`/motion/${m.id}`} className="flex min-h-14 items-center gap-3 py-3 hover:bg-sunken">
                    <Video aria-hidden className="size-5 shrink-0 text-measure" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{p.label}</p>
                      <p className="text-sm text-ink-2 num">{fmtDate(m.createdAt, true)}</p>
                      <p className="flex flex-wrap gap-x-2 text-sm text-ink-2 num">
                        <span className="whitespace-nowrap">
                          {m.analysis.cycles.length} {p.unitLabel}
                        </span>
                        {p.metrics.slice(0, 2).map((d) => (
                          <span key={d.key} className="whitespace-nowrap">
                            {d.short} {fmtMotionMetric(d, motionMetric(m.analysis, d.key))}
                          </span>
                        ))}
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

/** 再生の操作のすぐ下に出す要点の帯（主な値の平均と、前回との差の有無）。詳しくは「平均」を開く */
function SummaryStrip({
  rec,
  prev,
  changes,
  offView,
}: {
  rec: MotionRecord
  prev?: MotionRecord
  changes: ReturnType<typeof compareMotion>
  offView: (d: MetricDef) => boolean
}) {
  const profile = PROFILES[rec.kind]
  const keys = STRIP_KEYS[rec.kind] ?? profile.metrics.filter((d) => !d.hidden && !d.estimate).slice(0, 3).map((d) => d.key)
  const items = keys
    .map((k) => profile.metrics.find((d) => d.key === k))
    .filter((d): d is MetricDef => !!d)
    .map((def) => ({ def, m: motionMetric(rec.analysis, def.key), ch: changes.find((c) => c.key === def.key) }))
    .filter(({ m }) => m?.status === 'ok')
  if (!items.length) return null
  return (
    <section aria-label="主な値（平均）" className="border-t border-line py-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 min-[420px]:grid-cols-4">
        {items.map(({ def, m, ch }) => (
          <div key={def.key} className="min-w-0">
            <dt className="truncate text-sm text-ink-2">{def.short}</dt>
            <dd className={cx('text-[20px] leading-tight font-bold whitespace-nowrap num', offView(def) && 'text-ink-3')}>{fmtMotionMetric(def, m)}</dd>
            {prev && ch && <dd className="text-sm whitespace-nowrap text-ink-2 num">前回から {motionDiffText(def, ch.diff)}{ch.judged ? (ch.noticeable ? '・差あり' : '') : ''}</dd>}
          </div>
        ))}
      </dl>
      <p className="mt-2 text-sm text-ink-3">
        {rec.analysis.cycles.length} {profile.unitLabel}の平均{prev ? `。前回（${fmtDate(prev.createdAt)}）との差` : ''}。詳しくは「平均」を開いてください。
      </p>
    </section>
  )
}

/** 器具に合わせて点を置き直したか（置き直したとき、しなかったとき） */
const CONSTRAINT_TEXT: Record<ConstraintNote['key'], [string, string]> = {
  footplate: ['足首は、フットプレートの上で動かないものとして置きました。', '足首の点が大きく動いたので、フットプレートに固定していません（スマホを固定して撮ると使えます）。'],
  rail: ['腰は、レールに沿ってまっすぐ動くものとして置きました。', '腰の点がまっすぐ動かなかったので、レールには合わせていません。'],
  knee: ['膝は、太ももとすねの長さから置き直しました。脚を畳んだところで、推定の膝がずれやすいためです。', '膝の位置は置き直していません。'],
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
  // 点の補正（この画面を開いている間の取り消し・やり直しを持つ。直すたびに保存する）
  const [work, setWork] = useState(() => ({ edits: saved.edits ?? [], body: saved.body, analysis: saved.analysis }))
  const [past, setPast] = useState<MotionEdit[][]>([])
  const [future, setFuture] = useState<MotionEdit[][]>([])
  const [editing, setEditing] = useState(false)
  const [spread, setSpread] = useState<0 | 5>(5)
  const edits = work.edits
  const profile = PROFILES[saved.kind]
  const [torso, setTorso] = useState(saved.torsoDepth)
  const [arms, setArms] = useState(saved.arms)
  const rec = useMemo<MotionRecord>(() => ({ ...saved, edits: work.edits, body: work.body, analysis: work.analysis, torsoDepth: torso, arms }), [saved, work, torso, arms])
  // 条件がそろったときだけ出す値（バーの値など）は、値があるときだけ
  // 条件がそろったときだけ出す値と、斜めなどから撮って求められなかった値（重心・負担の比・バー）は、値があるときだけ
  const shown = profile.metrics.filter((d) => !d.hidden && !((d.optional || rec.analysis.angles3d) && motionMetric(rec.analysis, d.key)?.status !== 'ok'))
  const built = useMemo(() => prepareRecord(rec), [rec])
  const poses = useMemo(() => (built ? motionPoses(built.prep, built.cycles) : []), [built])
  // 3D の胴の前後の厚みと位置を、動画の人の輪郭に合わせる（横から撮った記録で、まだ測っていないか測り方の版が古く、
  // 動画の画像があるとき）。胴の線は 3D を置くのと同じ推定の点で決める。測った値は記録に保存し、3D の表示だけに使う
  // （画面に数値は出さない）
  const framesRef = useRef(built?.prep)
  framesRef.current = built?.prep
  const torsoStale = torso === undefined || (torso !== null && torso.version !== TORSO_PROFILE_VERSION)
  useEffect(() => {
    if (!torsoStale || !video?.images.length || saved.kind === 'squat_front' || saved.analysis.sideView === false) return
    let alive = true
    void import('../pose/torsoMeasure')
      .then((m) => m.measureTorso(video.images, framesRef.current?.frames, framesRef.current?.nearSide))
      .then((t) => {
        if (!alive) return
        setTorso(t)
        void data.saveMotionTorso(saved.id, t)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [torsoStale, video, saved.id, saved.kind, saved.analysis.sideView])
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

  // 要点の帯のすぐ下に並べる項目（平均 → 1 回ごと）。どれも初めは閉じている
  const leadFolds = (
    <>
      <Fold title="平均" hint={prev ? '前回との差つき' : undefined}>
        {prev ? (
          <>
            <ButtonLink to={`/motion/compare?a=${prev.id}&b=${rec.id}`} variant="secondary" block className="mb-1" icon={<Columns2 aria-hidden className="size-5" />}>
              前回と並べて比べる
            </ButtonLink>
            <p className="text-sm text-ink-2">
              「差あり」は、前回との差が比べる幅（{profile.unitLabel}ごとの揺れから求めた幅。下限は推定の点の揺れから決めた目安）を超えたときです。良し悪しは判定しません。
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-3">2 回目の記録から、前回との差が出ます。</p>
        )}
        <ul className="divide-y divide-line">
          {shown.map((def) => {
            const m = motionMetric(a, def.key)
            const band = def.band ? motionBandText(def, motionMetric(a, def.band[0])?.value, motionMetric(a, def.band[1])?.value) : null
            const ch = changes.find((c) => c.key === def.key)
            const pm = prev ? motionMetric(prev.analysis, def.key) : undefined
            return (
              <li key={def.key} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[15px] font-medium">
                    {def.label}
                    {def.estimate && <span className="ml-1.5 rounded-full bg-sunken px-1.5 text-[13px] font-medium text-ink-2">推定</span>}
                  </h3>
                  <span className={cx('shrink-0 text-[20px] font-bold whitespace-nowrap num', offView(def) && 'text-ink-3')}>{fmtMotionMetric(def, m)}</span>
                </div>
                <div className="text-right text-sm text-ink-2 num">
                  {offView(def) && <p>真横から撮れていないので当てになりません</p>}
                  {band && <p>仮定を動かすと {band}</p>}
                  {m?.status === 'ok' && m.sd !== null && (
                    <p>
                      {profile.unitLabel}ごとの標準偏差 {fmtMotionValue({ unit: def.unit, digits: sdDigits(def) }, m.sd)}・{m.reps} {profile.unitLabel}
                    </p>
                  )}
                  {prev && pm && (
                    <p>
                      前回 {fmtMotionMetric(def, pm)}
                      {ch && (
                        <>
                          {' '}→ 差 {motionDiffText(def, ch.diff)}
                          {ch.judged ? (
                            <>
                              （比べる幅 ±{fmtNum(ch.width, sdDigits(def))}）・<span className={ch.noticeable ? 'font-bold text-ink' : undefined}>{ch.noticeable ? '差あり' : '幅の内'}</span>
                            </>
                          ) : (
                            '・推定のため判定しません'
                          )}
                        </>
                      )}
                    </p>
                  )}
                </div>
                {def.reference && <p className="mt-1.5 text-sm text-ink-2">{def.reference}</p>}
                <Details summary="この値について">{metricDoc(def, rec.analysis.angles3d)}</Details>
              </li>
            )
          })}
        </ul>
      </Fold>

      <Fold title={`1 ${profile.unitLabel}ごとの値`} hint={`${a.cycles.length} ${profile.unitLabel}`}>
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full text-right text-[15px] num" style={{ minWidth: `${80 + shown.length * 64}px` }}>
            <thead className="text-sm text-ink-3">
              <tr className="border-b border-ink/30">
                <th className="sticky left-0 bg-paper py-2 pr-3 text-left font-medium">{profile.unitLabel}</th>
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
                  <td className="sticky left-0 bg-paper py-2 pr-3 text-left">{i + 1}</td>
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
        {a.sideView === false && <p className="mt-2 text-sm text-ink-3">灰色の値は、真横から撮れていないので当てになりません。</p>}
      </Fold>
    </>
  )

  // グラフ・今の値・筋肉のあとに並べる項目
  const folds = (
    <>
      {rec.kind === 'erg' && built && built.cycles.length > 0 && (
        <Fold title="脚・上体・腕の順番">
          <SequenceChart prep={built.prep} cycles={built.cycles} flat />
        </Fold>
      )}
      {rec.kind === 'bike' && built && built.cycles.length > 0 && (
        <Fold title="クランクの角度ごと">
          <CrankChart prep={built.prep} cycles={built.cycles} flat />
        </Fold>
      )}

      {profile.load && (
        <Fold title="身長・体重・重さ" hint={a.body && (a.body.assumed.height || a.body.assumed.weight) ? '仮定の値' : undefined}>
          <BodyPanel body={work.body} used={a.body} onApply={changeBody} />
        </Fold>
      )}

      <Fold title="点を直す" hint={editing ? '直しています' : edits.length ? `${edits.length} か所` : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={editing ? 'primary' : 'secondary'} disabled={!video} aria-pressed={editing} onClick={() => setEditing(!editing)} icon={<PencilRuler aria-hidden className="size-5" />}>
            {editing ? '直すのを終える' : '点を直す'}
          </Button>
          <IconButton label="取り消す" disabled={!past.length} onClick={undo}>
            <Undo2 aria-hidden className="size-5" />
          </IconButton>
          <IconButton label="やり直す" disabled={!future.length} onClick={redo}>
            <Redo2 aria-hidden className="size-5" />
          </IconButton>
          {edits.length > 0 && (
            <Button variant="quiet" onClick={() => apply([])}>
              すべて戻す
            </Button>
          )}
        </div>
        {!video ? (
          <p className="mt-2 text-sm text-ink-3">動画を残した記録でだけ直せます。</p>
        ) : editing ? (
          <>
            <p className="mt-2 text-[15px] text-ink-2">動画を止めて、ずれた点をドラッグします。直すたびに計算し直して保存します。</p>
            <label className="mt-1 flex min-h-11 items-center gap-2 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={spread === 5} onChange={(e) => setSpread(e.target.checked ? 5 : 0)} />
              前後 5 コマにもなじませる
            </label>
            <p className="text-sm text-ink-3">直せるのは画面の上の位置だけです。黄色が直した点（{edits.length} か所）。</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-ink-3">点が体から大きくずれたコマだけ、直してください。</p>
        )}
      </Fold>
    </>
  )

  const exportButtons = (
    <>
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
        記録（JSON・動画なし）
      </Button>
    </>
  )

  // 説明と注意は、ここ 1 か所にまとめる
  const about = (
    <Fold title="この表示について">
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] text-ink-2">
        <li>3D は標準の体に、動画から推定した関節の動きをのせたものです。{!profile.frontal && '手足と胴の長さは、動画の人に合わせています。'}</li>
        {profile.frontal ? (
          <li>
            {a.view?.view === 'front' ? '正面' : '後ろ'}から撮った動画なので、前後の位置は当てになりません。{a.view?.view === 'front' ? '画面の右' : '画面の左'}を体の左としています。
          </li>
        ) : (
          <li>横から撮った動画なので、体の左右の位置は当てになりません。</li>
        )}
        {a.sideView === false && <li>真横から撮れていないので、3D の形と角度は当てになりません。</li>}
        {rec.kind === 'erg' && <li>シートとレールは、腰と足首の動きから置いた目安です。</li>}
        {rec.kind === 'bike' && <li>クランク・サドル・ハンドルは、足首・腰・手首の動きから置いた目安です。奥の脚は、手前の脚を半回転ずらした動きです。</li>}
        <li>角度は、1 台のカメラの映像から求めた見かけの値です。骨の角度ではありません。</li>
        <li>動きの良し悪しや、正常かどうかは判定していません。自分の過去の記録と比べるための値です。</li>
        <li>{rec.videoSaved ? '動画は、この端末にだけ保存しています。' : '動画は保存していません。保存しているのは、体の点の動きだけです。'}</li>
      </ul>
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
          <li>{rec.source === 'camera' ? 'アプリで撮影' : '選んだ動画'}</li>
          {rec.edits?.length ? <li>手で直した点 {rec.edits.length} か所（推定した点は残しています）</li> : null}
          {a.constraints?.map((c) => (
            <li key={c.key}>{CONSTRAINT_TEXT[c.key][c.applied ? 0 : 1]}</li>
          ))}
        </ul>
      </Details>
    </Fold>
  )

  return (
    <Screen
      title={profile.label}
      back="/motion"
      staticHeader
      action={
        <IconButton label="この記録を削除" onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden className="size-5" />
        </IconButton>
      }
    >
      <p className="text-sm text-ink-3 num">
        {fmtDate(rec.createdAt, true)}・{a.cycles.length} {profile.unitLabel}・{rec.videoSaved ? '動画あり' : '動画なし'}
        {rec.edits?.length ? '・点を直した記録' : ''}
      </p>

      {a.warnings.length > 0 && (
        <div className="mt-2 text-[15px]">
          <p className="font-bold text-attention">撮影の注意</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
            {a.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        {built && poses.length > 1 ? (
          <PlayerWithClock
            rec={rec}
            built={built}
            poses={poses}
            video={video}
            sex={sex}
            editor={editing && video ? { spread, onEdit: (added) => apply(mergeEdits(edits, added)) } : undefined}
            exportExtra={exportButtons}
            tail={about}
            lead={
              <>
                <SummaryStrip rec={rec} prev={prev} changes={changes} offView={offView} />
                {leadFolds}
              </>
            }
            onArms={(a) => {
              setArms(a)
              void data.saveMotionArms(saved.id, a)
            }}
          >
            {folds}
          </PlayerWithClock>
        ) : (
          <>
            <Notice tone="info">再生に使える体の点がありません。</Notice>
            <div className="mt-3 border-b border-line">
              {leadFolds}
              {folds}
              <Fold title="書き出す">
                <p className="text-sm text-ink-3">ファイルはこの端末の中で作ります。どこにも送りません。</p>
                <div className="mt-3 grid gap-2">{exportButtons}</div>
              </Fold>
              {about}
            </div>
          </>
        )}
      </div>

      <p className="mt-4 text-sm text-ink-3">医療診断ではありません。</p>

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
      <span className="text-sm text-ink-2">
        {label}
        {assumed && <span className="ml-1.5 text-attention">仮定 {prior}</span>}
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
    <>
      <p className="text-sm text-ink-3">
        重心と、股関節と膝の負担の比を求めるのに使います。入れなければ、身長 {BODY_PRIOR.heightCm} cm・体重 {BODY_PRIOR.weightKg} kg・重さ {BODY_PRIOR.loadKg} kg と仮定します。持つ重さを入れると、バーの軌道（動画の白い線）も出ます。
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {field('身長', 'cm', h, setH, used?.assumed.height, BODY_PRIOR.heightCm)}
        {field('体重', 'kg', w, setW, used?.assumed.weight, BODY_PRIOR.weightKg)}
        {field('持つ重さ', 'kg', l, setL, used?.assumed.load, BODY_PRIOR.loadKg)}
      </div>
      <Button className="mt-3" variant="secondary" block disabled={!changed} onClick={() => onApply(next.heightCm || next.weightKg || next.loadKg ? next : undefined)}>
        この値で計算し直す
      </Button>
      <Details summary="推定のしかた">
        床からの力や筋肉の働きは測っていません。重心は、体の部分ごとの重さの割合（Winter 2009）と画面の上の点から求めています。床からの力は、重心の真下に、左右半分ずつかかると仮定しました。帯と「幅」は、その位置を足の長さの ±25%、左右を 4:6〜6:4 に動かしたときの範囲です。奥の手足は手前と同じ位置、持つ重さは手首の位置にあるとしています。力の大きさ（Nm）は出していません。
      </Details>
    </>
  )
}

function PlayerWithClock({
  rec,
  built,
  poses,
  video,
  sex,
  editor,
  exportExtra,
  tail,
  lead,
  children,
  onArms,
}: {
  rec: MotionRecord
  lead?: ReactNode
  built: NonNullable<ReturnType<typeof prepareRecord>>
  poses: ReturnType<typeof motionPoses>
  video: MotionVideoData | null
  sex?: UserProfile['sex']
  editor?: { spread: number; onEdit: (edits: MotionEdit[]) => void }
  exportExtra?: ReactNode
  tail?: ReactNode
  children?: ReactNode
  onArms?: (arms: MotionRecord['arms']) => void
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
      autoplay={!editor}
      exportName={editor ? undefined : fileStem(rec)}
      exportExtra={exportExtra}
      tail={tail}
      lead={lead}
      onArms={onArms}
      videoOverlay={editor ? <MotionPointEditor prep={built.prep} clock={clock} spread={editor.spread} onEdit={editor.onEdit} /> : undefined}
    >
      {children}
    </MotionPlayer>
  )
}
