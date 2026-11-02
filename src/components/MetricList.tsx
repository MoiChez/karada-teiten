import type { ComputedMetric } from '../domain/types'
import { METRIC_DOCS } from '../domain/metricDocs'
import { confidenceLabel, fmtValue, metricStatusLabel } from '../domain/format'
import { landmarkName } from '../domain/landmarks'
import { Badge, Details } from './ui'

export function MetricList({ metrics, rawMetrics }: { metrics: ComputedMetric[]; rawMetrics?: ComputedMetric[] }) {
  const raw = new Map((rawMetrics ?? []).map((m) => [m.key, m]))
  return (
    <ul className="divide-y divide-line border-y border-line">
      {metrics.map((m) => (
        <MetricRow key={m.key} m={m} before={changedBefore(m, raw.get(m.key))} />
      ))}
    </ul>
  )
}

/** 補正で値が変わった指標だけ、補正前の値を返す */
function changedBefore(m: ComputedMetric, before: ComputedMetric | undefined): ComputedMetric | undefined {
  if (!before || !m.correctedLandmarks.length) return undefined
  if (m.rawValue === null || before.rawValue === null) return m.rawValue === before.rawValue ? undefined : before
  return Math.abs(m.rawValue - before.rawValue) >= 0.005 ? before : undefined
}

function statusTone(m: ComputedMetric) {
  return m.status === 'noticeable' ? 'attention' : m.status === 'within_noise' ? 'neutral' : m.status === 'descriptive' ? 'measure' : 'neutral'
}

export function MetricRow({ m, before }: { m: ComputedMetric; before?: ComputedMetric }) {
  const doc = METRIC_DOCS[m.key]
  const assessed = m.rawValue !== null
  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{m.label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone(m)}>{metricStatusLabel(m)}</Badge>
            {assessed && <Badge>信頼度 {confidenceLabel(m.confidence)}</Badge>}
            {before && <Badge tone="level">補正後</Badge>}
          </div>
        </div>
        <div className="text-right">
          <p className="text-[22px] leading-tight font-medium num">{assessed ? fmtValue(m.rawValue, m.unit) : '—'}</p>
          {assessed && m.uncertainty !== null && <p className="text-xs text-ink-3 num">ばらつき目安 ±{fmtValue(m.uncertainty, m.unit)}</p>}
        </div>
      </div>
      {assessed && <p className="mt-1 text-[15px] text-ink-2">{m.direction}</p>}
      {!assessed && m.qualityNote && <p className="mt-1 text-[15px] text-ink-2">{m.qualityNote}</p>}
      {before && (
        <p className="mt-1 text-sm text-ink-3 num">補正前の値: {before.rawValue === null ? '評価不可' : fmtValue(before.rawValue, before.unit)}</p>
      )}
      <Details summary="計算方法と限界">
        <p>{doc.formula}</p>
        {m.normalizedValue !== null && m.normalizedUnit && m.unit !== '%' && (
          <p className="mt-1 num">
            補足値: {fmtValue(m.normalizedValue, '%')}（{m.normalizedUnit.replace('% ', '')}）
          </p>
        )}
        {m.components && m.components.length > 0 && (
          <ul className="mt-1 list-disc pl-4 num">
            {m.components.map((c) => (
              <li key={c.key}>
                {c.key === 'side_head_forward' ? '頭部前方位' : c.key === 'side_trunk_lean' ? '体幹の前後傾' : c.key === 'side_arm_forward' ? '腕の前方位置' : c.key === 'side_hip_forward' ? '骨盤帯の前後位置' : '膝の伸展'}
                : {c.value} ÷ {Math.abs(c.scale)}
                {c.scale < 0 ? '（向きを反転）' : ''} = {(c.value / c.scale).toFixed(2)}
              </li>
            ))}
          </ul>
        )}
        {m.usedLandmarks.length > 0 && <p className="mt-1">使った点: {m.usedLandmarks.map(landmarkName).join('・')}</p>}
        <p className="mt-1">限界: {doc.limits}</p>
        {assessed && m.qualityNote && <p className="mt-1">注記: {m.qualityNote}</p>}
      </Details>
    </li>
  )
}
