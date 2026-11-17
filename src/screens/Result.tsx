import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { Box, Camera, ClipboardList, Columns2, Footprints, PencilRuler, Trash2 } from 'lucide-react'
import type { AssessmentSession, ComputedMetric, Plane, PlaneRecord } from '../domain/types'
import { AREA_LABELS, SESSION_TAG_LABELS, confidenceLabel, fmtDate, fmtShortDate, primaryValue } from '../domain/format'
import { gaugeRows } from '../domain/gauge'
import { deriveHypotheses } from '../domain/hypotheses'
import { buildPlan, recentDiscomfort, DISCOMFORT_EXCLUDED_REASON } from '../domain/recommend/engine'
import { routineById } from '../domain/recommend/routines'
import { compareConscious } from '../domain/conscious'
import { correctedSet, correctionDiffs } from '../domain/session'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../data/db'
import { data } from '../data/repo'
import { useCheckins, useLogs, useProfile, useSession, useSessions } from '../data/hooks'
import { MetricList } from '../components/MetricList'
import { GaugeTable, LoadShiftFeet } from '../components/Gauge'
import { BurstNote } from '../components/BurstNote'
import { backSideOf } from '../domain/backContour'
import { ConsciousSection } from '../components/ConsciousSection'
import { PhotoWithPose, PostureGrid, useStoredImageUrl } from '../components/PoseViews'
import { RoutineItem } from '../components/RoutineItem'
import { SessionTags } from '../components/SessionTags'
import { Badge, Button, ButtonLink, Dialog, Fold, IconButton, Notice, Screen, Segmented, cx } from '../components/ui'
import { useDraft, useToast } from '../state/stores'

// 3D（three.js）は重いので、開いたときに読み込む
const StandingPreview = lazy(() => import('../three/StandingPreview'))

const PLANE_NAME: Record<Plane, string> = { front: '正面', side: '横向き' }

export function Result() {
  const { id } = useParams()
  const session = useSession(id)
  if (session === undefined) return <Screen title="分析結果" back="/history">{null}</Screen>
  if (!session) return <Navigate to="/history" replace />
  return <ResultBody s={session} />
}

/** 横向きの事実（判定はしない）。頭と上半身の位置だけを短く */
function sideFacts(metrics: ComputedMetric[], heightCm: number | undefined): string[] {
  const out: string[] = []
  const head = metrics.find((m) => m.key === 'side_head_forward')
  if (head?.rawValue != null) {
    const v = primaryValue(head, heightCm)
    out.push(`耳は肩の真上より${head.rawValue >= 0 ? '前' : '後ろ'}に${v.endsWith('未満') ? v : `約 ${v}`}`)
  }
  const trunk = metrics.find((m) => m.key === 'side_trunk_lean')
  if (trunk?.rawValue != null) out.push(`上半身は股関節の真上から${trunk.rawValue >= 0 ? '前' : '後ろ'}へ約 ${primaryValue(trunk, undefined)}`)
  return out
}

function ResultBody({ s }: { s: AssessmentSession }) {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast((t) => t.show)
  const profile = useProfile()
  const logs = useLogs()
  const checkins = useCheckins()
  const sessions = useSessions()
  const storedPlan = useLiveQuery(() => (s.recommendationSnapshot ? db.plans.get(s.recommendationSnapshot.planId) : undefined), [s.recommendationSnapshot?.planId])
  const planes: Plane[] = [s.front && 'front', s.side && 'side'].filter(Boolean) as Plane[]
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showGuides, setShowGuides] = useState(true)
  const [useCorrected, setUseCorrected] = useState(true)
  const [consciousPlane, setConsciousPlane] = useState<Plane>(planes[0] ?? 'front')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const noticeable = useMemo(() => s.postureTraits.filter((t) => t.status === 'noticeable').sort((a, b) => b.magnitude - a.magnitude), [s])
  const hypotheses = useMemo(() => deriveHypotheses(s.postureTraits, profile ?? undefined), [s, profile])
  const checkin = checkins?.find((c) => c.id === s.checkinId)
  const plan = useMemo(
    () =>
      storedPlan ??
      buildPlan({ traits: s.postureTraits, profile: profile ?? undefined, recentLogs: logs?.slice(-30), fatigue: checkin?.fatigueRating, basedOnAssessmentId: s.id, lastAssessmentAt: s.createdAt, conscious: compareConscious(s) }),
    [storedPlan, s, profile, logs, checkin],
  )
  // 直近 7 日に「痛みや違和感があった」と記録したメニューは出さない（前に作った提案にも当てる）
  const excluded = useMemo(() => [...recentDiscomfort(logs, new Date())].filter(([, v]) => v === 'yes').map(([id]) => id), [logs])
  const priority = plan.routines.filter((r) => r.slot === 'priority' && !excluded.includes(r.routineId))
  const actions = (priority.length ? priority : plan.routines.filter((r) => r.slot === 'set5' && !excluded.includes(r.routineId))).slice(0, 3)
  const today = actions[0]
  const todayRoutine = today ? routineById(today.routineId) : undefined
  const ordered = (sessions ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const prev = ordered.filter((x) => x.createdAt < s.createdAt).at(-1)
  const diffs = correctionDiffs(s)
  const majorFlags = s.qualityFlags.filter((f) => f.severity !== 'minor')
  const heightCm = profile?.heightCm
  const corrected = (s.front && correctedSet(s.front).size > 0) || (s.side && correctedSet(s.side).size > 0)
  const facts = s.side ? sideFacts(s.computedMetrics, heightCm) : []
  const frontNoticeable = noticeable.filter((t) => t.plane === 'front')

  // 意識した姿勢を撮って戻ってきたときは、その比較を開いて移動する
  const focus = (location.state as { focus?: string } | null)?.focus
  // 測った直後は、スマホを置いたまま意識した姿勢も撮れるように案内する
  const justMeasured = !!(location.state as { justMeasured?: boolean } | null)?.justMeasured
  const startConscious = useDraft((d) => d.startConscious)
  const [offerConscious, setOfferConscious] = useState(justMeasured && !s.conscious)
  useEffect(() => {
    if (focus !== 'conscious') return
    const t = setTimeout(() => document.getElementById('conscious-fold')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
    return () => clearTimeout(t)
  }, [focus])

  const del = async () => {
    await data.deleteSession(s.id)
    toast('記録を削除しました')
    navigate('/history', { replace: true })
  }

  return (
    <Screen
      title="分析結果"
      back="/history"
      action={
        <IconButton label="この記録を削除" onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden className="size-5" />
        </IconButton>
      }
    >
      <p className="text-sm text-ink-2 num">
        {fmtDate(s.createdAt, true)}
        {s.tags?.length ? `・${s.tags.map((t) => SESSION_TAG_LABELS[t]).join('・')}` : ''}
      </p>

      {offerConscious && (
        <div className="mt-3">
          <Notice tone="info" title="続けて、自分が良いと思う姿勢でも撮りますか（任意・1 分）">
            <p>スマホを置いたまま撮ると、意識して変わる差と、意識しても残る差を分けて見られます。</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={<Camera aria-hidden className="size-4" />}
                onClick={() => {
                  startConscious(s.id)
                  navigate(`/measure/conscious/capture/${s.front ? 'front' : 'side'}`)
                }}
              >
                続けて撮る
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setOfferConscious(false)}>
                今はしない
              </Button>
            </div>
          </Notice>
        </div>
      )}

      {/* 1. まとめ: 事実 → 今日の 1 つ → 次の行動 */}
      <section aria-labelledby="sum" className="mt-3">
        <h2 id="sum" className="text-[19px] font-bold">
          今回わかったこと
        </h2>
        <ul className="mt-2 space-y-2">
          {s.front &&
            (frontNoticeable.length ? (
              frontNoticeable.slice(0, 2).map((t) => (
                <li key={t.key} className="rule-fact pl-3">
                  <p className="font-bold">{t.label}</p>
                  <p className="text-[15px] text-ink-2">{t.summary}</p>
                  {t.relatedAreas.filter((a) => a !== 'whole_body').length > 0 && (
                    <p className="text-sm text-ink-3">関連が考えられる部位（参考）: {t.relatedAreas.filter((a) => a !== 'whole_body').map((a) => AREA_LABELS[a]).join('・')}</p>
                  )}
                </li>
              ))
            ) : (
              <li className="rule-fact pl-3 text-[17px]">正面から見て、左右のはっきりした差はありませんでした。</li>
            ))}
          {facts.length > 0 && (
            <li className="rule-fact pl-3">
              <p className="text-[17px]">横から見ると、{facts.join('、')}です。</p>
              <p className="text-sm text-ink-3">良し悪しではなく、次回と比べるための記録です。</p>
            </li>
          )}
        </ul>

        {todayRoutine && today && (
          <div className="rule-action mt-4 pl-3">
            <p className="text-sm font-medium text-ink-2">今日の 1 つ</p>
            <ul>
              <RoutineItem plan={today} />
            </ul>
          </div>
        )}
        <p className="mt-2 text-sm text-ink-2">{plan.reviewTiming.text}</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {prev ? (
            <ButtonLink to={`/compare?a=${prev.id}&b=${s.id}`} variant="primary" size="lg" block className="col-span-2" icon={<Columns2 aria-hidden className="size-5" />}>
              前回（{fmtShortDate(prev.createdAt)}）と比べる
            </ButtonLink>
          ) : (
            <ButtonLink to={todayRoutine ? `/move/${todayRoutine.id}` : '/move'} variant="primary" size="lg" block className="col-span-2" icon={<Footprints aria-hidden className="size-5" />}>
              今日のメニューを始める
            </ButtonLink>
          )}
          <ButtonLink to={`/session/${s.id}/share`} variant="secondary" block className="col-span-2" icon={<ClipboardList aria-hidden className="size-5" />}>
            専門家に見せる画面
          </ButtonLink>
        </div>
        <p className="mt-3 text-sm text-ink-2">
          医療の診断ではありません。痛みやしびれが続くときは医療機関へ。体の使い方を見てもらいたいときは、整体・理学療法などの専門家にこの画面を見せることもできます。
        </p>
      </section>

      {majorFlags.length > 0 && (
        <div className="mt-4">
          <Notice tone="warn" title="撮影条件の注意">
            {majorFlags.map((f) => f.message).join(' ')}
          </Notice>
        </div>
      )}

      {/* 2. 正面と横向きの図（並べて） */}
      <section aria-label="正面と横向きの図" className="mt-6">
        <div className={cx('grid gap-3', planes.length > 1 ? 'grid-cols-2' : 'mx-auto max-w-[300px] grid-cols-1')}>
          {planes.map((p) => (
            <PlaneFigure key={p} rec={s[p]!} sessionId={s.id} useCorrected={useCorrected} showSkeleton={showSkeleton} showGuides={showGuides} />
          ))}
        </div>
        <FigureOptions s={s} planes={planes} {...{ showSkeleton, setShowSkeleton, showGuides, setShowGuides, useCorrected, setUseCorrected }} />
        {s.front && <p className="mt-1 text-sm text-ink-3">正面の左右は、写っている人自身から見た左右です（画面の左が本人の右）。</p>}
      </section>

      {/* 3. ずれの向きと大きさ */}
      {planes.map((p) => {
        const rec = s[p]
        if (!rec || rec.landmarksRaw.length === 0) return null
        return (
          <section key={p} aria-labelledby={`gauge-${p}`} className="mt-6">
            <h2 id={`gauge-${p}`} className="mb-2 text-[17px] font-bold">
              ずれの向きと大きさ（{PLANE_NAME[p]}）
            </h2>
            <GaugeTable rows={gaugeRows(s.computedMetrics, p, prev?.computedMetrics)} heightCm={heightCm} pastLegend={prev ? `前回（${fmtShortDate(prev.createdAt)}）` : undefined} />
            {p === 'front' && <LoadShiftFeet metric={s.computedMetrics.find((m) => m.key === 'front_load_shift')} heightCm={heightCm} />}
          </section>
        )
      })}

      {/* 4. 詳しいことは閉じた項目に */}
      <div className="mt-8 border-b border-line">
        {planes.map((p) => {
          const ms = s.computedMetrics.filter((m) => m.plane === p && m.status !== 'unsupported')
          return (
            <Fold key={p} title={`くわしい値（${PLANE_NAME[p]}）`} hint={`${ms.length} 項目`}>
              <MetricList metrics={ms} rawMetrics={s.computedMetricsRaw} heightCm={heightCm} />
              {s.computedMetrics.some((m) => m.plane === p && m.status === 'unsupported') && (
                <p className="mt-2 text-sm text-ink-3">
                  {s.computedMetrics
                    .filter((m) => m.plane === p && m.status === 'unsupported')
                    .map((m) => `${m.label}は、この写真からは推定できません。`)
                    .join('')}
                </p>
              )}
            </Fold>
          )
        })}

        {s.front && s.front.landmarksRaw.length > 0 && (
          <Fold title="3D で見る">
            <Suspense fallback={<Preparing3D />}>
              <StandingPreview session={s} sex={profile?.sex} />
            </Suspense>
            <p className="mt-1.5 text-sm text-ink-3">
              正面と横向きの写真から合成した関節の向きを、全員に共通の標準の体にのせています。体型や骨の形は表していません。横に指を動かすと回ります。
            </p>
            <ButtonLink to={`/session/${s.id}/3d`} variant="secondary" block className="mt-3" icon={<Box aria-hidden className="size-5" />}>
              3D を大きく見る
            </ButtonLink>
          </Fold>
        )}

        <Fold title="意識した姿勢と比べる" hint={s.conscious ? '撮影済み' : undefined} defaultOpen={focus === 'conscious'} anchor="conscious-fold">
          {planes.length > 1 && s.conscious && (
            <Segmented
              legend="表示する写真"
              columns={2}
              value={consciousPlane}
              onChange={setConsciousPlane}
              options={planes.map((p) => ({ value: p, label: PLANE_NAME[p] }))}
            />
          )}
          <ConsciousSection s={s} plane={consciousPlane} heightCm={heightCm} profile={profile ?? undefined} logs={logs} />
        </Fold>

        <Fold title="考えられる要因（仮説）" hint={hypotheses.length ? `${hypotheses.length} 件` : undefined}>
          <p className="mb-3 text-sm text-ink-3">可能性のひとつです。当てはまらなければ気にしなくて大丈夫です。</p>
          {hypotheses.length ? (
            <ul className="space-y-3">
              {hypotheses.map((h) => (
                <li key={h.id} className="rule-hypothesis pl-3">
                  <p>{h.text}</p>
                  <p className="mt-0.5 text-sm text-ink-3">{h.basis}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2">
              {noticeable.length
                ? 'プロフィールの生活パターンからは、関係しそうな仮説は見つかりませんでした。プロフィールに生活パターンを入れると、ここに出ます。'
                : 'はっきりした差がないため、仮説は出していません。'}
            </p>
          )}
        </Fold>

        <Fold title="ほかのメニューと習慣">
          <div className="rule-action pl-3">
            <ul className="divide-y divide-line">
              {actions.map((r) => (
                <RoutineItem key={r.routineId} plan={r} />
              ))}
            </ul>
            {plan.habitSuggestions.slice(0, 2).map((h) => (
              <p key={h.id} className="mt-2 text-[15px]">
                <span className="font-medium">習慣: </span>
                {h.text}
                <span className="block text-sm text-ink-3">{h.reason}</span>
              </p>
            ))}
          </div>
          {excluded.length > 0 && (
            <p className="mt-2 text-sm text-ink-2">
              「{excluded.map((id) => routineById(id)?.name ?? id).join('」「')}」は、{DISCOMFORT_EXCLUDED_REASON}
            </p>
          )}
          <ButtonLink to="/move" variant="secondary" block className="mt-3" icon={<Footprints aria-hidden className="size-5" />}>
            メニューの一覧へ
          </ButtonLink>
        </Fold>

        <Fold title="札とメモ" hint={s.tags?.length || s.note ? 'あり' : undefined}>
          <SessionTags s={s} />
        </Fold>

        <Fold title="この記録について">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <Badge>点の写り {confidenceLabel(s.confidenceScores.overall)}</Badge>
            {corrected && <Badge tone="level">補正あり</Badge>}
            <Badge>{s.imagesSaved ? '写真あり' : '写真なし（骨格だけ）'}</Badge>
            {s.shootStyle === 'mirror' && <Badge tone="measure">鏡の前で自撮り</Badge>}
            {(s.front?.burst || s.side?.burst) && <Badge tone="measure">{(s.front?.burst ?? s.side?.burst)!.frames.length} 枚の平均</Badge>}
          </div>
          {planes.map((p) => (
            <BurstNote key={p} rec={s[p]} heightCm={heightCm} onPhoto={s.imagesSaved} />
          ))}
          <RecordNotes s={s} />
          {diffs.length > 0 && <p className="mt-2 text-sm text-ink-2">手で直した点があり、{diffs.length} 項目の値が変わっています（直す前の値は「くわしい値」の各項目にあります）。</p>}
          <div className="mt-3 grid gap-2">
            {planes.map((p) => (
              <ButtonLink key={p} to={`/session/${s.id}/edit/${p}`} variant="quiet" block icon={<PencilRuler aria-hidden className="size-5" />}>
                {PLANE_NAME[p]}の点を直す
              </ButtonLink>
            ))}
          </div>
          <Link to="/settings/status" className="mt-2 inline-flex min-h-11 items-center text-[15px] text-measure underline">
            このアプリでできること・できないこと
          </Link>
        </Fold>
      </div>

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
      >
        {fmtDate(s.createdAt, true)} の測定結果{s.imagesSaved ? 'と写真' : ''}を削除します。元に戻せません。
      </Dialog>
    </Screen>
  )
}

/** 3D の読み込み中に出す枠（空の箱のままにしない） */
export function Preparing3D() {
  return (
    <div role="status" className="grid h-[min(46dvh,360px)] place-items-center bg-sunken text-[15px] text-ink-2">
      3D を準備しています…
    </div>
  )
}

function PlaneFigure({
  rec,
  sessionId,
  useCorrected,
  showSkeleton,
  showGuides,
}: {
  rec: PlaneRecord
  sessionId: string
  useCorrected: boolean
  showSkeleton: boolean
  showGuides: boolean
}) {
  const draft = useDraft()
  const storedUrl = useStoredImageUrl(rec.imageMetadata.imageId)
  const draftUrl = draft.editingSessionId === sessionId ? draft[rec.plane]?.imageUrl : undefined
  const imageUrl = storedUrl ?? draftUrl ?? null
  const name = PLANE_NAME[rec.plane]
  if (rec.landmarksRaw.length === 0) return <p className="text-sm text-ink-3">{name}の骨格を検出できませんでした。</p>
  return (
    <figure className="min-w-0">
      {imageUrl ? (
        <PhotoWithPose record={rec} imageUrl={imageUrl} useCorrected={useCorrected} showSkeleton={showSkeleton} showGuides={showGuides} alt={`${name}の写真と骨格`} />
      ) : (
        <PostureGrid current={rec} useCorrected={useCorrected} label={`${name}の骨格を、体の高さでそろえて方眼に描いた図`} />
      )}
      <figcaption className="mt-1 text-center text-sm text-ink-2">{name}</figcaption>
    </figure>
  )
}

function FigureOptions({
  s,
  planes,
  showSkeleton,
  setShowSkeleton,
  showGuides,
  setShowGuides,
  useCorrected,
  setUseCorrected,
}: {
  s: AssessmentSession
  planes: Plane[]
  showSkeleton: boolean
  setShowSkeleton: (v: boolean) => void
  showGuides: boolean
  setShowGuides: (v: boolean) => void
  useCorrected: boolean
  setUseCorrected: (v: boolean) => void
}) {
  const hasCorrection = planes.some((p) => s[p] && correctedSet(s[p]!).size > 0)
  if (!s.imagesSaved && !hasCorrection) return null
  return (
    <div className="mt-2 flex flex-wrap gap-x-4">
      {s.imagesSaved && (
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} />
          骨格を重ねる
        </label>
      )}
      {s.imagesSaved && (
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
          基準線
        </label>
      )}
      {hasCorrection && (
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={!useCorrected} onChange={(e) => setUseCorrected(!e.target.checked)} />
          直す前を表示
        </label>
      )}
    </div>
  )
}

/** 撮影の記録についての注記（背中の輪郭・鏡の自撮り） */
function RecordNotes({ s }: { s: AssessmentSession }) {
  const side = s.side
  const backEdge = side?.outline ? backSideOf(side.outline, side.imageMetadata.facing) : null
  const mirror = s.front?.imageMetadata.mirrorSelfie || s.side?.imageMetadata.mirrorSelfie
  return (
    <>
      {backEdge && (
        <p className="mt-2 text-sm text-ink-2">
          {backEdge.points.length
            ? '横向きの背中側の線は、写真から取り出した体の輪郭です（服や髪を含む外形で、背骨の形ではありません）。点線は、背中上部の丸みと腰のすき間を測った線です。'
            : backEdge.note}
        </p>
      )}
      {mirror && (
        <p className="mt-2 text-sm text-ink-2">鏡の前で自撮りした写真は、鏡に映った左右を戻して記録しています（写真も左右を反転して表示）。スマホを持つ腕の位置は評価していません。</p>
      )}
    </>
  )
}
