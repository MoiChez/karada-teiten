// 写真・動画を残した記録を、新しい点の推定で計算し直す（設定の画面）
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { redetectAll, redetectTargets } from '../data/redetect'
import { useSettings, useToast } from '../state/stores'
import { Button, Segmented } from './ui'

export function RedetectPanel() {
  const toast = useToast((t) => t.show)
  const quality = useSettings((s) => s.settings.poseQuality)
  const update = useSettings((s) => s.update)
  const [counts, setCounts] = useState<{ sessions: number; motions: number } | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; frame?: { done: number; total: number } } | null>(null)

  useEffect(() => {
    let alive = true
    void redetectTargets().then((t) => alive && setCounts({ sessions: t.sessions.length, motions: t.motions.length }))
    return () => {
      alive = false
    }
  }, [running, quality])

  if (!counts) return null
  const total = counts.sessions + counts.motions
  const run = async () => {
    setRunning(true)
    try {
      const r = await redetectAll(setProgress)
      toast(`${r.sessions + r.motions} 件を計算し直しました`)
    } catch {
      toast('計算し直せませんでした。電波のよいところで、もう一度お試しください')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }
  return (
    <div id="redetect" className="border-y border-line py-3">
      <p className="font-medium">点の推定を新しくしました</p>
      <p className="mt-1 text-[15px] text-ink-2">
        体の点を、これまでの推定（MediaPipe）に加えて RTMPose で細かく読み取るようにしました。脚の取り違えや、器具で隠れた所の外れが少なくなります。
      </p>
      <div className="mt-3">
        <Segmented
          legend="読み取りの精度"
          columns={2}
          value={quality}
          onChange={(q) => void update('poseQuality', q)}
          options={[
            { value: 'standard', label: '標準', hint: 'RTMPose-m・約 56MB' },
            { value: 'high', label: '高精度', hint: 'RTMPose-l・約 112MB' },
          ]}
        />
      </div>
      <p className="-mt-2 text-sm text-ink-2">
        {quality === 'high'
          ? '高精度は、ハイエンドのスマホか、最新のスマホでの利用をおすすめします。読み込むものが大きく、動画の分析にも標準の 2 倍ほど時間がかかります。'
          : '高精度（RTMPose-l）は、ハイエンドのスマホか、最新のスマホ向けです。'}
      </p>
      {total === 0 ? (
        <p className="mt-2 text-sm text-ink-2">計算し直せる記録はありません（写真・動画を残していない記録は、点しか残っていないため計算し直せません）。</p>
      ) : (
        <>
          <p className="mt-2 text-[15px]">
            写真・動画を残した記録 {total} 件（姿勢 {counts.sessions}・動き {counts.motions}）を、選んだ精度で計算し直せます。手で直した点は、そのまま当て直します。
          </p>
          <p className="mt-1 text-sm text-ink-2">
            初めてのときは、推定の部品（{quality === 'high' ? '約 127MB' : '約 70MB'}）をこのサイトから読み込みます。動画は 1 本に数分かかることがあります。写真・動画は外へ送りません。
          </p>
          {progress && (
            <p className="mt-2 text-sm text-ink-2 num" role="status">
              {progress.done} / {progress.total} 件{progress.frame ? `（動画のコマ ${progress.frame.done} / ${progress.frame.total}）` : ''}
            </p>
          )}
          <Button block className="mt-3" icon={<RefreshCw aria-hidden className="size-5" />} onClick={run} loading={running}>
            計算し直す
          </Button>
        </>
      )}
    </div>
  )
}
