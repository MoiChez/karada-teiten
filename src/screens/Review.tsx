import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { Camera } from 'lucide-react'
import type { Plane, PlaneRecord } from '../domain/types'
import { applyCorrection, correctedSet, requalify, resetCorrection } from '../domain/session'
import { hasBlocking, hasMajor } from '../domain/quality'
import { LandmarkEditor } from '../components/LandmarkEditor'
import { QualityList } from '../components/QualityList'
import { BurstNote } from '../components/BurstNote'
import { Button, Dialog, Notice, Screen, Segmented } from '../components/ui'
import { analyzeBurst, analyzePlane } from '../pose/analyzePlane'
import { blobToImageBitmapCanvas, computeImageStats, type PreparedImage } from '../pose/image'
import { useProfile, useSession } from '../data/hooks'
import { attachConscious } from '../data/actions'
import { useDraft, usePlaneDraft, useSettings, type Pose } from '../state/stores'

export function Review({ pose = 'habitual' }: { pose?: Pose }) {
  const { plane } = useParams()
  const sessionId = useDraft((s) => s.conscious.sessionId)
  if (plane !== 'front' && plane !== 'side') return <Navigate to="/measure" replace />
  if (pose === 'conscious' && !sessionId) return <Navigate to="/history" replace />
  return <ReviewInner key={`${pose}-${plane}`} plane={plane} pose={pose} sessionId={sessionId} />
}

async function blobToPrepared(blob: Blob): Promise<PreparedImage> {
  const canvas = await blobToImageBitmapCanvas(blob)
  return { canvas, blob, width: canvas.width, height: canvas.height, stats: computeImageStats(canvas) }
}

function ReviewInner({ plane, pose, sessionId }: { plane: Plane; pose: Pose; sessionId?: string }) {
  const navigate = useNavigate()
  const draft = usePlaneDraft(pose, plane)
  const consciousDraft = useDraft((s) => s.conscious)
  const updateRecord = useDraft((s) => s.updateRecord)
  const setPlane = useDraft((s) => s.setPlane)
  const saveImages = useSettings((s) => s.settings.saveImages)
  const profile = useProfile()
  const session = useSession(pose === 'conscious' ? sessionId : undefined)
  const [redetecting, setRedetecting] = useState(false)
  const [confirmRedetect, setConfirmRedetect] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const conscious = pose === 'conscious'
  const base = conscious ? '/measure/conscious' : '/measure'
  if (!draft) return <Navigate to={`${base}/capture/${plane}`} replace />
  const rec = draft.record
  const blocked = hasBlocking(rec.qualityFlags)
  const nCorrected = correctedSet(rec).size

  const set = (r: PlaneRecord) => updateRecord(plane, r, pose)

  const redetect = async () => {
    setConfirmRedetect(false)
    setRedetecting(true)
    setError(null)
    try {
      if (draft.frameBlobs && draft.frameBlobs.length > 1) {
        const images = await Promise.all(draft.frameBlobs.map(blobToPrepared))
        const r = await analyzeBurst({
          plane,
          images,
          source: rec.imageMetadata.source,
          model: 'heavy',
          deviceTilts: images.map(() => rec.imageMetadata.deviceTilt),
          facingOverride: rec.imageMetadata.facing,
        })
        const record = { ...r.record, imageMetadata: { ...r.record.imageMetadata, capturedAt: rec.imageMetadata.capturedAt } }
        const sameImage = r.repImage.blob === draft.imageBlob
        setPlane(
          plane,
          { ...draft, record, imageBlob: r.repImage.blob, imageUrl: sameImage ? draft.imageUrl : URL.createObjectURL(r.repImage.blob), notice: r.notice },
          pose,
        )
      } else {
        const image = await blobToPrepared(draft.imageBlob)
        const next = await analyzePlane({
          plane,
          image: { ...image, stats: rec.imageMetadata.imageStats ?? image.stats },
          source: rec.imageMetadata.source,
          model: 'heavy',
          deviceTilt: rec.imageMetadata.deviceTilt,
          facingOverride: rec.imageMetadata.facing,
        })
        set({ ...next, imageMetadata: { ...next.imageMetadata, capturedAt: rec.imageMetadata.capturedAt } })
      }
    } catch {
      setError('再検出できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      setRedetecting(false)
    }
  }

  const finishConscious = async () => {
    if (!sessionId) return
    setSaving(true)
    setError(null)
    try {
      await attachConscious({ sessionId, front: consciousDraft.front, side: consciousDraft.side, saveImages })
      navigate(`/session/${sessionId}`, { replace: true, state: { focus: 'conscious' } })
    } catch (e) {
      setSaving(false)
      setError(e instanceof Error ? e.message : '保存できませんでした')
    }
  }

  const correctedLabel = nCorrected > 0 ? '補正を保存して' : ''
  const sideAvailable = !conscious || !!session?.side
  const title = conscious
    ? `意識した姿勢：${plane === 'front' ? '正面' : '横向き'}の骨格`
    : plane === 'front'
      ? '正面の骨格を確認'
      : '横向きの骨格を確認'

  const footer = blocked ? (
    <Button variant="primary" size="lg" block icon={<Camera aria-hidden className="size-5" />} onClick={() => navigate(`${base}/capture/${plane}`)}>
      撮り直す
    </Button>
  ) : conscious ? (
    plane === 'front' && sideAvailable ? (
      <>
        <Button variant="primary" size="lg" block onClick={() => navigate('/measure/conscious/capture/side')}>
          {correctedLabel}次へ：横向きを撮る
        </Button>
        <Button variant="quiet" block onClick={finishConscious} loading={saving}>
          横向きは撮らずに比べる
        </Button>
      </>
    ) : (
      <Button variant="primary" size="lg" block onClick={finishConscious} loading={saving}>
        {correctedLabel}いつもの姿勢と比べる
      </Button>
    )
  ) : plane === 'front' ? (
    <>
      <Button variant="primary" size="lg" block onClick={() => navigate('/measure/capture/side')}>
        {correctedLabel}次へ：横向きを撮る
      </Button>
      <Button variant="quiet" block onClick={() => navigate('/measure/analyzing')}>
        横向きは撮らずに分析する
      </Button>
    </>
  ) : (
    <>
      <Button variant="primary" size="lg" block onClick={() => navigate('/measure/analyzing')}>
        {correctedLabel}分析する
      </Button>
      {hasMajor(rec.qualityFlags) && (
        <Button variant="quiet" block onClick={() => navigate(`${base}/capture/${plane}`)}>
          撮り直す
        </Button>
      )}
    </>
  )

  return (
    <Screen title={title} back={`${base}/capture/${plane}`} footer={footer}>
      <p className="mt-1 mb-4 text-[15px] text-ink-2">
        肩・股関節・膝などの点が体の位置からずれていたら、ドラッグして直してください。直した点から数値を計算し直します。
      </p>
      {draft.notice && (
        <div className="mb-3">
          <Notice tone="info" title="撮影について">
            {draft.notice}
          </Notice>
        </div>
      )}
      <QualityList flags={rec.qualityFlags} />
      {error && (
        <p role="alert" className="mt-3 text-[15px] font-medium text-danger">
          {error}
        </p>
      )}

      {plane === 'side' && rec.landmarksRaw.length > 0 && (
        <div className="mt-5">
          <Segmented
            legend="顔はどちらを向いていますか（写真の中で）"
            columns={2}
            value={rec.imageMetadata.facing}
            onChange={(facing) => set(requalify({ ...rec, imageMetadata: { ...rec.imageMetadata, facing } }))}
            options={[
              { value: 'left', label: '左を向いている' },
              { value: 'right', label: '右を向いている' },
            ]}
          />
        </div>
      )}

      {rec.landmarksRaw.length > 0 ? (
        <div className="mt-4">
          <LandmarkEditor
            record={rec}
            imageUrl={draft.imageUrl}
            onMove={(i, to, o) => set(applyCorrection(rec, i, to, undefined, o.snap))}
            onReset={(i) => set(resetCorrection(rec, i))}
            onRedetect={() => (nCorrected > 0 ? setConfirmRedetect(true) : redetect())}
            redetecting={redetecting}
          />
          <BurstNote rec={rec} heightCm={profile?.heightCm} onPhoto />
        </div>
      ) : (
        <img src={draft.imageUrl} alt="撮影した写真" className="mt-4 w-full rounded-[var(--radius-panel)]" />
      )}

      <Dialog
        open={confirmRedetect}
        onClose={() => setConfirmRedetect(false)}
        title="再検出しますか"
        actions={
          <>
            <Button variant="primary" block onClick={redetect}>
              補正を破棄して再検出する
            </Button>
            <Button variant="quiet" block onClick={() => setConfirmRedetect(false)}>
              やめる
            </Button>
          </>
        }
      >
        高精度モデルで骨格を推定し直します。今までの補正（{nCorrected} 点）は破棄されます。
      </Dialog>
    </Screen>
  )
}
