import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { Check, Loader2 } from 'lucide-react'
import { buildSession } from '../domain/session'
import { buildPlan } from '../domain/recommend/engine'
import { hasBlocking } from '../domain/quality'
import { data } from '../data/repo'
import { POSE_MODEL, modelVersion } from '../pose/landmarker'
import { useDraft, useSettings } from '../state/stores'
import { Button, Screen, cx } from '../components/ui'

const STEPS = ['骨格の推定', '撮影品質の確認', '姿勢の指標を計算', 'おすすめを作成', '記録を保存']

export function Analyzing() {
  const navigate = useNavigate()
  const draft = useDraft()
  const settings = useSettings((s) => s.settings)
  const [done, setDone] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const front = draft.front && !hasBlocking(draft.front.record.qualityFlags) ? draft.front : undefined
  const side = draft.side && !hasBlocking(draft.side.record.qualityFlags) ? draft.side : undefined

  useEffect(() => {
    if (started.current || (!front && !side)) return
    started.current = true
    ;(async () => {
      try {
        setDone(2)
        const session = buildSession({
          front: front?.record,
          side: side?.record,
          checkinId: draft.checkin?.id,
          imagesSaved: false,
          modelVersion: modelVersion(POSE_MODEL),
        })
        session.captureMode = draft.mode
        setDone(3)
        const [profile, logs] = await Promise.all([data.getProfile(), data.listLogs()])
        const plan = buildPlan({
          traits: session.postureTraits,
          profile,
          recentLogs: logs.slice(-30),
          fatigue: draft.checkin?.fatigueRating,
          basedOnAssessmentId: session.id,
          lastAssessmentAt: session.createdAt,
        })
        session.recommendationSnapshot = { planId: plan.id, routineIds: plan.routines.map((r) => r.routineId) }
        setDone(4)
        if (draft.checkin && (draft.checkin.fatigueRating || draft.checkin.sleepRating || draft.checkin.discomfortAreas.length)) {
          await data.addCheckin(draft.checkin)
        }
        await data.savePlan(plan)
        await data.saveSession(
          session,
          settings.saveImages ? { front: front?.imageBlob, side: side?.imageBlob } : undefined,
        )
        setDone(5)
        // 画像を保存しない設定でも、アプリを開いている間は補正し直せるよう下書きを残す
        draft.setEditing(session.id)
        if (draft.mode === 'precise') {
          // 高精度モードは、続けて意識した姿勢も撮る（撮影画面の「あとで」で結果へ進める）
          draft.startConscious(session.id)
          navigate('/measure/conscious/capture/front', { replace: true })
        } else navigate(`/session/${session.id}`, { replace: true })
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存できませんでした')
      }
    })()
  }, [front, side, draft, settings, navigate])

  if (!front && !side) return <Navigate to="/measure" replace />

  return (
    <Screen title="分析しています">
      <ol className="mt-6 space-y-4" aria-live="polite">
        {STEPS.map((s, i) => {
          const state = i < done ? 'done' : i === done ? 'doing' : 'todo'
          return (
            <li key={s} className="flex items-center gap-3">
              <span className={cx('flex size-8 items-center justify-center rounded-full', state === 'done' ? 'bg-level' : 'bg-sunken')}>
                {state === 'done' ? (
                  <Check aria-hidden className="size-4" />
                ) : state === 'doing' && !error ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <span className="text-sm text-ink-3 num">{i + 1}</span>
                )}
              </span>
              <span className={cx(state === 'todo' && 'text-ink-3')}>{s}</span>
              <span className="sr-only">{state === 'done' ? '完了' : state === 'doing' ? '処理中' : '待機中'}</span>
            </li>
          )
        })}
      </ol>
      {error && (
        <div className="mt-8" role="alert">
          <p className="font-bold text-danger">「{STEPS[done]}」で問題が起きました</p>
          <p className="mt-1 text-ink-2">{error}</p>
          <Button className="mt-4" variant="primary" onClick={() => window.location.reload()}>
            もう一度試す
          </Button>
        </div>
      )}
    </Screen>
  )
}
