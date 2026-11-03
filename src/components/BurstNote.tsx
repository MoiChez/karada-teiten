// 複数枚撮りの説明（何枚の平均か、1 枚ごとの点のぶれ、判定に使ったばらつき）
import type { PlaneRecord } from '../domain/types'
import { LANDMARK_SIGMA_FRACTION } from '../domain/constants'
import { fmtNum, fracToCm } from '../domain/format'

const pct = (f: number) => (f * 100).toFixed(2)

export function BurstNote({ rec, heightCm, onPhoto }: { rec: PlaneRecord | undefined; heightCm?: number; onPhoto?: boolean }) {
  const b = rec?.burst
  if (!b || b.frames.length < 2) return null
  const k = b.frames.length
  const cm = b.spreadFrac !== null ? fracToCm(b.spreadFrac, heightCm) : null
  const bigger = b.spreadFrac !== null && b.spreadFrac > LANDMARK_SIGMA_FRACTION
  return (
    <div className="mt-3 rounded-[var(--radius-control)] bg-measure-soft px-3.5 py-3 text-[15px]">
      <p className="font-medium">
        {k} 枚の平均{b.attempted > k ? `（${b.attempted} 枚中 ${k} 枚を使用）` : ''}
      </p>
      {onPhoto && <p className="mt-0.5 text-ink-2">平均した点を、{b.repIndex + 1} 枚目の写真に重ねています。写真と点が少しずれて見えるのは平均によるものです。</p>}
      {b.spreadFrac !== null ? (
        <p className="mt-0.5 text-ink-2 num">
          1 枚ごとの点のぶれ: 体の高さの {pct(b.spreadFrac)}%{cm !== null ? `（約 ${fmtNum(cm)}cm）` : ''}。立ち直しによる姿勢の違いと推定のぶれを合わせた値です。
        </p>
      ) : (
        <p className="mt-0.5 text-ink-2">点の数が足りず、1 枚ごとのぶれは求められませんでした。</p>
      )}
      <p className="mt-0.5 text-sm text-ink-3 num">
        {bigger
          ? `前提（${pct(LANDMARK_SIGMA_FRACTION)}%）より大きいため、このぶれをもとに判定しています。`
          : `前提（${pct(LANDMARK_SIGMA_FRACTION)}%）以下のため、前提の値をもとに判定しています。`}
        {k} 枚の平均なので、ばらつきは 1 枚のときの 1/√{k} です。
      </p>
    </div>
  )
}
