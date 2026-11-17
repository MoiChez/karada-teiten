import type { ComputedMetric, MetricKey } from '../domain/types'
import { METRIC_DOCS } from '../domain/metricDocs'
import { aboutCm, confidenceLabel, fmtCm, fmtValue, judgeWidth, metricStatusLabel, offsetCm } from '../domain/format'
import { landmarkName } from '../domain/landmarks'
import { Badge, Details } from './ui'

const COMPONENT_NAMES: Partial<Record<MetricKey, string>> = {
  side_head_forward: '頭の前後の位置',
  side_trunk_lean: '上半身の前後の傾き',
  side_arm_forward: '手の前後の位置',
  side_hip_forward: '腰の前後の位置',
  side_knee_extension: '膝の後ろへの伸び',
}

export function MetricList({ metrics, rawMetrics, heightCm }: { metrics: ComputedMetric[]; rawMetrics?: ComputedMetric[]; heightCm?: number }) {
  const raw = new Map((rawMetrics ?? []).map((m) => [m.key, m]))
  return (
    <ul className="divide-y divide-line border-y border-line">
      {metrics.map((m) => (
        <MetricRow key={m.key} m={m} before={changedBefore(m, raw.get(m.key))} heightCm={heightCm} />
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

/** 向きの説明。判定の幅の内なら、そのことを添える（雑音の向きを言い切らない） */
function directionText(m: ComputedMetric): string {
  if (m.rawValue === null) return ''
  if (m.status !== 'within_noise') return m.direction
  const tiny = Math.abs(m.rawValue) < (m.unit === 'score' ? 0.005 : 0.05)
  return tiny ? 'ほぼ 0（向きは決められません）' : `${m.direction}（判定の幅の内）`
}

export function MetricRow({ m, before, heightCm }: { m: ComputedMetric; before?: ComputedMetric; heightCm?: number }) {
  const doc = METRIC_DOCS[m.key]
  const assessed = m.rawValue !== null
  const cm = offsetCm(m, heightCm)
  const judged = m.status === 'noticeable' || m.status === 'within_noise'
  const width = judged ? judgeWidth(m.uncertainty) : null
  const conf = confidenceLabel(m.confidence)
  // 札は例外のときだけ（差あり・評価できない・補正後・点の写りが中か低）
  const badges = [
    m.status === 'noticeable' && <Badge key="s" tone="measure">{metricStatusLabel(m)}</Badge>,
    (m.status === 'unassessable' || m.status === 'unsupported') && <Badge key="s">{metricStatusLabel(m)}</Badge>,
    assessed && conf !== '高' && <Badge key="c">点の写り {conf}</Badge>,
    before && <Badge key="b" tone="level">補正後</Badge>,
  ].filter(Boolean)
  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{m.label}</p>
          {badges.length > 0 && <div className="mt-1 flex flex-wrap items-center gap-1.5">{badges}</div>}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[22px] leading-tight font-medium whitespace-nowrap num">{assessed ? fmtValue(m.rawValue, m.unit) : '—'}</p>
          {assessed && width !== null && <p className="text-sm whitespace-nowrap text-ink-3 num">判定の幅 ±{fmtValue(width, m.unit)}</p>}
        </div>
      </div>
      {assessed && <p className="mt-1 text-[15px] text-ink-2">{directionText(m)}</p>}
      {cm && (
        <p className="mt-0.5 text-sm text-ink-2 num">
          {cm.label}: {aboutCm(Math.abs(cm.cm), cm.sigmaCm)}
          {judged && cm.sigmaCm !== null ? `（判定の幅 ±${fmtCm(2 * cm.sigmaCm, cm.sigmaCm)}）` : ''}
        </p>
      )}
      {assessed && m.burstValues && m.burstValues.length > 1 && (
        <p className="mt-0.5 text-sm text-ink-3 num">
          {m.burstValues.length} 枚それぞれの値: {m.burstValues.map((v) => (v === null ? '—' : fmtValue(v, m.unit))).join(' / ')}
        </p>
      )}
      {!assessed && m.qualityNote && <p className="mt-1 text-[15px] text-ink-2">{m.qualityNote}</p>}
      {before && (
        <p className="mt-1 text-sm text-ink-3 num">補正前の値: {before.rawValue === null ? '評価不可' : fmtValue(before.rawValue, before.unit)}</p>
      )}
      <Details summary="計算のしかたと限界">
        <p>{doc.formula}</p>
        {m.normalizedValue !== null && m.normalizedUnit && m.unit !== '%' && (
          <p className="mt-1 num">
            補足値: {fmtValue(m.normalizedValue, '%')}（{m.normalizedUnit.replace(/^%\s*/, '').replace(/[()（）]/g, '')}）
          </p>
        )}
        {m.components && m.components.length > 0 && (
          <ul className="mt-1 list-disc pl-4 num">
            {m.components.map((c) => (
              <li key={c.key}>
                {COMPONENT_NAMES[c.key] ?? c.key}: {c.value} ÷ {Math.abs(c.scale)}
                {c.scale < 0 ? '（向きを反転）' : ''} = {(c.value / c.scale).toFixed(2)}
              </li>
            ))}
          </ul>
        )}
        {m.usedLandmarks.length > 0 && <p className="mt-1">使った点: {m.usedLandmarks.map(landmarkName).join('・')}</p>}
        {assessed && m.uncertainty !== null && (
          <p className="mt-1 num">
            ばらつきの見込み（1σ）: ±{fmtValue(m.uncertainty, m.unit)}。{judged ? `判定の幅はこの 2 倍です。` : '1 回の測定では判定せず、比べるときに使います。'}
          </p>
        )}
        {assessed && <p className="mt-1">点の写り: {conf}（点がはっきり写っていたか。値の確かさは判定の幅で見てください）</p>}
        <p className="mt-1">限界: {doc.limits}</p>
        {assessed && m.qualityNote && <p className="mt-1">注記: {m.qualityNote}</p>}
      </Details>
    </li>
  )
}
