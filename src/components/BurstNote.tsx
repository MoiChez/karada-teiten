// 複数枚撮りの説明（何枚の平均か、写真ごとの点の揺れ、判定の幅をどうしたか）
import type { PlaneRecord } from '../domain/types'
import { LANDMARK_SIGMA_FRACTION } from '../domain/constants'
import { fmtNum, fracToCm } from '../domain/format'

const pct = (f: number) => (f * 100).toFixed(2)

export function BurstNote({ rec, heightCm, onPhoto }: { rec: PlaneRecord | undefined; heightCm?: number; onPhoto?: boolean }) {
  const b = rec?.burst
  if (!b || b.frames.length < 2) return null
  const k = b.frames.length
  const cm = b.spreadFrac !== null ? fracToCm(b.spreadFrac, heightCm) : null
  const averaged = b.spreadFrac !== null ? b.spreadFrac / Math.sqrt(k) : null
  const widened = averaged !== null && averaged > LANDMARK_SIGMA_FRACTION
  return (
    <div className="mt-3 rounded-[var(--radius-control)] bg-measure-soft px-3.5 py-3 text-[15px]">
      <p className="font-medium">
        {k} 枚の平均{b.attempted > k ? `（${b.attempted} 枚中 ${k} 枚を使用）` : ''}
      </p>
      {onPhoto && <p className="mt-0.5 text-ink-2">平均した点を、{b.repIndex + 1} 枚目の写真に重ねています。</p>}
      {b.spreadFrac !== null ? (
        <p className="mt-0.5 text-ink-2 num">
          写真ごとの点の揺れ: 体の高さの {pct(b.spreadFrac)}%{cm !== null ? `（約 ${fmtNum(cm)}cm）` : ''}。続けて撮った写真の間での推定の揺れです（体の小さな揺れを含みます）。
        </p>
      ) : (
        <p className="mt-0.5 text-ink-2">点の数が足りず、写真ごとの揺れは求められませんでした。</p>
      )}
      <p className="mt-0.5 text-sm text-ink-3 num">
        {widened
          ? `揺れが大きかったため、判定の幅を広げています（平均した後の揺れ ${pct(averaged!)}%）。`
          : `平均したので、値の揺れは小さくなっています。判定の幅は前提（${pct(LANDMARK_SIGMA_FRACTION)}%）のままです。服や体格による推定のずれは、続けて撮っても減らないためです。`}
      </p>
    </div>
  )
}
