import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { Camera } from 'lucide-react'
import type { Plane, PlaneRecord } from '../domain/types'
import { applyCorrection, correctedSet, requalify, resetCorrection } from '../domain/session'
import { hasBlocking, hasMajor } from '../domain/quality'
import { LandmarkEditor } from '../components/LandmarkEditor'
import { QualityList } from '../components/QualityList'
import { Button, Dialog, Screen, Segmented } from '../components/ui'
import { analyzePlane } from '../pose/analyzePlane'
import { blobToImageBitmapCanvas, computeImageStats } from '../pose/image'
import { useDraft } from '../state/stores'

export function Review() {
  const { plane } = useParams()
  if (plane !== 'front' && plane !== 'side') return <Navigate to="/measure" replace />
  return <ReviewInner key={plane} plane={plane} />
}

function ReviewInner({ plane }: { plane: Plane }) {
  const navigate = useNavigate()
  const draft = useDraft((s) => s[plane])
  const updateRecord = useDraft((s) => s.updateRecord)
  const [redetecting, setRedetecting] = useState(false)
  const [confirmRedetect, setConfirmRedetect] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!draft) return <Navigate to={`/measure/capture/${plane}`} replace />
  const rec = draft.record
  const blocked = hasBlocking(rec.qualityFlags)
  const nCorrected = correctedSet(rec).size

  const set = (r: PlaneRecord) => updateRecord(plane, r)

  const redetect = async () => {
    setConfirmRedetect(false)
    setRedetecting(true)
    setError(null)
    try {
      const canvas = await blobToImageBitmapCanvas(draft.imageBlob)
      const next = await analyzePlane({
        plane,
        image: { canvas, blob: draft.imageBlob, width: canvas.width, height: canvas.height, stats: rec.imageMetadata.imageStats ?? computeImageStats(canvas) },
        source: rec.imageMetadata.source,
        model: 'heavy',
        deviceTilt: rec.imageMetadata.deviceTilt,
        facingOverride: rec.imageMetadata.facing,
      })
      set({ ...next, imageMetadata: { ...next.imageMetadata, capturedAt: rec.imageMetadata.capturedAt } })
    } catch {
      setError('再検出できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      setRedetecting(false)
    }
  }

  const goNext = () => navigate(plane === 'front' ? '/measure/capture/side' : '/measure/analyzing')
  const correctedLabel = nCorrected > 0 ? '補正を保存して' : ''

  return (
    <Screen
      title={plane === 'front' ? '正面の骨格を確認' : '横向きの骨格を確認'}
      back={`/measure/capture/${plane}`}
      footer={
        blocked ? (
          <Button variant="primary" size="lg" block icon={<Camera aria-hidden className="size-5" />} onClick={() => navigate(`/measure/capture/${plane}`)}>
            撮り直す
          </Button>
        ) : plane === 'front' ? (
          <>
            <Button variant="primary" size="lg" block onClick={goNext}>
              {correctedLabel}次へ：横向きを撮る
            </Button>
            <Button variant="quiet" block onClick={() => navigate('/measure/analyzing')}>
              横向きは撮らずに分析する
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" block onClick={goNext}>
              {correctedLabel}分析する
            </Button>
            {hasMajor(rec.qualityFlags) && (
              <Button variant="quiet" block onClick={() => navigate(`/measure/capture/${plane}`)}>
                撮り直す
              </Button>
            )}
          </>
        )
      }
    >
      <p className="mt-1 mb-4 text-[15px] text-ink-2">
        肩・股関節・膝などの点が体の位置からずれていたら、ドラッグして直してください。直した点から数値を計算し直します。
      </p>
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
