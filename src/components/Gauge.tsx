// 向きつきゲージ（7 マス）と、左右荷重の傾向の足の図
import { Link } from 'react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ComputedMetric } from '../domain/types'
import { gaugeDescription, type GaugeAxis, type GaugeRow } from '../domain/gauge'
import { fmtAbs, fmtNum, offsetCm, primaryValue } from '../domain/format'
import { cx } from './ui'

const CELLS = [-3, -2, -1, 0, 1, 2, 3]
/** ゲージ部分の幅（px）: 7 マス × 20 + 隙間 6 × 4 */
const GAUGE_W = 164
const BAND_W = 28

interface Block {
  axis: GaugeAxis
  judged: boolean
  rows: GaugeRow[]
}

function toBlocks(rows: GaugeRow[]): Block[] {
  const out: Block[] = []
  for (const r of rows) {
    const last = out.at(-1)
    if (last && last.axis.id === r.axis.id && last.judged === r.judged) last.rows.push(r)
    else out.push({ axis: r.axis, judged: r.judged, rows: [r] })
  }
  return out
}

export function GaugeTable({ rows, heightCm, pastLabel }: { rows: GaugeRow[]; heightCm?: number; pastLabel?: string }) {
  if (!rows.length) return <p className="text-ink-2">表示できる項目がありません。</p>
  const blocks = toBlocks(rows)
  const hasPast = !!pastLabel && rows.some((r) => r.pastCell !== null)
  const hasOffset = rows.some((r) => r.metric.offset)
  return (
    <div>
      <div className="rounded-[var(--radius-panel)] bg-surface px-3 py-2 shadow-lift">
        {blocks.map((b, i) => (
          <div key={i} className={cx(i > 0 && 'mt-3 border-t border-line pt-2')}>
            {!b.judged && (blocks[i - 1]?.judged ?? true) && (
              <p className="pb-1 text-sm font-medium text-ink-3">位置の記録（良し悪しは判定しません）</p>
            )}
            <BlockView block={b} heightCm={heightCm} />
          </div>
        ))}
      </div>
      <div className="mt-2 space-y-1 text-sm text-ink-3">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-5 rounded-full bg-measure" />
            今回
          </span>
          {hasPast && (
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-5 rounded-full bg-line outline-2 outline-offset-2 outline-past outline-dashed" />
              前回（{pastLabel}）
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-4 w-5 rounded-sm bg-measure-soft" />
            ばらつきの範囲
          </span>
        </p>
        <p>
          中央の帯は測定のばらつきの範囲で、差があるとは言えない幅です。外側のマスほど、ばらつきに比べてはっきりした差です（1 マス = ばらつき 2 つ分）。医学的な基準値ではありません。
        </p>
        {hasOffset &&
          (heightCm ? (
            <p>cm はプロフィールの身長（{fmtNum(heightCm, Number.isInteger(heightCm) ? 0 : 1)}cm）から換算した目安です。</p>
          ) : (
            <p>
              <Link to="/profile" className="text-measure underline">
                プロフィールに身長
              </Link>
              を入れると、位置のずれを cm の目安でも表示します。
            </p>
          ))}
      </div>
    </div>
  )
}

function BlockView({ block, heightCm }: { block: Block; heightCm?: number }) {
  return (
    <div className="relative">
      {/* 中央の帯（ばらつきの範囲） */}
      <div
        aria-hidden
        className="absolute top-0 bottom-0 rounded-md bg-measure-soft"
        style={{ right: GAUGE_W / 2 - BAND_W / 2, width: BAND_W }}
      />
      <div className="relative grid items-end gap-x-3 pb-1 text-xs text-ink-3" style={{ gridTemplateColumns: `1fr ${GAUGE_W}px` }}>
        <span />
        <span className="flex items-end justify-between">
          <span className="w-12">{block.axis.left}</span>
          <span className="text-center leading-tight text-measure">{block.axis.center}</span>
          <span className="w-12 text-right">{block.axis.right}</span>
        </span>
      </div>
      <ul className="relative">
        {block.rows.map((r) => (
          <GaugeRowView key={r.key} r={r} heightCm={heightCm} />
        ))}
      </ul>
    </div>
  )
}

function GaugeRowView({ r, heightCm }: { r: GaugeRow; heightCm?: number }) {
  const value = primaryValue(r.metric, heightCm)
  return (
    <li className="grid items-center gap-x-3 py-1.5" style={{ gridTemplateColumns: `1fr ${GAUGE_W}px` }}>
      <span className="text-[15px] leading-snug">{r.label}</span>
      <span role="img" aria-label={gaugeDescription(r, value)} className="block">
        <ValueTag r={r} value={value} />
        <span className="mt-0.5 flex justify-between">
          {CELLS.map((i) => (
            <span
              key={i}
              className={cx(
                'h-2.5 w-5 rounded-full',
                r.cell === i ? (r.judged ? 'bg-measure' : 'bg-ink-2') : 'bg-line',
                r.pastCell === i && 'outline-2 outline-offset-2 outline-past outline-dashed',
              )}
            />
          ))}
        </span>
      </span>
    </li>
  )
}

function ValueTag({ r, value }: { r: GaugeRow; value: string }) {
  if (r.cell === null) return <span className="block h-5 text-center text-xs leading-5 text-ink-3">評価不可</span>
  if (r.cell === 0) return <span className="block h-5 text-center text-xs leading-5 text-ink-3 num">{value}</span>
  const left = r.cell < 0
  return (
    <span className={cx('flex h-5 items-center gap-0.5 text-sm font-medium num', left ? 'justify-start' : 'justify-end')}>
      {left && <ArrowLeft aria-hidden className="size-3.5" />}
      <span>{value}</span>
      {r.tag !== (left ? r.axis.left : r.axis.right) && <span className="text-xs font-normal text-ink-2">{r.tag}</span>}
      {!left && <ArrowRight aria-hidden className="size-3.5" />}
    </span>
  )
}

// ---------- 左右荷重の傾向（足の図） ----------

/** 体の中心が両足の中央からどちらへ寄っているかを、足の図に点で示す（参考推定） */
export function LoadShiftFeet({ metric, heightCm }: { metric: ComputedMetric | undefined; heightCm?: number }) {
  if (!metric || metric.rawValue === null) return null
  const v = metric.rawValue // 股関節の幅に対する %（+ は被写体の左）
  const sigma = metric.uncertainty ?? 0
  const footGap = 60 // 図の上での両足の中心の間隔（≒ 股関節の幅）
  const cx0 = 100
  const cy = 60
  const dx = Math.max(-80, Math.min(80, (v / 100) * footGap))
  const band = Math.min(80, ((2 * sigma) / 100) * footGap)
  const noticeable = metric.status === 'noticeable'
  const cm = offsetCm(metric, heightCm)
  const toward = v >= 0 ? '左' : '右'
  return (
    <div className="mt-4 grid grid-cols-[140px_1fr] items-center gap-3 rounded-[var(--radius-panel)] bg-surface p-3 shadow-lift">
      <svg viewBox="16 0 168 128" role="img" aria-label={`足の図。体の中心の位置を点で示しています。${noticeable ? `${toward}足側へ寄っています` : '両足の中央からのずれは、ばらつきの範囲内です'}`} className="w-full">
        <rect x={cx0 - band} y={10} width={band * 2} height={100} rx={4} fill="var(--color-measure-soft)" />
        <ellipse cx={cx0 - footGap / 2} cy={cy} rx={17} ry={40} fill="var(--color-sunken)" stroke="var(--color-line)" strokeWidth={2} />
        <ellipse cx={cx0 + footGap / 2} cy={cy} rx={17} ry={40} fill="var(--color-sunken)" stroke="var(--color-line)" strokeWidth={2} />
        <line x1={cx0} x2={cx0} y1={8} y2={112} stroke="var(--color-measure)" strokeWidth={1.25} strokeDasharray="3 3" />
        <line x1={20} x2={180} y1={cy} y2={cy} stroke="var(--color-measure)" strokeWidth={1.25} strokeDasharray="3 3" />
        <circle cx={cx0} cy={cy} r={6} fill="none" stroke="var(--color-measure)" strokeWidth={1.5} />
        <circle cx={cx0 + dx} cy={cy} r={7} fill={noticeable ? 'var(--color-measure)' : 'var(--color-ink-3)'} stroke="#FFFFFF" strokeWidth={2} />
        <text x={cx0 - footGap / 2} y={124} textAnchor="middle" fontSize="12" fill="var(--color-ink-3)">
          右足
        </text>
        <text x={cx0 + footGap / 2} y={124} textAnchor="middle" fontSize="12" fill="var(--color-ink-3)">
          左足
        </text>
      </svg>
      <div>
        <p className="text-sm font-medium text-ink-3">体の中心の位置（参考推定）</p>
        <p className="mt-0.5 text-[15px]">
          {noticeable
            ? `両足の中央より${toward}足側へ寄っています（股関節の幅の約${fmtAbs(v, '%')}${cm ? `、約 ${fmtNum(Math.abs(cm.cm))}cm` : ''}）。`
            : '両足の中央からのずれは、測定のばらつきの範囲内です。'}
        </p>
        <p className="mt-1 text-sm text-ink-3">体重のかかり方を測ったものではありません。肩と股関節の位置の偏りから、方向を推測した参考値です。</p>
      </div>
    </div>
  )
}
