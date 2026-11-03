// 保存済みセッションのランドマークを補正し直す
import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import type { AssessmentSession, PlaneRecord } from '../domain/types'
import { applyCorrection, correctionDiffs, recomputeSession, resetCorrection } from '../domain/session'
import { LandmarkEditor } from '../components/LandmarkEditor'
import { QualityList } from '../components/QualityList'
import { useStoredImageUrl } from '../components/PoseViews'
import { Button, ButtonLink, EmptyState, Screen } from '../components/ui'
import { data } from '../data/repo'
import { refreshPlan } from '../data/actions'
import { useDraft, useToast } from '../state/stores'

export function EditSaved() {
  const { id, plane } = useParams()
  const [search] = useSearchParams()
  const conscious = search.get('pose') === 'conscious'
  const navigate = useNavigate()
  const toast = useToast((s) => s.show)
  const draft = useDraft()
  const [session, setSession] = useState<AssessmentSession | null | undefined>(undefined)
  const [rec, setRec] = useState<PlaneRecord | null>(null)
  const [saving, setSaving] = useState(false)
  const p = plane === 'side' ? 'side' : 'front'

  useEffect(() => {
    if (!id) return
    data.getSession(id).then((s) => {
      setSession(s ?? null)
      setRec((conscious ? s?.conscious?.[p] : s?.[p]) ?? null)
    })
  }, [id, p, conscious])

  const storedUrl = useStoredImageUrl((conscious ? session?.conscious?.[p] : session?.[p])?.imageMetadata.imageId)
  const draftUrl = conscious
    ? draft.conscious.sessionId === id
      ? draft.conscious[p]?.imageUrl
      : undefined
    : draft.editingSessionId === id
      ? draft[p]?.imageUrl
      : undefined
  const imageUrl = storedUrl ?? draftUrl ?? null

  if (plane !== 'front' && plane !== 'side') return <Navigate to={`/session/${id}`} replace />
  if (session === undefined) return <Screen title="補正" back={`/session/${id}`}>{null}</Screen>
  if (session === null || !rec) return <Navigate to="/history" replace />

  const save = async () => {
    setSaving(true)
    let next = recomputeSession(conscious ? { ...session, conscious: { ...session.conscious!, [p]: rec } } : { ...session, [p]: rec })
    // 意識した姿勢の補正は、意識づけ / 体を動かすメニューの分け方に影響するため、おすすめも作り直す
    if (conscious) next = await refreshPlan(next)
    await data.updateSession(next)
    const changed = conscious ? 0 : correctionDiffs(next).length
    toast(conscious ? '補正を保存し、意識した姿勢の比較を計算し直しました' : changed ? `補正を保存し、${changed} 項目を計算し直しました` : '補正を保存しました')
    navigate(`/session/${id}`, { replace: true })
  }

  return (
    <Screen
      title={`${conscious ? '意識した姿勢：' : ''}${p === 'front' ? '正面' : '横向き'}の点を補正`}
      back={`/session/${id}`}
      footer={
        imageUrl ? (
          <Button variant="primary" size="lg" block onClick={save} loading={saving}>
            補正を保存して再計算
          </Button>
        ) : undefined
      }
    >
      {!imageUrl ? (
        <EmptyState title="写真が残っていないため補正できません" action={<ButtonLink to={`/session/${id}`} variant="secondary" block>結果に戻る</ButtonLink>}>
          この記録は写真を保存しない設定で測りました。補正は、写真がある間（撮影直後でアプリを閉じる前）か、写真を保存する設定にしているときにできます。
        </EmptyState>
      ) : (
        <>
          <p className="mt-1 mb-4 text-[15px] text-ink-2">点を動かして「補正を保存して再計算」を押すと、すべての指標を計算し直します。補正前の値も記録に残ります。</p>
          <QualityList flags={rec.qualityFlags} />
          <div className="mt-4">
            <LandmarkEditor
              record={rec}
              imageUrl={imageUrl}
              onMove={(i, to, o) => setRec(applyCorrection(rec, i, to, undefined, o.snap))}
              onReset={(i) => setRec(resetCorrection(rec, i))}
            />
          </div>
        </>
      )}
    </Screen>
  )
}
