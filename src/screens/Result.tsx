import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { Box, Columns2, Footprints, PencilRuler, Trash2 } from 'lucide-react'
import type { AssessmentSession, Plane, PostureTrait } from '../domain/types'
import { AREA_LABELS, confidenceLabel, fmtDate, fmtShortDate } from '../domain/format'
import { gaugeRows } from '../domain/gauge'
import { deriveHypotheses } from '../domain/hypotheses'
import { buildPlan } from '../domain/recommend/engine'
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
import { Badge, Button, ButtonLink, Dialog, IconButton, Notice, Screen, SectionTitle, Segmented, cx } from '../components/ui'
import { useDraft, useToast } from '../state/stores'

export function Result() {
  const { id } = useParams()
  const session = useSession(id)
  if (session === undefined) return <Screen title="分析結果" back="/history">{null}</Screen>
  if (!session) return <Navigate to="/history" replace />
  return <ResultBody s={session} />
}

function ResultBody({ s }: { s: AssessmentSession }) {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast((t) => t.show)
  const profile = useProfile()
  const logs = useLogs()
  const checkins = useCheckins()
  const sessions = useSessions()
  const draft = useDraft()
  const storedPlan = useLiveQuery(() => (s.recommendationSnapshot ? db.plans.get(s.recommendationSnapshot.planId) : undefined), [s.recommendationSnapshot?.planId])
  const planes: Plane[] = [s.front && 'front', s.side && 'side'].filter(Boolean) as Plane[]
  const [plane, setPlane] = useState<Plane>(planes[0] ?? 'front')
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showGuides, setShowGuides] = useState(true)
  const [useCorrected, setUseCorrected] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const rec = s[plane]
  const backEdge = rec?.plane === 'side' && rec.outline ? backSideOf(rec.outline, rec.imageMetadata.facing) : null
  const storedUrl = useStoredImageUrl(rec?.imageMetadata.imageId)
  const draftUrl = draft.editingSessionId === s.id ? draft[plane]?.imageUrl : undefined
  const imageUrl = storedUrl ?? draftUrl ?? null
  const canEdit = !!imageUrl && !!rec?.landmarksRaw.length

  const noticeable = useMemo(() => s.postureTraits.filter((t) => t.status === 'noticeable').sort((a, b) => b.magnitude - a.magnitude), [s])
  const hypotheses = useMemo(() => deriveHypotheses(s.postureTraits, profile ?? undefined), [s, profile])
  const checkin = checkins?.find((c) => c.id === s.checkinId)
  const plan = useMemo(
    () =>
      storedPlan ??
      buildPlan({ traits: s.postureTraits, profile: profile ?? undefined, recentLogs: logs?.slice(-30), fatigue: checkin?.fatigueRating, basedOnAssessmentId: s.id, lastAssessmentAt: s.createdAt }),
    [storedPlan, s, profile, logs, checkin],
  )
  const priority = plan.routines.filter((r) => r.slot === 'priority')
  const actions = (priority.length ? priority : plan.routines.filter((r) => r.slot === 'set5')).slice(0, 3)
  const ordered = (sessions ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const prev = ordered.filter((x) => x.createdAt < s.createdAt).at(-1)
  const diffs = correctionDiffs(s)
  const planeTraits = s.postureTraits.filter((t) => t.plane === plane)
  const planeMetrics = s.computedMetrics.filter((m) => m.plane === plane)
  const majorFlags = s.qualityFlags.filter((f) => f.severity !== 'minor')
  const heightCm = profile?.heightCm
  const rows = useMemo(() => gaugeRows(s.computedMetrics, plane, prev?.computedMetrics), [s, plane, prev])

  // 意識した姿勢を撮って戻ってきたときは、その比較まで移動する
  const focus = (location.state as { focus?: string } | null)?.focus
  useEffect(() => {
    if (focus !== 'conscious') return
    const t = setTimeout(() => document.getElementById('conscious')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
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
      <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
        <span className="num">{fmtDate(s.createdAt, true)}</span>
        <Badge>信頼度 {confidenceLabel(s.confidenceScores.overall)}</Badge>
        {(s.front && correctedSet(s.front).size > 0) || (s.side && correctedSet(s.side).size > 0) ? <Badge tone="level">補正あり</Badge> : null}
        <Badge>{s.imagesSaved ? '写真を保存' : '写真は未保存'}</Badge>
        {s.shootStyle === 'mirror' && <Badge tone="measure">鏡の前で自撮り</Badge>}
        {(s.front?.burst || s.side?.burst) && <Badge tone="measure">{(s.front?.burst ?? s.side?.burst)!.frames.length} 枚の平均</Badge>}
        {s.conscious && <Badge tone="measure">意識した姿勢あり</Badge>}
      </div>

      {/* 1. サマリー */}
      <section aria-labelledby="sum" className="mt-4 rounded-[var(--radius-panel)] bg-surface p-4 shadow-lift">
        <h2 id="sum" className="text-sm font-medium text-ink-3">
          今回の写真から言えること
        </h2>
        {noticeable.length ? (
          <ul className="mt-2 space-y-2">
            {noticeable.slice(0, 3).map((t) => (
              <li key={t.key} className="rule-fact pl-3">
                <p className="font-bold">{t.label}</p>
                <p className="text-[15px] text-ink-2">{t.summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[17px]">測定のばらつきを超える目立った差は、今回の写真からは見られませんでした。</p>
        )}
        <p className="mt-3 text-sm text-ink-3">
          医療的な診断ではありません。数値は写真から推定した目印の位置関係で、あなた自身の変化を見るためのものです。
        </p>
      </section>

      {majorFlags.length > 0 && (
        <div className="mt-3">
          <Notice tone="warn" title="撮影条件の注意">
            {majorFlags.map((f) => f.message).join(' ')}
          </Notice>
        </div>
      )}

      {/* 2. 正面 / 側面 */}
      {planes.length > 1 && (
        <div className="mt-6">
          <Segmented
            legend="表示する写真"
            columns={2}
            value={plane}
            onChange={setPlane}
            options={[
              { value: 'front', label: '正面' },
              { value: 'side', label: '横向き' },
            ]}
          />
        </div>
      )}

      {/* 3. 写真 + 骨格 */}
      {rec && rec.landmarksRaw.length > 0 && (
        <div className={cx('grid gap-3', planes.length > 1 ? 'mt-0' : 'mt-6', imageUrl ? 'grid-cols-2' : 'mx-auto max-w-[300px] grid-cols-1')}>
          {imageUrl && (
            <PhotoWithPose record={rec} imageUrl={imageUrl} useCorrected={useCorrected} showSkeleton={showSkeleton} showGuides={showGuides} alt={`${plane === 'front' ? '正面' : '横向き'}の写真と骨格`} />
          )}
          <PostureGrid current={rec} useCorrected={useCorrected} label={`${plane === 'front' ? '正面' : '横向き'}の骨格を、体の高さでそろえて方眼に描いた図`} />
        </div>
      )}
      {rec && (
        <div className="mt-2 flex flex-wrap gap-x-4">
          {imageUrl && (
            <label className="flex min-h-11 items-center gap-2 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} />
              骨格を重ねる
            </label>
          )}
          {imageUrl && (
            <label className="flex min-h-11 items-center gap-2 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
              基準線
            </label>
          )}
          {correctedSet(rec).size > 0 && (
            <label className="flex min-h-11 items-center gap-2 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={!useCorrected} onChange={(e) => setUseCorrected(!e.target.checked)} />
              補正前を表示
            </label>
          )}
        </div>
      )}
      {!imageUrl && rec && <p className="text-sm text-ink-3">写真は保存されていないため、骨格だけを表示しています。</p>}
      <BurstNote rec={rec} heightCm={heightCm} onPhoto={!!imageUrl} />
      {backEdge && (
        <p className="mt-1 text-sm text-ink-3">
          {backEdge.points.length
            ? '背中側の線は、写真から取り出した体の輪郭です（服や髪を含む外形で、背骨の形ではありません）。点線は、背中上部の丸みと腰のすき間を測った線です。'
            : backEdge.note}
        </p>
      )}
      {plane === 'front' && <p className="mt-1 text-sm text-ink-3">左右は、写っている人自身から見た左右です。</p>}
      {rec?.imageMetadata.mirrorSelfie && (
        <p className="mt-1 text-sm text-ink-3">鏡の前で自撮りした写真は、鏡に映った左右を戻して記録しています（写真も左右を反転して表示）。スマホを持つ腕の位置は評価していません。</p>
      )}

      {/* 3b. ずれの向きと大きさ */}
      {rec && rec.landmarksRaw.length > 0 && (
        <>
          <SectionTitle sub="向きと大きさをひと目で。中央の帯は測定のばらつきの範囲です">ずれの向きと大きさ（{plane === 'front' ? '正面' : '横向き'}）</SectionTitle>
          <GaugeTable rows={rows} heightCm={heightCm} pastLegend={prev ? `前回（${fmtShortDate(prev.createdAt)}）` : undefined} />
          {plane === 'front' && <LoadShiftFeet metric={planeMetrics.find((m) => m.key === 'front_load_shift')} heightCm={heightCm} />}
        </>
      )}

      {/* 4. 主な姿勢特徴 */}
      <SectionTitle sub="写真から観測された事実">主な姿勢特徴（{plane === 'front' ? '正面' : '横向き'}）</SectionTitle>
      <ul className="space-y-3">
        {planeTraits.map((t) => (
          <TraitRow key={t.key} t={t} />
        ))}
        {planeTraits.length === 0 && <li className="text-ink-2">この面は測定していません。</li>}
      </ul>

      {/* 5. 気になる点 */}
      {noticeable.length > 0 && (
        <>
          <SectionTitle sub="差が見られた特徴と、関連が考えられる部位（参考）">気になる点</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {noticeable.map((t) => (
              <li key={t.key} className="flex items-center justify-between gap-3 py-2.5">
                <span>{t.label}</span>
                <span className="text-right text-sm text-ink-3">{t.relatedAreas.map((a) => AREA_LABELS[a]).join('・')}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 6. 項目別の指標 */}
      <SectionTitle sub="値・ばらつきの目安・信頼度。開くと計算方法と限界が見られます">項目別の指標</SectionTitle>
      <MetricList metrics={planeMetrics} rawMetrics={s.computedMetricsRaw} heightCm={heightCm} />
      {diffs.length > 0 && <p className="mt-2 text-sm text-ink-3">手動補正により {diffs.length} 項目の値が変わっています（補正前の値は各項目に表示）。</p>}

      {/* 6b. いつもの姿勢と意識した姿勢 */}
      <ConsciousSection s={s} plane={plane} heightCm={heightCm} profile={profile ?? undefined} logs={logs} />

      {/* 7. 生活習慣との関連仮説 */}
      <SectionTitle sub="可能性のひとつです。当てはまらなければ気にしなくて大丈夫です">考えられる要因（仮説）</SectionTitle>
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
            ? 'プロフィールの生活パターンからは、関連しそうな仮説は見つかりませんでした。プロフィールで生活パターンを入力すると、ここに表示されます。'
            : '目立った差がないため、仮説は出していません。'}
        </p>
      )}

      {/* 8. 推奨アクション */}
      <SectionTitle sub="今日から試せること">試してみるとよい行動</SectionTitle>
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
        <p className="mt-3 text-sm text-ink-2">{plan.reviewTiming.text}</p>
      </div>

      {/* 9-11. 導線 */}
      <div className="mt-8 grid grid-cols-2 gap-2">
        <ButtonLink to="/move" variant="primary" size="lg" block className="col-span-2" icon={<Footprints aria-hidden className="size-5" />}>
          おすすめメニューを見る
        </ButtonLink>
        {prev ? (
          <ButtonLink to={`/compare?a=${prev.id}&b=${s.id}`} variant="secondary" block icon={<Columns2 aria-hidden className="size-5" />}>
            前回と比べる
          </ButtonLink>
        ) : (
          <Button variant="secondary" block disabled icon={<Columns2 aria-hidden className="size-5" />} title="2 回目の測定から比べられます">
            比較は 2 回目から
          </Button>
        )}
        <ButtonLink to={`/session/${s.id}/3d`} variant="secondary" block icon={<Box aria-hidden className="size-5" />}>
          3D で見る
        </ButtonLink>
        {rec && (
          <ButtonLink to={`/session/${s.id}/edit/${plane}`} variant="quiet" block className="col-span-2" icon={<PencilRuler aria-hidden className="size-5" />}>
            {canEdit ? `${plane === 'front' ? '正面' : '横向き'}の点を補正し直す` : '点の補正について'}
          </ButtonLink>
        )}
      </div>
      {!prev && <p className="mt-2 text-center text-sm text-ink-3">2 回目の測定をすると、変化を比べられます。</p>}

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
        {fmtDate(s.createdAt, true)} の測定結果{ s.imagesSaved ? 'と写真' : ''}を削除します。元に戻せません。
      </Dialog>
      <Link to="/settings/status" className="mt-8 block text-center text-sm text-measure underline">
        このアプリでできること・できないこと
      </Link>
    </Screen>
  )
}

function TraitRow({ t }: { t: PostureTrait }) {
  const tone = t.status === 'noticeable' ? 'attention' : t.status === 'within_noise' ? 'neutral' : 'neutral'
  const label = t.status === 'noticeable' ? '差が見られる' : t.status === 'within_noise' ? 'ばらつきの範囲内' : t.status === 'unassessable' ? '評価不可' : '未測定'
  return (
    <li className="rounded-[var(--radius-control)] bg-surface px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="font-bold">{t.label}</p>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <p className="mt-1 text-[15px] text-ink-2">{t.summary}</p>
      {t.status !== 'not_measured' && <p className="mt-1 text-sm text-ink-3">{t.caution}</p>}
    </li>
  )
}
